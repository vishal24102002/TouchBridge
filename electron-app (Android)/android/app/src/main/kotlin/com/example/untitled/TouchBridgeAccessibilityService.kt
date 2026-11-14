// PLACE AT: android/app/src/main/kotlin/<your/package/path>/TouchBridgeAccessibilityService.kt
// Same package line requirement as the other two native files — they must
// all match your actual applicationId.

package com.example.untitled

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/// Executes the same wire-protocol commands ClientPage.js/network_service.dart
/// send everywhere else (mouse_move_abs:fx,fy, mouse_click, key:text,
/// shortcut:name, ...) using Android's AccessibilityService APIs — the
/// only way to inject input system-wide without root.
///
/// Important platform differences from a real desktop, documented rather
/// than silently papered over:
///   - Android has no persistent mouse cursor. This maintains a virtual
///     cursor position in memory — set directly from mouse_move_abs's
///     fractional (0.0-1.0) coordinates, the preferred/current command,
///     with legacy relative mouse_move:dx,dy still supported for older
///     clients — and dispatches taps/drags at that position. An optional
///     on-screen dot (needs "draw over other apps" permission) shows
///     where it currently is — purely for a local person watching the
///     phone; it's not required for commands to work.
///   - mouse_right_click has no Android equivalent, so it's mapped to a
///     long-press (the closest analogous gesture).
///   - key:<text> finds the currently-focused editable field and APPENDS
///     to its existing text via ACTION_SET_TEXT. This ignores wherever
///     the on-screen text cursor visually is (AccessibilityService can't
///     reliably read/set cursor position across arbitrary third-party
///     apps) — it always appends at the end. backspace removes the last
///     character the same way.
///   - Most desktop shortcuts (arrow keys, ctrl+c, F-keys, ...) have no
///     Android equivalent at all and are intentionally no-ops here (see
///     handleShortcut) — only the ones with a real system action
///     (back/home/recents/screenshot) are wired up.
class TouchBridgeAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "TouchBridgeInput"

        // Sole running instance, set on connect/cleared on disconnect —
        // this is how MainActivity's MethodChannel handler (running in a
        // totally separate object) reaches whichever service instance the
        // system currently has bound. Standard pattern for singleton
        // system services like this.
        @Volatile
        var instance: TouchBridgeAccessibilityService? = null
            private set

        fun isRunning(): Boolean = instance != null
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private var screenWidth = 0
    private var screenHeight = 0
    private var cursorX = 0f
    private var cursorY = 0f

    private var windowManager: WindowManager? = null
    private var overlayView: View? = null
    private var overlayParams: WindowManager.LayoutParams? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this

        // canPerformGestures/canRetrieveWindowContent are also declared in
        // res/xml/accessibility_service_config.xml (referenced from the
        // manifest's <service> entry) — setting them again here at
        // runtime is redundant on most versions but harmless, and makes
        // this file self-documenting about what it actually needs.
        val info = serviceInfo ?: AccessibilityServiceInfo()
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        info.flags = AccessibilityServiceInfo.DEFAULT
        serviceInfo = info

        Log.i(TAG, "TouchBridge accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We don't react to accessibility events — this service only
        // performs actions on command from handleCommand(), it doesn't
        // need to observe anything.
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        removeOverlay()
        return super.onUnbind(intent)
    }

    // ── Entry point, called from MainActivity's MethodChannel handler ──────
    fun handleCommand(cmd: String) {
        try {
            when {
                cmd == "mouse_click" -> dispatchTap(cursorX, cursorY)
                cmd == "mouse_right_click" -> dispatchLongPress(cursorX, cursorY)
                cmd == "mouse_double_click" -> dispatchDoubleTap(cursorX, cursorY)
                cmd.startsWith("mouse_move_abs:") -> handleMouseMoveAbsolute(cmd.removePrefix("mouse_move_abs:"))
                cmd.startsWith("mouse_move:") -> handleMouseMove(cmd.removePrefix("mouse_move:"))
                cmd.startsWith("scroll:") -> handleScroll(cmd.removePrefix("scroll:"))
                cmd.startsWith("key:") -> typeText(cmd.removePrefix("key:"))
                cmd.startsWith("shortcut:") -> handleShortcut(cmd.removePrefix("shortcut:"))
                cmd == "open_browser" -> openBrowser()
                cmd == "open_terminal" -> openTerminal()
                cmd == "custom:open_folder" -> openFolder()
                cmd == "media_play_pause" -> mediaKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
                cmd == "volume_up" -> volumeUp()
                cmd == "volume_mute" -> volumeMute()
                else -> Log.i(TAG, "Unhandled command: $cmd")
            }
        } catch (e: Exception) {
            // One bad/unsupported command should never take the whole
            // service down — log and move on to the next one.
            Log.e(TAG, "Error handling command '$cmd'", e)
        }
    }

    // ── Virtual cursor ──────────────────────────────────────────────────────
    private fun ensureScreenSize() {
        if (screenWidth > 0 && screenHeight > 0) return
        val metrics = resources.displayMetrics
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        cursorX = screenWidth / 2f
        cursorY = screenHeight / 2f
    }

    private fun handleMouseMove(payload: String) {
        val parts = payload.split(",")
        if (parts.size != 2) return
        val dx = parts[0].toFloatOrNull() ?: return
        val dy = parts[1].toFloatOrNull() ?: return
        ensureScreenSize()
        // Deltas arrive in units of whatever frame the client actually
        // measured against (ClientPage.js's sendMouseMove uses the
        // received image's natural size), which is the DOWNSCALED
        // transmitted frame, not this device's real pixel grid, whenever
        // ScreenCaptureService is sending frames below native resolution.
        // Scale back up so the cursor moves the correct physical distance
        // regardless of what size frames are currently being sent.
        val scale = ScreenCaptureService.captureScaleFactor
        cursorX = (cursorX + dx * scale).coerceIn(0f, (screenWidth - 1).toFloat())
        cursorY = (cursorY + dy * scale).coerceIn(0f, (screenHeight - 1).toFloat())
        updateOverlayPosition()
    }

    /// Preferred over handleMouseMove: the client computes exactly where
    /// within the received image the pointer tip is (0.0-1.0 fractions,
    /// independent of transmitted resolution or zoom) and sends that
    /// directly, so the virtual cursor is set in one shot with no
    /// accumulated delta error — every event is independently correct,
    /// nothing can drift out of sync over a session the way relative
    /// deltas could.
    private fun handleMouseMoveAbsolute(payload: String) {
        val parts = payload.split(",")
        if (parts.size != 2) return
        val fx = parts[0].toFloatOrNull() ?: return
        val fy = parts[1].toFloatOrNull() ?: return
        ensureScreenSize()
        cursorX = (fx * screenWidth).coerceIn(0f, (screenWidth - 1).toFloat())
        cursorY = (fy * screenHeight).coerceIn(0f, (screenHeight - 1).toFloat())
        updateOverlayPosition()
    }

    /// Scroll wheel — simulated as a short swipe gesture at the current
    /// cursor position, since that's the only scroll-equivalent
    /// AccessibilityService can dispatch without needing a specific
    /// scrollable node target. Wheel "scroll down" (positive vNotches,
    /// wanting to see content further down) maps to the opposite-signed
    /// swipe direction — dragging a finger UP moves the viewport DOWN —
    /// same relationship a real touchscreen scroll has.
    private fun handleScroll(payload: String) {
        val parts = payload.split(",")
        if (parts.size != 2) return
        val hNotches = parts[0].toIntOrNull() ?: return
        val vNotches = parts[1].toIntOrNull() ?: return
        if (hNotches == 0 && vNotches == 0) return
        ensureScreenSize()

        val perNotch = 140f
        val dx = -hNotches * perNotch
        val dy = -vNotches * perNotch

        val startX = cursorX
        val startY = cursorY
        val endX = (startX + dx).coerceIn(0f, (screenWidth - 1).toFloat())
        val endY = (startY + dy).coerceIn(0f, (screenHeight - 1).toFloat())

        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, 180L)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    // ── Gestures ─────────────────────────────────────────────────────────
    private fun dispatchTap(x: Float, y: Float, holdMs: Long = 60) {
        if (x <= 0f && y <= 0f && screenWidth == 0) ensureScreenSize()
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, holdMs)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    private fun dispatchLongPress(x: Float, y: Float) {
        // Long enough to register as a long-press across launchers/apps
        // without feeling like a stuck touch.
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 600L)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    private fun dispatchDoubleTap(x: Float, y: Float) {
        dispatchTap(x, y)
        mainHandler.postDelayed({ dispatchTap(x, y) }, 120)
    }

    // ── Text input ───────────────────────────────────────────────────────
    private fun findFocusedEditable(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        return findFocusRecursive(root)
    }

    private fun findFocusRecursive(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isFocused && node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val result = findFocusRecursive(child)
            if (result != null) return result
            @Suppress("DEPRECATION")
            child.recycle()
        }
        return null
    }

    private fun setNodeText(node: AccessibilityNodeInfo, newText: String) {
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText)
        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun typeText(text: String) {
        val node = findFocusedEditable()
        if (node == null) {
            Log.w(TAG, "No focused editable field — can't type '$text'")
            return
        }
        val current = node.text?.toString() ?: ""
        setNodeText(node, current + text)
        @Suppress("DEPRECATION")
        node.recycle()
    }

    private fun backspace() {
        val node = findFocusedEditable() ?: return
        val current = node.text?.toString() ?: ""
        if (current.isNotEmpty()) setNodeText(node, current.dropLast(1))
        @Suppress("DEPRECATION")
        node.recycle()
    }

    // ── Shortcuts — only the ones with a real Android equivalent ───────────
    private fun handleShortcut(name: String) {
        when (name) {
            "backspace" -> backspace()
            "escape" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "win_d", "super", "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "alt_tab" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "print_screen" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
                } else {
                    Log.i(TAG, "print_screen needs Android 9+ — ignored")
                }
            }
            else -> Log.i(
                TAG,
                "Shortcut '$name' has no Android equivalent (arrow keys, ctrl/alt " +
                        "combos, F-keys, etc. don't map to anything on this platform) — ignored"
            )
        }
    }

    // ── App/utility commands ────────────────────────────────────────────────
    private fun openBrowser() {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Could not open a browser", e)
        }
    }

    private fun openTerminal() {
        val intent = packageManager.getLaunchIntentForPackage("com.termux")
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        } else {
            Log.i(TAG, "open_terminal requested — no terminal app (e.g. Termux) is installed")
        }
    }

    private fun openFolder() {
        try {
            val intent = Intent(Intent.ACTION_VIEW)
            intent.setDataAndType(
                Uri.parse("content://com.android.externalstorage.documents/root/primary"),
                "vnd.android.document/root"
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Could not open a file manager", e)
        }
    }

    private fun mediaKey(keyCode: Int) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
    }

    private fun volumeUp() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
    }

    private fun volumeMute() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI)
    }

    // ── Optional visual cursor overlay ──────────────────────────────────────
    private fun ensureOverlay() {
        if (overlayView != null) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!Settings.canDrawOverlays(this)) return

        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val cursor = CursorView(this)
        val size = (28 * resources.displayMetrics.density).toInt()
        val params = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP or Gravity.START

        try {
            windowManager?.addView(cursor, params)
            overlayView = cursor
            overlayParams = params
        } catch (e: Exception) {
            // Permission not actually granted despite canDrawOverlays()
            // saying so (some OEM skins lie), or some other WM rejection
            // — the cursor is cosmetic, so just skip it silently.
            Log.w(TAG, "Could not add cursor overlay", e)
        }
    }

    private fun updateOverlayPosition() {
        ensureOverlay()
        val view = overlayView ?: return
        val params = overlayParams ?: return
        params.x = cursorX.toInt()
        params.y = cursorY.toInt()
        try {
            windowManager?.updateViewLayout(view, params)
        } catch (_: Exception) {
            // view/window already gone — next mouse_move will recreate it
        }
    }

    private fun removeOverlay() {
        val view = overlayView ?: return
        try {
            windowManager?.removeView(view)
        } catch (_: Exception) {
        }
        overlayView = null
        overlayParams = null
    }
}

/// A hand-drawn arrow-pointer shape (white fill, black outline) instead of
/// a plain colored square — the point of the overlay is to show a local
/// person watching the phone something recognizable as "this is the
/// cursor," not just a colored blob. The tip of the arrow is drawn at this
/// view's own local (0,0) — its top-left corner — which is deliberate:
/// ensureOverlay() positions the view's top-left directly at
/// (cursorX, cursorY), so the tip is exactly the cursor's hotspot, the
/// same way a real desktop cursor's hotspot is its tip, not its center.
private class CursorView(context: Context) : View(context) {
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.FILL
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeWidth = 1.5f * context.resources.displayMetrics.density
    }
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w == 0f || h == 0f) return

        path.reset()
        path.moveTo(0f, 0f)
        path.lineTo(0f, h * 0.75f)
        path.lineTo(w * 0.22f, h * 0.58f)
        path.lineTo(w * 0.38f, h)
        path.lineTo(w * 0.55f, h * 0.92f)
        path.lineTo(w * 0.35f, h * 0.5f)
        path.lineTo(w * 0.62f, h * 0.5f)
        path.close()

        canvas.drawPath(path, fillPaint)
        canvas.drawPath(path, strokePaint)
    }
}