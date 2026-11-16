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
  static const _frames = EventChannel('touchbridge/screen_capture_frames');
  static const _audio = EventChannel('touchbridge/screen_audio');

  /// Audio sharing sources ('off' is the default).
  static const audioOff = 'off';
  static const audioMic = 'mic';
  static const audioSystem = 'system';

  /// Video codecs the capture service can produce. H.264 is the default;
  /// JPEG is the compatibility fallback (one image per frame).
  static const codecH264 = 'h264';
  static const codecJpeg = 'jpeg';

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
  static Future<bool> startCapture({String codec = codecH264, String audio = audioOff}) async {
    try {
      final ok = await _channel.invokeMethod<bool>('startCapture', {'codec': codec, 'audio': audio});
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

  /// Same as [getLatestFrame] but returns null unless a NEW frame has been
  /// produced since the last call — so a static screen isn't re-sent over and
  /// over. Always null while the H.264 encoder is the active output.
  static Future<Uint8List?> getLatestFrameIfNew() async {
    try {
      return await _channel.invokeMethod<Uint8List>('getLatestFrameIfNew');
    } catch (_) {
      return null;
    }
  }

  /// Every captured frame, pushed as it is produced. In H.264 mode each event
  /// is an access unit in TouchBridge's wire format: "TBH4" + 1 flag byte
  /// (bit 0 = keyframe) + Annex-B NAL units (keyframes carry SPS+PPS in-band).
  /// In JPEG mode each event is one JPEG image.
  static Stream<Uint8List> get videoFrames =>
      _frames.receiveBroadcastStream().map((e) => e as Uint8List);

  /// Switches the running capture between 'h264' and 'jpeg' without asking
  /// for screen-capture permission again.
  static Future<void> setCodec(String codec) async {
    try {
      await _channel.invokeMethod('setCodec', {'codec': codec});
    } catch (_) {}
  }

  /// What is really being produced right now ('h264' or 'jpeg') — can be
  /// 'jpeg' even when H.264 was requested, if the device has no usable encoder.
  static Future<String?> getActiveCodec() async {
    try {
      return await _channel.invokeMethod<String>('getActiveCodec');
    } catch (_) {
      return null;
    }
  }

  /// Asks the H.264 encoder for an immediate keyframe (a viewer fell behind
  /// and needs to resynchronise).
  static Future<void> requestKeyframe() async {
    try {
      await _channel.invokeMethod('requestKeyframe');
    } catch (_) {}
  }

  /// Shared-audio chunks as they are captured: "TBA1" + channels u8 +
  /// sample-rate u32 BE + PCM16LE. Silent while audio sharing is off.
  static Stream<Uint8List> get audioFrames =>
      _audio.receiveBroadcastStream().map((e) => e as Uint8List);

  /// Turns audio sharing on/off for the running (or next) capture:
  /// [audioOff] | [audioMic] | [audioSystem]. Asks for the microphone /
  /// record-audio permission the first time. Returns false if the user said no
  /// or the source isn't supported on this device (system sound needs Android 10+).
  static Future<bool> setAudioSource(String source) async {
    try {
      final ok = await _channel.invokeMethod<bool>('setAudioSource', {'source': source});
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }
}
