import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// -----------------------------------------------------------------------
/// IMPORTANT — SCREEN CAPTURE ON ANDROID
/// -----------------------------------------------------------------------
/// Capturing the device's own screen requires Android's MediaProjection API,
/// which is only reachable through native/platform-channel code (there is
/// no pure-Dart way to grab frames of the screen). This service provides
/// the full TCP plumbing described in the README (accepting clients on the
/// screen + control ports, framing, broadcasting), but the actual pixels
/// come from a pluggable `frameProvider` callback.
///
/// To wire up real screen capture:
///   1. Add a platform channel (or a plugin such as `flutter_screen_recording`
///      / a custom MediaProjection implementation) that returns JPEG bytes
///      of the current screen.
///   2. Pass that function in as `frameProvider` when constructing
///      HostServerService.
/// Until then, `frameProvider` defaults to a small placeholder JPEG so the
/// networking + UI can be exercised end-to-end.
/// -----------------------------------------------------------------------
class HostServerService {
  ServerSocket? _screenServer;
  ServerSocket? _controlServer;
  final List<Socket> _screenClients = [];
  Timer? _broadcastTimer;

  final _logController = StreamController<String>.broadcast();
  Stream<String> get logs => _logController.stream;

  bool get isRunning => _screenServer != null || _controlServer != null;

  /// Supplies the next screen frame as JPEG bytes. Replace with real
  /// MediaProjection-backed capture; see note above.
  final Future<Uint8List> Function()? frameProvider;

  HostServerService({this.frameProvider});

  void _log(String message) {
    final ts = DateTime.now().toIso8601String().substring(11, 19);
    _logController.add('[$ts] $message');
  }

  Future<void> start({
    required int screenPort,
    required int controlPort,
    Duration frameInterval = const Duration(milliseconds: 200),
  }) async {
    if (isRunning) return;

    _controlServer = await ServerSocket.bind(InternetAddress.anyIPv4, controlPort);
    _log('Control channel listening on :$controlPort');
    _controlServer!.listen(_handleControlClient);

    _screenServer = await ServerSocket.bind(InternetAddress.anyIPv4, screenPort);
    _log('Screen channel listening on :$screenPort');
    _screenServer!.listen(_handleScreenClient);

    _broadcastTimer = Timer.periodic(frameInterval, (_) => _broadcastFrame());
  }

  void _handleControlClient(Socket client) {
    _log('Control client connected: ${client.remoteAddress.address}');
    final buffer = StringBuffer();
    client.listen(
      (data) {
        buffer.write(utf8.decode(data, allowMalformed: true));
        var content = buffer.toString();
        int newlineIndex;
        while ((newlineIndex = content.indexOf('\n')) != -1) {
          final line = content.substring(0, newlineIndex).trim();
          content = content.substring(newlineIndex + 1);
          if (line.isNotEmpty) _handleControlMessage(line);
        }
        buffer
          ..clear()
          ..write(content);
      },
      onDone: () => _log('Control client disconnected: ${client.remoteAddress.address}'),
      onError: (_) => _log('Control channel error from ${client.remoteAddress.address}'),
    );
  }

  void _handleControlMessage(String line) {
    try {
      final msg = jsonDecode(line) as Map<String, dynamic>;
      // TODO: forward to your native input-simulation layer here
      // (xdotool / ydotool / pyautogui equivalents don't exist on Android;
      // on Android you'd use the AccessibilityService API to inject input
      // if this device is itself being controlled by a remote peer).
      _log('Input: ${msg['type']} ${msg.entries.where((e) => e.key != 'type').map((e) => '${e.key}=${e.value}').join(' ')}');
    } catch (_) {
      _log('Malformed control message: $line');
    }
  }

  void _handleScreenClient(Socket client) {
    _log('Viewer connected: ${client.remoteAddress.address}');
    _screenClients.add(client);
    client.done.then((_) {
      _screenClients.remove(client);
      _log('Viewer disconnected: ${client.remoteAddress.address}');
    }).catchError((_) {
      _screenClients.remove(client);
    });
  }

  Future<void> _broadcastFrame() async {
    if (_screenClients.isEmpty) return;
    final provider = frameProvider ?? _placeholderFrame;
    final Uint8List jpeg;
    try {
      jpeg = await provider();
    } catch (e) {
      _log('Frame capture failed: $e');
      return;
    }
    final header = ByteData(4)..setUint32(0, jpeg.length, Endian.big);
    final packet = Uint8List.fromList([...header.buffer.asUint8List(), ...jpeg]);
    for (final client in List<Socket>.from(_screenClients)) {
      try {
        client.add(packet);
      } catch (_) {
        _screenClients.remove(client);
      }
    }
  }

  /// A 1x1 black JPEG, used only until a real frameProvider is supplied.
  Future<Uint8List> _placeholderFrame() async {
    return Uint8List.fromList(const [
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0xFF, 0xD9,
    ]);
  }

  Future<void> stop() async {
    _broadcastTimer?.cancel();
    _broadcastTimer = null;
    for (final c in _screenClients) {
      c.destroy();
    }
    _screenClients.clear();
    await _screenServer?.close();
    await _controlServer?.close();
    _screenServer = null;
    _controlServer = null;
    _log('Server stopped');
  }

  void dispose() {
    stop();
    _logController.close();
  }
}
