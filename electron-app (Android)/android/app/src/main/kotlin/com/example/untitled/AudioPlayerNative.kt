// PLACE AT: android/app/src/main/kotlin/<your/package/path>/AudioPlayerNative.kt

package com.example.untitled

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.Executors

/// Viewer-side playback of the host's shared audio.
///
/// Input is a TouchBridge audio payload:
///     "TBA1" + channels u8 + sample-rate u32 BE + PCM signed 16-bit LE
/// Chunks are written to a streaming AudioTrack on a private thread (never the
/// UI thread). Writes are non-blocking: if the track's buffer is full the
/// excess is dropped, so delay can't build up.
class AudioPlayerNative {
    private companion object {
        const val TAG = "TouchBridgeAudio"
        const val PREBUFFER_MS = 200   // jitter buffer before (re)starting playback
        const val BUFFER_MS = 800      // track capacity
        const val MAX_QUEUED_MS = 600  // never let more than this build up (keeps delay bounded)
    }

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "tb-audio-play") }
    private var track: AudioTrack? = null
    private var rate = 0
    private var channels = 0
    private var started = false
    private var writtenFrames = 0L
    @Volatile private var muted = false
    @Volatile private var released = false

    fun setMuted(m: Boolean) {
        muted = m
        executor.execute { track?.setVolume(if (m) 0f else 1f) }
    }

    fun play(payload: ByteArray) {
        if (released || muted) return
        executor.execute { playOnThread(payload) }
    }

    private fun playOnThread(p: ByteArray) {
        if (released || p.size <= 9) return
        if (p[0] != 0x54.toByte() || p[1] != 0x42.toByte() || p[2] != 0x41.toByte() || p[3] != 0x31.toByte()) return
        val ch = (p[4].toInt() and 0xFF).coerceIn(1, 2)
        val r = ((p[5].toInt() and 0xFF) shl 24) or ((p[6].toInt() and 0xFF) shl 16) or
            ((p[7].toInt() and 0xFF) shl 8) or (p[8].toInt() and 0xFF)
        if (r < 8000 || r > 96000) return
        if (track == null || r != rate || ch != channels) {
            if (!createTrack(r, ch)) return
        }
        val t = track ?: return
        val len = (p.size - 9) / (2 * ch) * (2 * ch)
        if (len <= 0) return
        val frames = len / (2 * ch)

        if (started) {
            val queued = writtenFrames - (t.playbackHeadPosition.toLong() and 0xFFFFFFFFL)
            if (queued <= 0) {
                // Ran dry (network hiccup): stop and rebuffer instead of stuttering
                // through a trickle of tiny chunks.
                try { t.pause(); t.flush() } catch (_: Exception) {}
                started = false
                writtenFrames = 0
            } else if (queued > r * MAX_QUEUED_MS / 1000) {
                return // too far ahead (burst after a stall): drop to keep delay bounded
            }
        }

        val n = t.write(p, 9, len, AudioTrack.WRITE_NON_BLOCKING)
        if (n > 0) writtenFrames += n / (2 * ch)
        if (!started && writtenFrames >= r * PREBUFFER_MS / 1000) {
            try { t.play(); started = true } catch (e: Exception) { Log.w(TAG, "play() failed", e) }
        }
    }

    private fun createTrack(r: Int, ch: Int): Boolean {
        releaseTrack()
        return try {
            val mask = if (ch == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
            val min = AudioTrack.getMinBufferSize(r, mask, AudioFormat.ENCODING_PCM_16BIT)
            val size = maxOf(min, r * 2 * ch * BUFFER_MS / 1000)
            val t = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(r)
                        .setChannelMask(mask)
                        .build()
                )
                .setBufferSizeInBytes(size)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            t.setVolume(if (muted) 0f else 1f)
            track = t
            rate = r
            channels = ch
            started = false
            writtenFrames = 0
            true
        } catch (e: Exception) {
            Log.w(TAG, "Could not create AudioTrack", e)
            false
        }
    }

    private fun releaseTrack() {
        try { track?.stop() } catch (_: Exception) {}
        try { track?.release() } catch (_: Exception) {}
        track = null
    }

    fun release() {
        released = true
        executor.execute { releaseTrack() }
        executor.shutdown()
    }
}
