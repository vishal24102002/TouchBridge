import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'discovery_service.dart';
import 'input_injection_channel.dart';
import 'security_service.dart';

/// -----------------------------------------------------------------------
/// SCREEN CAPTURE & INPUT INJECTION ON ANDROID
/// -----------------------------------------------------------------------
/// Both use native platform channels — there's no pure-Dart API for
/// either:
///   - Screen capture: Android's MediaProjection API, via
///     screen_capture_channel.dart + MainActivity.kt/ScreenCaptureService.kt.
///     Pass `ScreenCaptureChannel.getLatestFrame` as `frameProvider`
///     (server_screen.dart does this).
///   - Input injection: an AccessibilityService, via
///     input_injection_channel.dart + MainActivity.kt/
///     TouchBridgeAccessibilityService.kt. Unlike screen capture the user
///     must manually enable it in Settings > Accessibility — Android
///     won't let an app request it as a runtime permission dialog — so
///     `refreshInputCapability()` is meant to be re-polled (e.g. on app
///     resume) rather than checked once at startup.
/// Everything else — TLS, pairing, tokens, per-device control grants,
/// chat — matches server.py exactly.
/// -----------------------------------------------------------------------
class HostServerService {
  final DeviceIdentity identity = DeviceIdentity();
  final PairingManager pairingManager = PairingManager();
  final ControlSession controlSession = ControlSession();
  final ChatState chatState = ChatState();
  final DiscoveryResponder _discovery = DiscoveryResponder();

  SecureServerSocket? _pairServer;
  SecureServerSocket? _screenServer;
  SecureServerSocket? _controlServer;
  SecurityContext? _tlsContext;
  Timer? _broadcastTimer;

  bool _inputReady = false;

  final _frameBuffer = _FrameBuffer();
  final _logController = StreamController<String>.broadcast();
  final _chatController = StreamController<ChatMessage>.broadcast();

  Stream<String> get logs => _logController.stream;
  Stream<ChatMessage> get chatMessages => _chatController.stream;
  Stream<List<Map<String, dynamic>>> get pendingRequests => pairingManager.onPendingChanged;
  Stream<List<Map<String, dynamic>>> get connectedClients => controlSession.onClientsChanged;
  Stream<bool> get chatEnabledChanges => chatState.onChanged;

  bool get isRunning => _screenServer != null || _controlServer != null;
  bool get chatEnabled => chatState.enabled;

  /// Whether remote input will actually do something right now (i.e. the
  /// AccessibilityService is enabled). Cached — call refreshInputCapability()
  /// after the user comes back from Settings to update it.
  bool get inputReady => _inputReady;

  /// Re-checks whether the AccessibilityService is currently enabled.
  /// Doesn't gate anything by itself — existing control connections keep
  /// working either way, this only changes what capability tier/
  /// description NEW connections are told about in the INFO handshake
  /// line, and what server_screen.dart shows in its status panel.
  Future<void> refreshInputCapability() async {
    _inputReady = await InputInjectionChannel.isReady();
  }

  /// Supplies the next screen frame as JPEG bytes, or null if none is
  /// ready yet (e.g. capture just started). Defaults to a 1x1 placeholder
  /// if not supplied — pass ScreenCaptureChannel.getLatestFrame for real
  /// MediaProjection-backed capture (see screen_capture_channel.dart).
  final Future<Uint8List?> Function()? frameProvider;

  HostServerService({this.frameProvider});

  void _log(String message) {
    final ts = DateTime.now().toIso8601String().substring(11, 19);
    _logController.add('[$ts] $message');
  }

  /// client.add(bytes) only QUEUES data — it does not wait for it to
  /// actually be written (TLS-encrypted and pushed to the OS socket)
  /// before returning. Calling client.destroy() right after add(), with
  /// no flush() in between, can and does truncate whatever hasn't made
  /// it out yet. This was silently cutting screen frames short (a
  /// partial JPEG — readable at the top, blank/corrupt past whatever had
  /// flushed by the time destroy() ran) and could equally have
  /// truncated pairing JSON or AUTH_FAILED lines. Every close-after-write
  /// in this file goes through here now instead of calling
  /// client.destroy() directly.
  Future<void> _flushAndDestroy(SecureSocket client) async {
    try {
      await client.flush();
    } catch (_) {
      // Connection already broken on the other end — nothing left to
      // flush, and destroy() below is a no-op safety net either way.
    }
    client.destroy();
  }

  Future<void> init() async {
    await identity.load();
    await refreshInputCapability();
  }

  Future<void> start({
    required int screenPort,
    required int controlPort,
    int pairPort = 9997,
    Duration frameInterval = const Duration(milliseconds: 200),
  }) async {
    if (isRunning) return;
    if (identity.deviceId.isEmpty) await identity.load();

    _tlsContext = await TlsCertificate.ensureServerContext();

    _pairServer = await SecureServerSocket.bind(
        InternetAddress.anyIPv4, pairPort, _tlsContext!);
    _log('Pairing server listening on :$pairPort (TLS)');
    _pairServer!.listen(_handlePairingClient);

    _controlServer = await SecureServerSocket.bind(
        InternetAddress.anyIPv4, controlPort, _tlsContext!);
    _log('Control channel listening on :$controlPort (TLS)');
    _controlServer!.listen(_handleControlClient);

    _screenServer = await SecureServerSocket.bind(
        InternetAddress.anyIPv4, screenPort, _tlsContext!);
    _log('Screen channel listening on :$screenPort (TLS)');
    _screenServer!.listen(_handleScreenClient);

    await _discovery.start(identity.deviceId, 'Android Device');
    _log('Discovery responder listening (device id ${identity.deviceId})');

    _broadcastTimer = Timer.periodic(frameInterval, (_) => _captureFrame());
  }

  // ── Pairing (port 9997) ────────────────────────────────────────────────
  Future<void> _handlePairingClient(SecureSocket client) async {
    final addr = client.remoteAddress.address;
    try {
      final buf = BytesBuilder(copy: false);
      final gotLine = Completer<void>();
      late StreamSubscription sub;
      sub = client.listen(
            (data) {
          buf.add(data);
          if (utf8.decode(buf.toBytes(), allowMalformed: true).contains('\n') &&
              !gotLine.isCompleted) {
            gotLine.complete();
          }
        },
        onDone: () {
          if (!gotLine.isCompleted) gotLine.complete();
        },
        onError: (_) {
          if (!gotLine.isCompleted) gotLine.complete();
        },
      );
      await gotLine.future.timeout(const Duration(seconds: 10), onTimeout: () {});
      await sub.cancel();

      final raw = utf8.decode(buf.toBytes(), allowMalformed: true);
      final line = raw.split('\n').first.trim();
      Map<String, dynamic> payload;
      try {
        payload = jsonDecode(line) as Map<String, dynamic>;
      } catch (_) {
        client.add(utf8.encode('${jsonEncode({
          'status': 'denied',
          'reason': 'bad_request'
        })}\n'));
        return;
      }

      final password = (payload['password'] ?? '') as String;
      final label = ((payload['label'] ?? addr) as String).trim().isEmpty
          ? addr
          : (payload['label'] as String).substring(0, (payload['label'] as String).length.clamp(0, 64));

      if (!identity.checkPassword(password)) {
        client.add(utf8.encode('${jsonEncode({
          'status': 'denied',
          'reason': 'bad_password'
        })}\n'));
        _log('Pairing rejected for $addr ($label) — wrong password');
        return;
      }

      _log('Pairing request from $addr ($label) — waiting for host to accept/deny');
      final token = await pairingManager.request(addr, label);
      if (token != null) {
        client.add(utf8.encode('${jsonEncode({
          'status': 'accepted',
          'token': token
        })}\n'));
        _log('Pairing accepted for $addr ($label)');
      } else {
        client.add(utf8.encode('${jsonEncode({
          'status': 'denied',
          'reason': 'host_declined_or_timeout'
        })}\n'));
        _log('Pairing denied or timed out for $addr ($label)');
      }
    } catch (e) {
      _log('[ERR] pairing client $addr: $e');
    } finally {
      await _flushAndDestroy(client);
    }
  }

  // ── Screen channel (port 8080) ─────────────────────────────────────────
  Future<void> _handleScreenClient(SecureSocket client) async {
    final addr = client.remoteAddress.address;
    try {
      final buf = BytesBuilder(copy: false);
      final gotLine = Completer<void>();
      late StreamSubscription sub;
      sub = client.listen(
            (data) {
          buf.add(data);
          if (!gotLine.isCompleted) gotLine.complete();
        },
        onDone: () {
          if (!gotLine.isCompleted) gotLine.complete();
        },
        onError: (_) {
          if (!gotLine.isCompleted) gotLine.complete();
        },
      );
      await gotLine.future.timeout(const Duration(seconds: 5), onTimeout: () {});
      await sub.cancel();

      final request = utf8.decode(buf.toBytes(), allowMalformed: true).trim();
      final token = request.startsWith('capture:') ? request.substring('capture:'.length) : '';
      if (!pairingManager.validate(token)) {
        _log('[ERR] screen client $addr sent an invalid/expired session token');
        return;
      }
      final data = _frameBuffer.get();
      if (data != null) client.add(data);
    } catch (e) {
      _log('[ERR] screen client $addr: $e');
    } finally {
      await _flushAndDestroy(client);
    }
  }

  // ── Control channel (port 9999) ────────────────────────────────────────
  // Everything — the AUTH handshake and every command afterward — is
  // handled inside ONE client.listen() call. SecureSocket is a
  // single-subscription stream: listening, cancelling, then listening
  // again (the old approach) throws a StateError on the second listen,
  // which silently killed the command handler that chat/input messages
  // from the CLIENT depend on, while the host's own outgoing chat still
  // worked fine (it doesn't read from the socket at all).
  void _handleControlClient(SecureSocket client) {
    final addr = client.remoteAddress.address;
    var authenticated = false;
    int? cid;
    String label = addr;
    var lineBuf = '';

    final authTimeout = Timer(const Duration(seconds: 10), () {
      if (!authenticated) {
        client.add(utf8.encode('AUTH_FAILED:timeout\n'));
        _flushAndDestroy(client);
        _log('Control client $addr rejected — no AUTH line within 10s');
      }
    });

    client.listen(
          (data) {
        lineBuf += utf8.decode(data, allowMalformed: true);
        while (lineBuf.contains('\n')) {
          final idx = lineBuf.indexOf('\n');
          final line = lineBuf.substring(0, idx).trim();
          lineBuf = lineBuf.substring(idx + 1);
          if (line.isEmpty) continue;

          if (!authenticated) {
            authTimeout.cancel();
            final token = line.startsWith('AUTH:') ? line.substring('AUTH:'.length) : '';
            if (!pairingManager.validate(token)) {
              client.add(utf8.encode('AUTH_FAILED:invalid_or_expired_token\n'));
              _flushAndDestroy(client);
              _log('Control client $addr rejected — invalid/missing session token');
              return;
            }

            // Reflects whatever refreshInputCapability() last found —
            // real input execution via AccessibilityService if enabled,
            // otherwise a clear explanation of why remote taps/typing
            // won't do anything yet (see input_injection_channel.dart).
            final tier = _inputReady ? 'full' : 'limited';
            final description = _inputReady
                ? 'Full remote input via AccessibilityService.'
                : 'View only — enable TouchBridge\'s Accessibility Service on this device (Settings > Accessibility) to allow remote input.';

            label = pairingManager.labelFor(token);
            cid = controlSession.register(client, addr, label: label);
            authenticated = true;
            _log('Control client connected: $addr (id=$cid, label=$label, tier=$tier)');

            client.add(utf8.encode('INFO:$cid:$tier:android:$description\n'));
            client.add(utf8.encode(
                controlSession.isController(cid!) ? 'STATUS:GRANTED\n' : 'STATUS:VIEW_ONLY\n'));
            client.add(utf8.encode('CHAT_STATE:${chatState.enabled ? 'on' : 'off'}\n'));
          } else {
            _handleControlLine(cid!, addr, label, line, client);
          }
        }
      },
      onDone: () {
        authTimeout.cancel();
        if (cid != null) {
          controlSession.unregister(cid!);
          _log('Control client disconnected: $addr (id=$cid)');
        }
      },
      onError: (_) {
        authTimeout.cancel();
        if (cid != null) controlSession.unregister(cid!);
      },
      cancelOnError: true,
    );
  }

  void _handleControlLine(int cid, String addr, String label, String cmd, SecureSocket client) {
    if (cmd.startsWith('chat:')) {
      final text = cmd.substring('chat:'.length);
      if (!chatState.enabled) {
        try {
          client.add(utf8.encode('CHAT_ERROR:disabled\n'));
        } catch (_) {}
        return;
      }
      controlSession.broadcast('CHAT:$label:$text\n', excludeId: cid);
      final msg = ChatMessage(from: label, text: text, time: DateTime.now());
      _chatController.add(msg);
      return;
    }

    if (!controlSession.isController(cid)) {
      _log('[BLOCKED] $addr (id=$cid) sent "$cmd" without control grant');
      return;
    }
    _handleCommand(cmd);
  }

  /// Forwards the command to the native AccessibilityService for actual
  /// execution (tap/drag dispatch, text injection, shortcuts — see
  /// TouchBridgeAccessibilityService.kt). Fire-and-forget: if the service
  /// isn't enabled, the native side just drops it, which is why the INFO
  /// handshake line already told the client this tier is 'limited' —
  /// this isn't the place to surface that per-command.
  void _handleCommand(String cmd) {
    _log('Input: $cmd');
    InputInjectionChannel.sendCommand(cmd);
  }

  Future<void> _captureFrame() async {
    final provider = frameProvider ?? _placeholderFrame;
    try {
      final jpeg = await provider();
      if (jpeg != null) _frameBuffer.set(jpeg);
      // null just means "nothing new yet" (e.g. capture still starting
      // up) — keep serving the last good frame rather than blanking out.
    } catch (e) {
      _log('Frame capture failed: $e');
    }
  }

  Future<Uint8List> _placeholderFrame() async {
    return Uint8List.fromList(const [
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0xFF, 0xD9,
    ]);
  }

  // ── UI-facing controls (equivalent of server.py's loopback admin port —
  //    same process here, so these are just direct method calls) ─────────
  bool grantControl(int clientId) => controlSession.grant(clientId);
  void revokeControl() => controlSession.revokeAll();
  bool acceptPairing(int requestId) => pairingManager.decide(requestId, true);
  bool denyPairing(int requestId) => pairingManager.decide(requestId, false);

  Future<String> regeneratePassword() => identity.regeneratePassword();
  Future<void> setPassword(String pw) => identity.setPassword(pw);
  Map<String, String> deviceInfo() => identity.info();

  void setChatEnabled(bool enabled) {
    chatState.set(enabled);
    controlSession.broadcast('CHAT_STATE:${enabled ? 'on' : 'off'}\n');
    _log('Chat ${enabled ? 'enabled' : 'disabled'} by host');
  }

  /// Host's own outgoing chat message, broadcast to every connected client.
  bool sendHostChat(String text) {
    if (!chatState.enabled) return false;
    controlSession.broadcast('CHAT:Host:$text\n');
    _chatController.add(ChatMessage(from: 'Host', text: text, time: DateTime.now(), isMe: true));
    return true;
  }

  Future<void> stop() async {
    _broadcastTimer?.cancel();
    _broadcastTimer = null;
    controlSession.revokeAll();
    _discovery.stop();
    await _pairServer?.close();
    await _screenServer?.close();
    await _controlServer?.close();
    _pairServer = null;
    _screenServer = null;
    _controlServer = null;
    _log('Server stopped');
  }

  void dispose() {
    stop();
    _logController.close();
    _chatController.close();
  }
}

class _FrameBuffer {
  Uint8List? _data;
  void set(Uint8List data) => _data = data;
  Uint8List? get() => _data;
}