// PLACE AT: android/app/src/main/kotlin/<your/package/path>/H264TextureDecoder.kt
// Same package line requirement as MainActivity.kt — they must match.

package com.example.untitled

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Surface
import io.flutter.view.TextureRegistry
import java.util.concurrent.atomic.AtomicInteger

/// Decodes TouchBridge H.264 payloads and renders them into a Flutter texture
/// (shown in Dart with a `Texture(textureId: ...)` widget).
///
/// Input payload (identical on every platform):
///     "TBH4" + 1 flag byte (bit 0 = keyframe) + Annex-B NAL units
/// Keyframes carry SPS+PPS in-band. The decoder is (re)configured from the SPS
/// of a keyframe whenever it changes, so the host may switch resolution or
/// quality at any time.
///
/// Delta frames are meaningless without their keyframe, so until one arrives
/// they are ignored, and if decoding falls behind (or a buffer can't be
/// obtained) delta frames are dropped until the next keyframe rather than
/// showing a corrupted picture or letting latency build up.
class H264TextureDecoder(
    private val entry: TextureRegistry.SurfaceTextureEntry,
    private val onSize: (width: Int, height: Int) -> Unit,
) {
    companion object {
        private const val TAG = "TouchBridgeH264Dec"
        private const val MAX_PENDING = 8
        private val START_CODE = byteArrayOf(0, 0, 0, 1)
    }

    private val surface = Surface(entry.surfaceTexture())
    private val thread = HandlerThread("tb-h264-dec").also { it.start() }
    private val handler = Handler(thread.looper)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val pending = AtomicInteger(0)

    @Volatile private var needKey = true
    @Volatile private var released = false

    // Only touched on the decoder thread:
    private var codec: MediaCodec? = null
    private var configuredSps: ByteArray? = null
    private var ptsUs = 0L

    val textureId: Long get() = entry.id()

    /// Called from the platform thread for every frame, in order.
    fun submit(payload: ByteArray) {
        if (released || !isPayload(payload)) return
        val isKey = (payload[4].toInt() and 1) == 1
        if (!isKey && (needKey || pending.get() > MAX_PENDING)) {
            needKey = true // behind or waiting: skip deltas until the next keyframe
            return
        }
        pending.incrementAndGet()
        handler.post {
            try {
                if (!released) decode(payload, isKey)
            } catch (e: Exception) {
                Log.w(TAG, "decode failed — waiting for the next keyframe", e)
                needKey = true
                closeCodec()
            } finally {
                pending.decrementAndGet()
            }
        }
    }

    private fun isPayload(p: ByteArray): Boolean =
        p.size > 5 && p[0] == 0x54.toByte() && p[1] == 0x42.toByte() &&
            p[2] == 0x48.toByte() && p[3] == 0x34.toByte()

    private fun decode(payload: ByteArray, isKey: Boolean) {
        if (isKey) {
            val nals = splitNals(payload, 5)
            val sps = nals.firstOrNull { nalType(it) == 7 }
            val pps = nals.firstOrNull { nalType(it) == 8 }
            if (sps == null || pps == null) return // can't start without parameter sets
            if (codec == null || configuredSps?.contentEquals(sps) != true) {
                val size = parseSpsSize(sps) ?: return
                configure(sps, pps, size.first, size.second)
            }
            needKey = false
        } else if (codec == null || needKey) {
            return
        }

        val c = codec ?: return
        val idx = c.dequeueInputBuffer(if (isKey) 30_000 else 5_000)
        if (idx < 0) {
            needKey = true // decoder is saturated; resync at the next keyframe
            return
        }
        val buf = c.getInputBuffer(idx) ?: run { needKey = true; return }
        buf.clear()
        val len = payload.size - 5
        if (len > buf.capacity()) { c.queueInputBuffer(idx, 0, 0, ptsUs, 0); needKey = true; return }
        buf.put(payload, 5, len)
        ptsUs += 33_333
        c.queueInputBuffer(idx, 0, len, ptsUs, if (isKey) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        drain(c)
    }

    private fun configure(sps: ByteArray, pps: ByteArray, width: Int, height: Int) {
        closeCodec()
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setByteBuffer("csd-0", java.nio.ByteBuffer.wrap(START_CODE + sps))
            setByteBuffer("csd-1", java.nio.ByteBuffer.wrap(START_CODE + pps))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
        }
        val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            c.configure(format, surface, null, 0)
            c.start()
        } catch (e: Exception) {
            try { c.release() } catch (_: Exception) {}
            throw e
        }
        codec = c
        configuredSps = sps
        mainHandler.post { if (!released) onSize(width, height) }
    }

    /// Renders every frame that is ready, but only the newest one is actually
    /// shown (older ones are released without rendering) — keeps latency flat.
    private fun drain(c: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        var last = -1
        while (true) {
            val out = c.dequeueOutputBuffer(info, 0)
            when {
                out >= 0 -> {
                    if (last >= 0) c.releaseOutputBuffer(last, false)
                    last = out
                }
                out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> reportOutputSize(c.outputFormat)
                else -> break // INFO_TRY_AGAIN_LATER (and the deprecated buffers-changed code)
            }
        }
        if (last >= 0) c.releaseOutputBuffer(last, true)
    }

    private fun reportOutputSize(f: MediaFormat) {
        try {
            val hasCrop = f.containsKey("crop-left") && f.containsKey("crop-right") &&
                f.containsKey("crop-top") && f.containsKey("crop-bottom")
            val w = if (hasCrop) f.getInteger("crop-right") - f.getInteger("crop-left") + 1
            else f.getInteger(MediaFormat.KEY_WIDTH)
            val h = if (hasCrop) f.getInteger("crop-bottom") - f.getInteger("crop-top") + 1
            else f.getInteger(MediaFormat.KEY_HEIGHT)
            mainHandler.post { if (!released) onSize(w, h) }
        } catch (_: Exception) {
            // keep the size the SPS gave us
        }
    }

    private fun closeCodec() {
        val c = codec
        codec = null
        configuredSps = null
        if (c != null) {
            try { c.stop() } catch (_: Exception) {}
            try { c.release() } catch (_: Exception) {}
        }
    }

    fun release() {
        if (released) return
        released = true
        handler.post {
            closeCodec()
            surface.release()
            entry.release()
            thread.quitSafely()
        }
    }

    // ── Annex-B helpers ───────────────────────────────────────────────────
    /// Splits Annex-B data into NAL units (without start codes, with the NAL
    /// header byte), starting the scan at [from].
    private fun splitNals(d: ByteArray, from: Int): List<ByteArray> {
        val starts = ArrayList<Int>() // index of the first byte after each start code
        val codeStarts = ArrayList<Int>()
        var i = from
        while (i + 2 < d.size) {
            if (d[i] == 0.toByte() && d[i + 1] == 0.toByte() && d[i + 2] == 1.toByte()) {
                codeStarts.add(i)
                starts.add(i + 3)
                i += 3
            } else {
                i++
            }
        }
        val nals = ArrayList<ByteArray>()
        for (n in starts.indices) {
            var end = if (n + 1 < starts.size) codeStarts[n + 1] else d.size
            // a 4-byte start code (00 00 00 01) leaves one extra zero on the previous NAL
            while (end > starts[n] && d[end - 1] == 0.toByte() && n + 1 < starts.size) end--
            if (end > starts[n]) nals.add(d.copyOfRange(starts[n], end))
        }
        return nals
    }

    private fun nalType(nal: ByteArray): Int = nal[0].toInt() and 0x1f

    /// Picture size (after cropping) from an SPS NAL unit (header byte included).
    private fun parseSpsSize(sps: ByteArray): Pair<Int, Int>? {
        return try {
            // Remove emulation-prevention bytes (00 00 03 -> 00 00).
            val rbsp = java.io.ByteArrayOutputStream(sps.size)
            var zeros = 0
            for (k in 1 until sps.size) { // skip the NAL header byte
                val b = sps[k].toInt() and 0xff
                if (zeros >= 2 && b == 3) { zeros = 0; continue }
                rbsp.write(b)
                zeros = if (b == 0) zeros + 1 else 0
            }
            val r = BitReader(rbsp.toByteArray())
            val profile = r.bits(8)
            r.bits(8) // constraint flags + reserved
            r.bits(8) // level_idc
            r.ue()    // seq_parameter_set_id
            var chroma = 1
            if (profile in intArrayOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)) {
                chroma = r.ue()
                if (chroma == 3) r.bits(1) // separate_colour_plane_flag
                r.ue() // bit_depth_luma_minus8
                r.ue() // bit_depth_chroma_minus8
                r.bits(1) // qpprime_y_zero_transform_bypass_flag
                if (r.bits(1) == 1) { // seq_scaling_matrix_present_flag
                    val lists = if (chroma != 3) 8 else 12
                    for (n in 0 until lists) {
                        if (r.bits(1) == 1) {
                            var last = 8
                            var next = 8
                            repeat(if (n < 6) 16 else 64) {
                                if (next != 0) {
                                    next = (last + r.se() + 256) % 256
                                }
                                last = if (next == 0) last else next
                            }
                        }
                    }
                }
            }
            r.ue() // log2_max_frame_num_minus4
            when (r.ue()) { // pic_order_cnt_type
                0 -> r.ue()
                1 -> {
                    r.bits(1)
                    r.se()
                    r.se()
                    repeat(r.ue()) { r.se() }
                }
            }
            r.ue()    // max_num_ref_frames
            r.bits(1) // gaps_in_frame_num_value_allowed_flag
            val wMbs = r.ue() + 1
            val hMapUnits = r.ue() + 1
            val frameMbsOnly = r.bits(1)
            if (frameMbsOnly == 0) r.bits(1) // mb_adaptive_frame_field_flag
            r.bits(1) // direct_8x8_inference_flag
            var cropL = 0; var cropR = 0; var cropT = 0; var cropB = 0
            if (r.bits(1) == 1) {
                cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue()
            }
            val subW = if (chroma == 1 || chroma == 2) 2 else 1
            val subH = if (chroma == 1) 2 else 1
            val cropUnitX = if (chroma == 0) 1 else subW
            val cropUnitY = (if (chroma == 0) 1 else subH) * (2 - frameMbsOnly)
            val width = wMbs * 16 - cropUnitX * (cropL + cropR)
            val height = (2 - frameMbsOnly) * hMapUnits * 16 - cropUnitY * (cropT + cropB)
            if (width > 0 && height > 0) Pair(width, height) else null
        } catch (e: Exception) {
            null
        }
    }

    private class BitReader(private val d: ByteArray) {
        private var pos = 0 // bit position
        fun bits(n: Int): Int {
            var v = 0
            repeat(n) {
                val byte = pos ushr 3
                if (byte >= d.size) throw IndexOutOfBoundsException("SPS truncated")
                v = (v shl 1) or ((d[byte].toInt() ushr (7 - (pos and 7))) and 1)
                pos++
            }
            return v
        }
        fun ue(): Int {
            var zeros = 0
            while (bits(1) == 0) {
                if (++zeros > 31) throw IllegalStateException("bad exp-golomb")
            }
            return if (zeros == 0) 0 else (1 shl zeros) - 1 + bits(zeros)
        }
        fun se(): Int {
            val k = ue()
            return if (k and 1 == 1) (k + 1) / 2 else -(k / 2)
        }
    }
}
