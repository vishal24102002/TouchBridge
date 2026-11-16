// PLACE AT: android/app/src/main/kotlin/<your/package/path>/ScreenCaptureService.kt
// Same package line requirement as MainActivity.kt — they must match.

package com.example.untitled

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.Image
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Surface
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/// Foreground service that owns the MediaProjection + VirtualDisplay.
///
/// Two output modes, switchable live without asking for screen-capture
/// permission again (the VirtualDisplay is re-pointed at the other sink):
///   * H.264 (default): the VirtualDisplay renders straight into a MediaCodec
///     encoder's input Surface (hardware encoder, no per-frame bitmap work).
///     Every encoded access unit is pushed to Dart through [frameListener] as
///     "TBH4" + flag byte (bit0 = keyframe) + Annex-B NAL units — the same
///     payload the desktop app produces, so any viewer can decode it. Keyframes
///     always carry SPS+PPS in-band.
///   * JPEG: the original ImageReader path keeping one "latest frame" buffer,
///     polled from Dart via getLatestFrame() on the MethodChannel (see
///     MainActivity.kt).
/// A
/// foreground service (not a background one) is required — Android kills
/// MediaProjection capture the moment the app backgrounds otherwise,
/// which would happen constantly during a real remote-desktop session.
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "TouchBridgeCapture"
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        const val EXTRA_CODEC = "codec"
        private const val NOTIF_CHANNEL_ID = "touchbridge_capture"
        private const val NOTIF_ID = 1001

        // JPEG mode: frames are pushed to viewers over one persistent stream,
        // so these just trade picture size/quality against bandwidth. The
        // VirtualDisplay itself renders at this reduced size (the system scales
        // the screen for us), which keeps the per-frame work tiny.
        private const val MAX_DIMENSION = 1280
        private const val JPEG_QUALITY = 65
        private const val JPEG_MIN_INTERVAL_MS = 66L // ~15 fps cap

        const val CODEC_H264 = "h264"
        const val CODEC_JPEG = "jpeg"

        // H.264 mode: inter-frame compression makes frames tiny compared with
        // per-frame JPEG, so it can afford a larger picture (text stays
        // legible on a PC-sized viewer) and a real frame rate.
        private const val H264_MAX_DIMENSION = 1600
        private const val H264_BITRATE = 6_000_000
        private const val H264_FPS = 30
        private const val H264_KEYFRAME_INTERVAL_SECS = 2
        private val H264_MAGIC = byteArrayOf(0x54, 0x42, 0x48, 0x34) // "TBH4"

        // Native pixels per transmitted-frame pixel (>1 whenever the frame
        // sent to viewers is downscaled below MAX_DIMENSION). The client
        // computes mouse_move deltas from the actual image it received —
        // see ClientPage.js's sendMouseMove — so those deltas arrive in
        // TRANSMITTED-frame units, not the phone's real pixel grid.
        // TouchBridgeAccessibilityService reads this to scale incoming
        // deltas back up before moving the virtual cursor. Updated on
        // every captured frame in imageToJpeg() below.
        @Volatile
        var captureScaleFactor: Float = 1f
            private set

        // Handed off from MainActivity's onActivityResult after the user
        // approves the "Start recording or casting?" system dialog.
        private var permissionResultCode: Int = Activity.RESULT_CANCELED
        private var permissionData: Intent? = null

        @Volatile private var latestJpeg: ByteArray? = null
        @Volatile private var latestJpegSeq = 0L
        private var deliveredJpegSeq = 0L

        // What the user asked for, and what is really running (differs when the
        // device has no usable H.264 encoder and we fell back to JPEG).
        @Volatile var requestedCodec: String = CODEC_H264
        @Volatile var activeCodec: String = CODEC_JPEG
            private set

        // Receives every H.264 payload, on the encoder's callback thread.
        @Volatile var frameListener: ((ByteArray) -> Unit)? = null

        // Audio sharing ("off" | "mic" | "system"). Chunks are TouchBridge audio
        // payloads: "TBA1" + channels u8 + sample-rate u32 BE + PCM16LE (mono).
        const val AUDIO_OFF = "off"
        const val AUDIO_MIC = "mic"
        const val AUDIO_SYSTEM = "system"
        const val EXTRA_AUDIO = "audio"
        private const val AUDIO_RATE = 24000
        private const val AUDIO_CHUNK_BYTES = AUDIO_RATE * 2 * 40 / 1000 // 40 ms
        @Volatile var audioSource: String = AUDIO_OFF
        @Volatile var audioListener: ((ByteArray) -> Unit)? = null

        fun applyAudioSource(source: String) {
            audioSource = source
            val svc = instance ?: return
            svc.mainHandler.post { svc.configureAudio() }
        }

        @Volatile private var instance: ScreenCaptureService? = null

        fun applyCodec(codec: String) {
            requestedCodec = codec
            val svc = instance ?: return
            svc.mainHandler.post { svc.configureSink(codec) }
        }

        /// Asks the encoder for an immediate keyframe (a viewer fell behind and
        /// needs to resynchronise).
        fun requestKeyframe() {
            instance?.requestSyncFrame()
        }

        /// The newest JPEG, or null if nothing new has been produced since the
        /// last call (always null in H.264 mode).
        fun takeNewFrame(): ByteArray? {
            val seq = latestJpegSeq
            if (seq == deliveredJpegSeq) return null
            deliveredJpegSeq = seq
            return latestJpeg
        }

        fun storePermission(resultCode: Int, data: Intent) {
            permissionResultCode = resultCode
            permissionData = data
        }

        fun hasPermission(): Boolean =
            permissionResultCode == Activity.RESULT_OK && permissionData != null

        fun latestFrame(): ByteArray? = latestJpeg
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private var nativeWidth = 0
    private var nativeHeight = 0
    private var density = 0

    // JPEG sink: all bitmap/encode work runs on its own thread, never on the
    // app's UI thread (that used to stall the whole app while sharing).
    private var jpegThread: HandlerThread? = null
    private var jpegHandler: Handler? = null
    private val jpegScheduled = AtomicBoolean(false)
    @Volatile private var lastJpegAt = 0L

    // Re-point the capture when the screen size changes (rotation, folding...).
    // Without this the VirtualDisplay keeps its old size and the system squashes
    // the rotated screen into it.
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            if (displayId != Display.DEFAULT_DISPLAY) return
            mainHandler.removeCallbacks(displayChangedRunnable)
            mainHandler.postDelayed(displayChangedRunnable, 400) // let the rotation settle
        }
    }
    private val displayChangedRunnable = Runnable {
        if (mediaProjection == null) return@Runnable
        val m = DisplayMetrics()
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(m)
        if (m.widthPixels != nativeWidth || m.heightPixels != nativeHeight) {
            nativeWidth = m.widthPixels
            nativeHeight = m.heightPixels
            density = m.densityDpi
            configureSink(requestedCodec)
        }
    }

    private var encoder: MediaCodec? = null
    private var encoderSurface: Surface? = null
    private var encoderThread: HandlerThread? = null
    @Volatile private var h264Config: ByteArray? = null // SPS+PPS from the encoder, re-sent in front of every keyframe

    // Android 14+ throws if createVirtualDisplay() is called on a
    // MediaProjection with no registered callback — and on any recent
    // Android version, the system can revoke a projection at any time
    // (user backgrounds the app, stops it from the notification/quick
    // settings, revokes via Settings, etc). Without this callback we'd
    // keep holding a dead VirtualDisplay/ImageReader, and — worse — the
    // service would eventually get killed by the OS's background
    // execution limits since it's no longer doing legitimate foreground
    // work, taking the whole app process down with it (that's the "app
    // restarts to the splash screen after backgrounding" symptom).
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.w(TAG, "MediaProjection stopped by the system — tearing down capture cleanly")
            mainHandler.post { stopCapture() }
            stopSelf()
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
            }
            else -> {
                intent?.getStringExtra(EXTRA_CODEC)?.let { requestedCodec = it }
                intent?.getStringExtra(EXTRA_AUDIO)?.let { audioSource = it }
                startCapture()
            }
        }
        return START_NOT_STICKY
    }

    private fun startCapture() {
        if (!hasPermission()) {
            stopSelf()
            return
        }

        try {
            startForegroundCompat()

            val projectionManager =
                getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            // getMediaProjection()'s return type resolves as nullable on
            // some SDK/AGP combinations (its Java signature isn't
            // consistently annotated across platform versions). Force it
            // non-null explicitly here so every call below is unambiguous
            // — Kotlin otherwise refuses direct (non-?./non-!!.) calls on
            // it, which is exactly what was failing to compile.
            val projection: MediaProjection =
                projectionManager.getMediaProjection(permissionResultCode, permissionData!!)
                    ?: throw IllegalStateException("getMediaProjection() returned null")
            mediaProjection = projection

            // MUST happen before createVirtualDisplay() — required since
            // Android 14 (API 34), harmless on older versions.
            projection.registerCallback(projectionCallback, mainHandler)

            val metrics = DisplayMetrics()
            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            nativeWidth = metrics.widthPixels
            nativeHeight = metrics.heightPixels
            density = metrics.densityDpi

            configureSink(requestedCodec)
            configureAudio()
            (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager)
                .registerDisplayListener(displayListener, mainHandler)
        } catch (e: Exception) {
            // Anything here (permission expired, projection already
            // consumed, foreground-service type rejected, etc.) should
            // stop the service cleanly instead of crashing the whole
            // process — a process crash is what forces the next app open
            // back through a cold start / splash screen.
            Log.e(TAG, "Failed to start capture", e)
            stopCapture()
            stopSelf()
        }
    }

    // ── Output sinks ──────────────────────────────────────────────────────
    /// Points the VirtualDisplay at the requested sink (creating it on first
    /// use). Always runs on the main thread. H.264 falls back to JPEG if the
    /// encoder can't be started on this device.
    private fun configureSink(codec: String) {
        val projection = mediaProjection ?: return
        // Detach the display before tearing down the old sink's Surface.
        try { virtualDisplay?.surface = null } catch (_: Exception) {}
        stopSink()
        var started = false
        if (codec == CODEC_H264) {
            started = try {
                startH264Sink(projection)
            } catch (e: Exception) {
                Log.e(TAG, "H.264 encoder unavailable — falling back to JPEG", e)
                stopSink()
                false
            }
        }
        if (!started) startJpegSink(projection)
        Log.i(TAG, "Capture sink: $activeCodec (requested $codec)")
    }

    private fun attachSurface(
        projection: MediaProjection, surface: Surface, width: Int, height: Int
    ) {
        val vd = virtualDisplay
        if (vd == null) {
            virtualDisplay = projection.createVirtualDisplay(
                "TouchBridgeCapture",
                width, height, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                surface, null, null
            )
        } else {
            // Android 14+ only allows ONE createVirtualDisplay per projection,
            // so switching codec re-targets the existing display instead.
            vd.resize(width, height, density)
            vd.surface = surface
        }
    }

    private fun startJpegSink(projection: MediaProjection) {
        // Capture directly at the size we transmit instead of grabbing the
        // full-resolution screen and shrinking every frame in software.
        val longSide = maxOf(nativeWidth, nativeHeight)
        val scale = if (longSide > MAX_DIMENSION) MAX_DIMENSION.toFloat() / longSide else 1f
        val w = ((nativeWidth * scale).toInt() and 1.inv()).coerceAtLeast(2)
        val h = ((nativeHeight * scale).toInt() and 1.inv()).coerceAtLeast(2)
        captureScaleFactor = longSide.toFloat() / maxOf(w, h)

        val thread = HandlerThread("tb-jpeg").also { it.start() }
        val handler = Handler(thread.looper)
        jpegThread = thread
        jpegHandler = handler

        val reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 3)
        imageReader = reader
        attachSurface(projection, reader.surface, w, h)
        reader.setOnImageAvailableListener({ r -> scheduleJpeg(r, handler) }, handler)
        activeCodec = CODEC_JPEG
    }

    /// Coalesces bursts of new images: at most one encode is pending, it runs
    /// no sooner than JPEG_MIN_INTERVAL_MS after the previous one, and it always
    /// takes the NEWEST image (older ones are discarded), so the picture never
    /// lags behind and a screen that stops changing still ends on its last frame.
    private fun scheduleJpeg(reader: ImageReader, handler: Handler) {
        if (!jpegScheduled.compareAndSet(false, true)) return
        val wait = (JPEG_MIN_INTERVAL_MS - (System.currentTimeMillis() - lastJpegAt)).coerceAtLeast(0)
        handler.postDelayed({
            jpegScheduled.set(false)
            var image: Image? = null
            try {
                image = reader.acquireLatestImage() ?: return@postDelayed
                val bytes = imageToJpeg(image)
                lastJpegAt = System.currentTimeMillis()
                latestJpeg = bytes
                latestJpegSeq++
                frameListener?.invoke(bytes)
            } catch (_: Exception) {
                // reader closed during a codec switch, or one bad frame — the
                // next image supersedes it
            } finally {
                image?.close()
            }
        }, wait)
    }

    /// Hardware encoders want dimensions that are multiples of 16.
    private fun align16(v: Int): Int = ((v + 8) / 16 * 16).coerceAtLeast(16)

    private fun startH264Sink(projection: MediaProjection): Boolean {
        val mime = MediaFormat.MIMETYPE_VIDEO_AVC
        // First with the full low-latency option set, then (if this device's
        // encoder rejects one of the optional keys) with a minimal format.
        for (minimal in booleanArrayOf(false, true)) {
            val enc = try {
                MediaCodec.createEncoderByType(mime)
            } catch (e: Exception) {
                Log.e(TAG, "No H.264 encoder", e)
                return false
            }
            try {
                if (configureEncoder(projection, enc, mime, minimal)) return true
            } catch (e: Exception) {
                Log.w(TAG, "H.264 encoder setup failed (minimal=$minimal)", e)
            }
            try { enc.release() } catch (_: Exception) {}
            encoder = null
            encoderSurface?.release()
            encoderSurface = null
            encoderThread?.quitSafely()
            encoderThread = null
        }
        return false
    }

    private fun configureEncoder(
        projection: MediaProjection, enc: MediaCodec, mime: String, minimal: Boolean
    ): Boolean {
        val codecCaps = enc.codecInfo.getCapabilitiesForType(mime)
        val caps = codecCaps.videoCapabilities

        // Largest picture (up to H264_MAX_DIMENSION on the long side) this
        // encoder accepts, keeping the screen's aspect ratio.
        val nativeLong = maxOf(nativeWidth, nativeHeight)
        var longSide = minOf(nativeLong, H264_MAX_DIMENSION)
        var encW: Int
        var encH: Int
        var attempts = 0
        while (true) {
            val scale = longSide.toFloat() / nativeLong
            encW = align16((nativeWidth * scale).toInt())
            encH = align16((nativeHeight * scale).toInt())
            if (caps.isSizeSupported(encW, encH) || attempts++ >= 6) break
            longSide = (longSide * 0.8f).toInt()
        }
        if (!caps.isSizeSupported(encW, encH)) return false

        val encCaps = codecCaps.encoderCapabilities
        val bitrate = H264_BITRATE.coerceIn(caps.bitrateRange.lower, caps.bitrateRange.upper)
        val format = MediaFormat.createVideoFormat(mime, encW, encH).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, H264_FPS)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, H264_KEYFRAME_INTERVAL_SECS)
            if (!minimal) {
                val mode = when {
                    encCaps.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR) ->
                        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
                    encCaps.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) ->
                        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                    else -> -1
                }
                if (mode >= 0) setInteger(MediaFormat.KEY_BITRATE_MODE, mode)
                // A VirtualDisplay only produces frames when the screen changes;
                // repeat the last one so a static screen keeps a steady trickle
                // and viewers never mistake it for a dead stream.
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 500_000L)
                // SPS/PPS in front of every keyframe (we also add them ourselves
                // in emitH264 if the encoder ignores this).
                setInteger("prepend-sps-pps-to-idr-frames", 1)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setInteger(MediaFormat.KEY_LATENCY, 1)
                    setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
                }
            } else {
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 500_000L)
            }
        }

        val thread = HandlerThread("tb-h264-enc").also { it.start() }
        encoderThread = thread
        enc.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {}

            override fun onOutputBufferAvailable(
                codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo
            ) {
                try {
                    val buf = codec.getOutputBuffer(index)
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val data = ByteArray(info.size)
                        buf.get(data)
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                            h264Config = data // SPS + PPS; goes out in front of the next keyframes
                        } else {
                            emitH264(data, info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0)
                        }
                    }
                } finally {
                    try { codec.releaseOutputBuffer(index, false) } catch (_: Exception) {}
                }
            }

            override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
                Log.e(TAG, "H.264 encoder error — falling back to JPEG", e)
                mainHandler.post { if (encoder === codec) configureSink(CODEC_JPEG) }
            }

            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {}
        }, Handler(thread.looper))

        enc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = enc.createInputSurface()
        encoderSurface = surface
        enc.start()
        encoder = enc
        h264Config = null
        captureScaleFactor = nativeLong.toFloat() / maxOf(encW, encH)
        attachSurface(projection, surface, encW, encH)
        activeCodec = CODEC_H264
        Log.i(TAG, "H.264 encoder: ${encW}x$encH @ ${bitrate / 1000} kbps (minimal=$minimal)")
        return true
    }

    private fun emitH264(data: ByteArray, isKey: Boolean) {
        val listener = frameListener ?: return
        val config = h264Config
        val needsConfig = isKey && config != null && !startsWithSps(data)
        val body = if (needsConfig) config!!.size + data.size else data.size
        val out = ByteArray(5 + body)
        System.arraycopy(H264_MAGIC, 0, out, 0, 4)
        out[4] = if (isKey) 1 else 0
        if (needsConfig) {
            System.arraycopy(config!!, 0, out, 5, config.size)
            System.arraycopy(data, 0, out, 5 + config.size, data.size)
        } else {
            System.arraycopy(data, 0, out, 5, data.size)
        }
        listener(out)
    }

    /// True if the Annex-B data's first NAL unit is an SPS (type 7).
    private fun startsWithSps(d: ByteArray): Boolean {
        val i = when {
            d.size > 4 && d[0] == 0.toByte() && d[1] == 0.toByte() && d[2] == 0.toByte() && d[3] == 1.toByte() -> 4
            d.size > 3 && d[0] == 0.toByte() && d[1] == 0.toByte() && d[2] == 1.toByte() -> 3
            else -> return false
        }
        return (d[i].toInt() and 0x1f) == 7
    }

    private fun requestSyncFrame() {
        try {
            encoder?.setParameters(Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            })
        } catch (_: Exception) {
            // encoder is being torn down — the next scheduled keyframe will do
        }
    }

    private fun stopSink() {
        imageReader?.setOnImageAvailableListener(null, null)
        jpegHandler?.removeCallbacksAndMessages(null)
        jpegScheduled.set(false)
        imageReader?.close()
        imageReader = null
        jpegThread?.quitSafely()
        jpegThread = null
        jpegHandler = null
        latestJpeg = null

        val enc = encoder
        encoder = null
        if (enc != null) {
            try { enc.stop() } catch (_: Exception) {}
            try { enc.release() } catch (_: Exception) {}
        }
        encoderSurface?.release()
        encoderSurface = null
        encoderThread?.quitSafely()
        encoderThread = null
        h264Config = null
    }

    /// On Android 10+ (Q) a foreground service must declare its type when
    /// it starts, not just in the manifest — and on Android 14+ the type
    /// passed here must match the manifest's android:foregroundServiceType
    /// exactly or the system throws MissingForegroundServiceTypeException.
    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            // The microphone type may only be declared once RECORD_AUDIO is
            // granted (otherwise startForeground throws), and the system
            // silences the mic in a service that did not declare it.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && audioSource == AUDIO_MIC && hasMicPermission()) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            startForeground(NOTIF_ID, buildNotification(), type)
        } else {
            startForeground(NOTIF_ID, buildNotification())
        }
    }

    /// ImageReader hands back RGBA_8888 with row padding to a stride
    /// boundary — this un-pads it into a tightly-packed Bitmap and
    /// JPEG-encodes it (see JPEG_QUALITY). The image is already at the
    /// transmit size (see startJpegSink), so no scaling happens here.
    private fun imageToJpeg(image: Image): ByteArray {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        val paddedBitmap = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888
        )
        paddedBitmap.copyPixelsFromBuffer(buffer)

        val fullSize = if (rowPadding == 0) {
            paddedBitmap
        } else {
            val cropped = Bitmap.createBitmap(paddedBitmap, 0, 0, image.width, image.height)
            paddedBitmap.recycle()
            cropped
        }

        val bitmap = fullSize

        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    // ── Audio sharing ─────────────────────────────────────────────────────
    private var audioRecord: AudioRecord? = null
    private var audioThread: Thread? = null
    @Volatile private var audioRunning = false

    private fun hasMicPermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /// (Re)starts audio capture for the current `audioSource`. Main thread.
    private fun configureAudio() {
        stopAudio()
        val source = audioSource
        val projection = mediaProjection
        if (source == AUDIO_OFF || projection == null) return
        if (!hasMicPermission()) {
            Log.w(TAG, "Audio sharing requested but RECORD_AUDIO is not granted")
            return
        }
        try {
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(AUDIO_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build()
            val minBuf = AudioRecord.getMinBufferSize(
                AUDIO_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val bufSize = maxOf(minBuf, AUDIO_CHUNK_BYTES * 4)
            val record: AudioRecord
            if (source == AUDIO_SYSTEM) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    Log.w(TAG, "System-audio capture needs Android 10+")
                    return
                }
                val cfg = AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build()
                record = AudioRecord.Builder()
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufSize)
                    .setAudioPlaybackCaptureConfig(cfg)
                    .build()
            } else {
                // The service must have declared the microphone type (Android 14+).
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startForegroundCompat()
                record = AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.MIC)
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufSize)
                    .build()
            }
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                Log.w(TAG, "AudioRecord failed to initialise")
                return
            }
            record.startRecording()
            audioRecord = record
            audioRunning = true
            audioThread = Thread({ audioLoop(record) }, "tb-audio-capture").also { it.start() }
        } catch (e: Exception) {
            Log.w(TAG, "Could not start audio capture", e)
            stopAudio()
        }
    }

    private fun audioLoop(record: AudioRecord) {
        val buf = ByteArray(AUDIO_CHUNK_BYTES)
        while (audioRunning) {
            var got = 0
            while (got < buf.size && audioRunning) {
                val n = record.read(buf, got, buf.size - got)
                if (n <= 0) { audioRunning = false; break }
                got += n
            }
            if (got < buf.size) break
            var silent = true
            var i = 0
            while (i < buf.size) {
                if (buf[i].toInt() != 0 || buf[i + 1].toInt() != 0) { silent = false; break }
                i += 2
            }
            if (silent) continue
            val out = ByteArray(9 + buf.size)
            out[0] = 0x54; out[1] = 0x42; out[2] = 0x41; out[3] = 0x31 // "TBA1"
            out[4] = 1
            out[5] = (AUDIO_RATE ushr 24).toByte(); out[6] = (AUDIO_RATE ushr 16).toByte()
            out[7] = (AUDIO_RATE ushr 8).toByte(); out[8] = AUDIO_RATE.toByte()
            System.arraycopy(buf, 0, out, 9, buf.size)
            audioListener?.invoke(out)
        }
    }

    private fun stopAudio() {
        audioRunning = false
        val r = audioRecord
        audioRecord = null
        try { r?.stop() } catch (_: Exception) {}
        try { audioThread?.join(300) } catch (_: Exception) {}
        audioThread = null
        try { r?.release() } catch (_: Exception) {}
    }

    private fun stopCapture() {
        stopAudio()
        mainHandler.removeCallbacks(displayChangedRunnable)
        try {
            (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager)
                .unregisterDisplayListener(displayListener)
        } catch (_: Exception) {}
        stopSink()
        virtualDisplay?.release()
        try {
            mediaProjection?.unregisterCallback(projectionCallback)
        } catch (_: Exception) {
            // already unregistered / projection already gone — fine
        }
        mediaProjection?.stop()
        virtualDisplay = null
        mediaProjection = null
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW
            )
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("TouchBridge")
            .setContentText("Sharing your screen")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopCapture()
        if (instance === this) instance = null
        super.onDestroy()
    }
}