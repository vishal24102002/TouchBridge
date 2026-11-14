// PLACE AT: android/app/src/main/kotlin/<your/package/path>/ScreenCaptureService.kt
// Same package line requirement as MainActivity.kt — they must match.

package com.example.untitled

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream

/// Foreground service that owns the MediaProjection + VirtualDisplay and
/// keeps a single "latest frame" buffer, polled from Dart via
/// getLatestFrame() on the MethodChannel (see MainActivity.kt). A
/// foreground service (not a background one) is required — Android kills
/// MediaProjection capture the moment the app backgrounds otherwise,
/// which would happen constantly during a real remote-desktop session.
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "TouchBridgeCapture"
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        private const val NOTIF_CHANNEL_ID = "touchbridge_capture"
        private const val NOTIF_ID = 1001

        // Every frame currently travels over a BRAND NEW TLS connection
        // (see host_server_service.dart's screen channel — same
        // request/response-per-frame design as server.py's own protocol),
        // so per-frame payload size directly drives achievable FPS on top
        // of the fixed per-connection handshake cost. These two knobs are
        // the lever available on the capture side; lower them further if
        // frame rate still isn't fast enough for a given network/device,
        // or raise them if the network can clearly keep up and legibility
        // matters more (e.g. reading small text on the remote screen).
        private const val MAX_DIMENSION = 960
        private const val JPEG_QUALITY = 60

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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
            }
            else -> startCapture()
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
            val width = metrics.widthPixels
            val height = metrics.heightPixels
            val density = metrics.densityDpi

            imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            virtualDisplay = projection.createVirtualDisplay(
                "TouchBridgeCapture",
                width, height, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader!!.surface, null, null
            )

            imageReader!!.setOnImageAvailableListener({ reader ->
                var image: Image? = null
                try {
                    image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                    latestJpeg = imageToJpeg(image)
                } catch (_: Exception) {
                    // Drop this frame — the next callback will supersede
                    // it; not worth surfacing a whole-service error over
                    // one frame.
                } finally {
                    image?.close()
                }
            }, null)
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

    /// On Android 10+ (Q) a foreground service must declare its type when
    /// it starts, not just in the manifest — and on Android 14+ the type
    /// passed here must match the manifest's android:foregroundServiceType
    /// exactly or the system throws MissingForegroundServiceTypeException.
    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIF_ID, buildNotification())
        }
    }

    /// ImageReader hands back RGBA_8888 with row padding to a stride
    /// boundary — this un-pads it into a tightly-packed Bitmap, downscales
    /// it (see MAX_DIMENSION), and JPEG-encodes it (see JPEG_QUALITY). The
    /// unpad step is the standard, well-known pattern for MediaProjection
    /// capture; the downscale is what actually makes frames fast enough to
    /// poll every ~200ms given each one is a fresh TLS round trip.
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

        // Downscaling here (rather than capturing at a lower resolution
        // via a smaller VirtualDisplay) keeps the capture itself at native
        // resolution — simplest, and avoids DPI/aspect-ratio edge cases —
        // while still shrinking what actually has to be encoded and sent.
        val longSide = maxOf(fullSize.width, fullSize.height)
        val bitmap: Bitmap
        if (longSide > MAX_DIMENSION) {
            val scale = MAX_DIMENSION.toFloat() / longSide
            captureScaleFactor = 1f / scale // native pixels per transmitted pixel
            bitmap = Bitmap.createScaledBitmap(
                fullSize,
                (fullSize.width * scale).toInt().coerceAtLeast(1),
                (fullSize.height * scale).toInt().coerceAtLeast(1),
                true
            )
            fullSize.recycle()
        } else {
            captureScaleFactor = 1f
            bitmap = fullSize
        }

        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    private fun stopCapture() {
        imageReader?.setOnImageAvailableListener(null, null)
        virtualDisplay?.release()
        try {
            mediaProjection?.unregisterCallback(projectionCallback)
        } catch (_: Exception) {
            // already unregistered / projection already gone — fine
        }
        mediaProjection?.stop()
        virtualDisplay = null
        mediaProjection = null
        imageReader = null
        latestJpeg = null
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
        super.onDestroy()
    }
}