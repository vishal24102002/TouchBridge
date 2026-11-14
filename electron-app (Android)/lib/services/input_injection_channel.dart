import 'package:flutter/services.dart';

/// Bridges to the native AccessibilityService (see
/// TouchBridgeAccessibilityService.kt) that actually executes remote
/// input commands — taps, drags, typing, shortcuts — on this Android
/// device.
///
/// Unlike screen-recording permission, Android won't let an app silently
/// request this: the user has to manually flip it on in
/// Settings > Accessibility. That's an Android platform restriction (any
/// app with this permission can read screen content and inject input
/// system-wide, so it deliberately isn't a one-tap runtime prompt) — this
/// class exposes a "take me to that settings screen" call rather than a
/// "just ask" one, and isServiceEnabled()/isReady() let the UI poll for
/// when the user comes back with it turned on.
class InputInjectionChannel {
  static const _channel = MethodChannel('touchbridge/input_injection');

  /// Whether TouchBridge's AccessibilityService is currently enabled.
  static Future<bool> isServiceEnabled() async {
    try {
      return await _channel.invokeMethod<bool>('isServiceEnabled') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Opens Android's Accessibility settings list so the user can enable
  /// TouchBridge's service by hand.
  static Future<void> openAccessibilitySettings() async {
    try {
      await _channel.invokeMethod('openAccessibilitySettings');
    } catch (_) {
      // best-effort — if this fails there's nothing more to do from Dart
    }
  }

  /// Whether "draw over other apps" is granted — used for an optional
  /// on-screen dot showing where the virtual cursor currently is. Not
  /// required for input to actually work, just for a local person
  /// watching the phone to see what's happening.
  static Future<bool> hasOverlayPermission() async {
    try {
      return await _channel.invokeMethod<bool>('hasOverlayPermission') ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> requestOverlayPermission() async {
    try {
      await _channel.invokeMethod('requestOverlayPermission');
    } catch (_) {
      // best-effort
    }
  }

  /// True once remote input will actually do something on this device —
  /// currently just the AccessibilityService being enabled (the overlay
  /// cursor is a bonus, not a requirement).
  static Future<bool> isReady() => isServiceEnabled();

  /// Forwards one raw wire-protocol command (mouse_move:dx,dy,
  /// mouse_click, key:text, shortcut:name, ...) straight to the
  /// AccessibilityService for execution. Fire-and-forget: unsupported or
  /// malformed commands are logged natively and dropped, never thrown
  /// back into the control-channel handling loop.
  static void sendCommand(String cmd) {
    _channel.invokeMethod('sendCommand', {'cmd': cmd});
  }
}
