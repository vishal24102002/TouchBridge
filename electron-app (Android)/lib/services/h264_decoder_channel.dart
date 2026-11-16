import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/services.dart';

/// Hardware H.264 decoding for the viewer, rendered into a Flutter texture.
///
/// Native side: H264TextureDecoder.kt (MediaCodec -> SurfaceTexture). Show the
/// picture with `Texture(textureId: decoder.textureId!)`.
///
/// Feed it TouchBridge H.264 payloads exactly as they come off the wire:
/// "TBH4" + 1 flag byte (bit 0 = keyframe) + Annex-B NAL units. Frames must be
/// passed in order and none may be skipped except by the decoder itself — it
/// decides when to wait for the next keyframe.
class H264Decoder {
  static const _channel = MethodChannel('touchbridge/h264_decoder');

  int? textureId;
  bool _released = false;

  final _sizeController = StreamController<Size>.broadcast();

  /// Emits the decoded picture size (after cropping) when it first becomes
  /// known and whenever the host changes resolution.
  Stream<Size> get onSize => _sizeController.stream;

  /// Creates the native decoder + texture. Returns false if unavailable.
  Future<bool> start() async {
    try {
      _channel.setMethodCallHandler((call) async {
        if (call.method == 'onSize' && !_released) {
          final args = Map<dynamic, dynamic>.from(call.arguments as Map);
          _sizeController.add(Size(
            (args['width'] as num).toDouble(),
            (args['height'] as num).toDouble(),
          ));
        }
        return null;
      });
      final id = await _channel.invokeMethod<int>('create');
      if (id == null) return false;
      textureId = id;
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Fire-and-forget; platform-channel messages are delivered in order.
  void decode(Uint8List payload) {
    if (_released || textureId == null) return;
    _channel.invokeMethod('decode', payload).catchError((_) {});
  }

  Future<void> release() async {
    if (_released) return;
    _released = true;
    try {
      await _channel.invokeMethod('release');
    } catch (_) {}
    _channel.setMethodCallHandler(null);
    await _sizeController.close();
  }
}
