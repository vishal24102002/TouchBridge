import 'dart:typed_data';
import 'package:flutter/services.dart';

/// Plays the host's shared audio on the viewer (native side: AudioPlayerNative.kt,
/// a streaming AudioTrack). Feed it payloads exactly as they come off the wire:
/// "TBA1" + channels u8 + sample-rate u32 BE + PCM16LE.
class AudioPlayerChannel {
  static const _channel = MethodChannel('touchbridge/audio_player');

  static Future<void> play(Uint8List payload) async {
    try {
      await _channel.invokeMethod('play', payload);
    } catch (_) {}
  }

  static Future<void> setMuted(bool muted) async {
    try {
      await _channel.invokeMethod('setMuted', muted);
    } catch (_) {}
  }

  static Future<void> release() async {
    try {
      await _channel.invokeMethod('release');
    } catch (_) {}
  }
}
