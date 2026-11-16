// PLACE AT: android/app/src/main/kotlin/<your/package/path>/MainActivity.kt
// Replace the `package` line below with your actual applicationId
// (check android/app/build.gradle's `applicationId`, and match the folder
// path under kotlin/ to it). If you already have a MainActivity.kt with
// other setup in it, merge configureFlutterEngine()/onActivityResult()
// into your existing class rather than overwriting the whole file.

package com.example.untitled

import android.app.Activity
import android.content.ComponentName
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import androidx.annotation.NonNull
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val SCREEN_CAPTURE_CHANNEL = "touchbridge/screen_capture"
    private val SCREEN_FRAMES_CHANNEL = "touchbridge/screen_capture_frames"
    private val H264_DECODER_CHANNEL = "touchbridge/h264_decoder"
    private val INPUT_INJECTION_CHANNEL = "touchbridge/input_injection"
    private val AUDIO_FRAMES_CHANNEL = "touchbridge/screen_audio"
    private val AUDIO_PLAYER_CHANNEL = "touchbridge/audio_player"
    private val REQUEST_CODE_RECORD_AUDIO = 4243
    private val REQUEST_CODE_SCREEN_CAPTURE = 4242

    private var pendingPermissionResult: MethodChannel.Result? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Host side: H.264 payloads pushed to Dart (see ScreenCaptureService).
    private var frameSink: EventChannel.EventSink? = null

    // Host side: audio chunks pushed to Dart; and a pending mic-permission prompt.
    private var audioSink: EventChannel.EventSink? = null
    private var pendingAudioSource: String? = null
    private var pendingAudioResult: MethodChannel.Result? = null

    // Viewer side: plays the host's shared audio.
    private var audioPlayer: AudioPlayerNative? = null

    // Viewer side: at most one live H.264 decoder (one remote session at a time).
    private var h264Decoder: H264TextureDecoder? = null

    override fun configureFlutterEngine(@NonNull flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SCREEN_CAPTURE_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "requestPermission" -> {
                        // Only one request can be in flight at a time — the
                        // Dart side awaits this before ever calling it again.
                        pendingPermissionResult = result
                        val manager =
                            getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                        startActivityForResult(
                            manager.createScreenCaptureIntent(),
                            REQUEST_CODE_SCREEN_CAPTURE
                        )
                    }
                    "startCapture" -> {
                        if (ScreenCaptureService.hasPermission()) {
                            // "h264" (default) or "jpeg"
                            val codec = call.argument<String>("codec") ?: ScreenCaptureService.CODEC_H264
                            ScreenCaptureService.requestedCodec = codec
                            val audio = call.argument<String>("audio") ?: ScreenCaptureService.AUDIO_OFF
                            val audioOk = audio == ScreenCaptureService.AUDIO_OFF ||
                                checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                            ScreenCaptureService.audioSource = if (audioOk) audio else ScreenCaptureService.AUDIO_OFF
                            val intent = Intent(this, ScreenCaptureService::class.java)
                            intent.action = ScreenCaptureService.ACTION_START
                            intent.putExtra(ScreenCaptureService.EXTRA_CODEC, codec)
                            intent.putExtra(ScreenCaptureService.EXTRA_AUDIO, ScreenCaptureService.audioSource)
                            startForegroundService(intent)
                            result.success(true)
                        } else {
                            result.success(false)
                        }
                    }
                    "stopCapture" -> {
                        val intent = Intent(this, ScreenCaptureService::class.java)
                        intent.action = ScreenCaptureService.ACTION_STOP
                        startService(intent)
                        result.success(null)
                    }
                    "getLatestFrame" -> {
                        result.success(ScreenCaptureService.latestFrame())
                    }
                    "getLatestFrameIfNew" -> {
                        // null unless a new JPEG exists (always null in H.264 mode)
                        result.success(ScreenCaptureService.takeNewFrame())
                    }
                    "setCodec" -> {
                        ScreenCaptureService.applyCodec(
                            call.argument<String>("codec") ?: ScreenCaptureService.CODEC_H264
                        )
                        result.success(null)
                    }
                    "getActiveCodec" -> {
                        result.success(ScreenCaptureService.activeCodec)
                    }
                    "setAudioSource" -> {
                        // "off" | "mic" | "system". Sharing sound needs the RECORD_AUDIO
                        // permission (also for system sound), so ask for it here.
                        val source = call.argument<String>("source") ?: ScreenCaptureService.AUDIO_OFF
                        if (source == ScreenCaptureService.AUDIO_SYSTEM && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                            result.success(false) // system sound needs Android 10+
                        } else if (source == ScreenCaptureService.AUDIO_OFF ||
                            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            ScreenCaptureService.applyAudioSource(source)
                            result.success(true)
                        } else {
                            pendingAudioResult?.success(false)
                            pendingAudioSource = source
                            pendingAudioResult = result
                            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_CODE_RECORD_AUDIO)
                        }
                    }
                    "requestKeyframe" -> {
                        ScreenCaptureService.requestKeyframe()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }

        // Host side: every encoded H.264 access unit, pushed to Dart as it is produced.
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, SCREEN_FRAMES_CHANNEL)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    frameSink = events
                    ScreenCaptureService.frameListener = { bytes ->
                        mainHandler.post { frameSink?.success(bytes) }
                    }
                }

                override fun onCancel(arguments: Any?) {
                    frameSink = null
                    ScreenCaptureService.frameListener = null
                }
            })

        // Host side: audio chunks, pushed to Dart as they are captured.
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, AUDIO_FRAMES_CHANNEL)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    audioSink = events
                    ScreenCaptureService.audioListener = { bytes ->
                        mainHandler.post { audioSink?.success(bytes) }
                    }
                }

                override fun onCancel(arguments: Any?) {
                    audioSink = null
                    ScreenCaptureService.audioListener = null
                }
            })

        // Viewer side: play the host's audio through a streaming AudioTrack.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, AUDIO_PLAYER_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "play" -> {
                        val bytes = call.arguments as? ByteArray
                        if (bytes != null) {
                            val player = audioPlayer ?: AudioPlayerNative().also { audioPlayer = it }
                            player.play(bytes)
                        }
                        result.success(null)
                    }
                    "setMuted" -> {
                        val muted = call.arguments as? Boolean ?: false
                        val player = audioPlayer ?: AudioPlayerNative().also { audioPlayer = it }
                        player.setMuted(muted)
                        result.success(null)
                    }
                    "release" -> {
                        audioPlayer?.release()
                        audioPlayer = null
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }

        // Viewer side: hardware H.264 decoding straight into a Flutter texture.
        val decoderChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, H264_DECODER_CHANNEL)
        decoderChannel.setMethodCallHandler { call, result ->
            when (call.method) {
                "create" -> {
                    h264Decoder?.release()
                    val entry = flutterEngine.renderer.createSurfaceTexture()
                    val decoder = H264TextureDecoder(entry) { w, h ->
                        decoderChannel.invokeMethod("onSize", mapOf("width" to w, "height" to h))
                    }
                    h264Decoder = decoder
                    result.success(decoder.textureId)
                }
                "decode" -> {
                    val bytes = call.arguments as? ByteArray
                    if (bytes != null) h264Decoder?.submit(bytes)
                    result.success(null)
                }
                "release" -> {
                    h264Decoder?.release()
                    h264Decoder = null
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, INPUT_INJECTION_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "isServiceEnabled" -> {
                        result.success(isAccessibilityServiceEnabled())
                    }
                    "openAccessibilitySettings" -> {
                        startActivity(
                            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                        result.success(null)
                    }
                    "hasOverlayPermission" -> {
                        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            Settings.canDrawOverlays(this)
                        } else {
                            true
                        }
                        result.success(granted)
                    }
                    "requestOverlayPermission" -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            startActivity(
                                Intent(
                                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    Uri.parse("package:$packageName")
                                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                        result.success(null)
                    }
                    "sendCommand" -> {
                        val cmd = call.argument<String>("cmd") ?: ""
                        TouchBridgeAccessibilityService.instance?.handleCommand(cmd)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /// Standard way to check whether a specific accessibility service is
    /// currently enabled: TouchBridgeAccessibilityService.isRunning()
    /// alone isn't reliable here since the service only *connects* (and
    /// sets that) after Android decides to bind it, which can lag behind
    /// the user flipping the Settings switch — this reads the actual
    /// system setting directly instead.
    private fun isAccessibilityServiceEnabled(): Boolean {
        val expected = ComponentName(this, TouchBridgeAccessibilityService::class.java)
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false

        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabledServices)
        while (splitter.hasNext()) {
            val component = ComponentName.unflattenFromString(splitter.next())
            if (component == expected) return true
        }
        return false
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_CODE_SCREEN_CAPTURE) {
            val granted = resultCode == Activity.RESULT_OK && data != null
            if (granted) {
                ScreenCaptureService.storePermission(resultCode, data!!)
            }
            pendingPermissionResult?.success(granted)
            pendingPermissionResult = null
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CODE_RECORD_AUDIO) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            val source = pendingAudioSource
            if (granted && source != null) ScreenCaptureService.applyAudioSource(source)
            pendingAudioResult?.success(granted)
            pendingAudioResult = null
            pendingAudioSource = null
        }
    }

    override fun onDestroy() {
        audioPlayer?.release()
        audioPlayer = null
        h264Decoder?.release()
        h264Decoder = null
        super.onDestroy()
    }
}
