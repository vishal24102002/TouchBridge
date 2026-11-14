import 'dart:typed_data';
import 'package:flutter/services.dart';

/// Bridges to native Android code (MainActivity.kt +
/// ScreenCaptureService.kt — see android_native/ in this drop) for
/// MediaProjection-based screen capture.
///
/// There is no pure-Dart API for capturing the device's own screen:
/// Android requires (1) an explicit user consent dialog via
/// MediaProjectionManager, shown from an Activity, and (2) a foreground
/// Service to keep capturing while TouchBridge is backgrounded during a
/// hosted session. Both of those only exist as native code, hence this
/// MethodChannel bridge instead of a plugin package.
class ScreenCaptureChannel {
  static const _channel = MethodChannel('touchbridge/screen_capture');

  /// Shows Android's "Start recording or casting?" system dialog. Must be
  /// awaited (and return true) before calling startCapture(). Returns
  /// false if the user declines, or if the native side isn't wired up
  /// (e.g. running on a non-Android platform during development).
  static Future<bool> requestPermission() async {
    try {
      final granted = await _channel.invokeMethod<bool>('requestPermission');
      return granted ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Starts the foreground capture service. Only call after
  /// requestPermission() has returned true.
  static Future<bool> startCapture() async {
    try {
      final ok = await _channel.invokeMethod<bool>('startCapture');
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> stopCapture() async {
    try {
      await _channel.invokeMethod('stopCapture');
    } catch (_) {
      // best-effort — nothing to clean up on the Dart side either way
    }
  }

  /// Returns the most recently captured frame as JPEG bytes, or null if
  /// capture isn't running yet / no frame has landed since start. Meant
  /// to be polled — pass this directly as HostServerService's
  /// frameProvider, which already runs on its own periodic timer.
  static Future<Uint8List?> getLatestFrame() async {
    try {
      return await _channel.invokeMethod<Uint8List>('getLatestFrame');
    } catch (_) {
      return null;
    }
  }
}
