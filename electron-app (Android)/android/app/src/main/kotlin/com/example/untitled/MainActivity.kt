// PLACE AT: android/app/src/main/kotlin/<your/package/path>/MainActivity.kt
// Replace the `package` line below with your actual applicationId
// (check android/app/build.gradle's `applicationId`, and match the folder
// path under kotlin/ to it). If you already have a MainActivity.kt with
// other setup in it, merge configureFlutterEngine()/onActivityResult()
// into your existing class rather than overwriting the whole file.

package com.example.untitled

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import androidx.annotation.NonNull
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val SCREEN_CAPTURE_CHANNEL = "touchbridge/screen_capture"
    private val INPUT_INJECTION_CHANNEL = "touchbridge/input_injection"
    private val REQUEST_CODE_SCREEN_CAPTURE = 4242

    private var pendingPermissionResult: MethodChannel.Result? = null

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
                            val intent = Intent(this, ScreenCaptureService::class.java)
                            intent.action = ScreenCaptureService.ACTION_START
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
}