import 'dart:async';
import 'dart:collection';
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
///     JPEG mode: pass `ScreenCaptureChannel.getLatestFrameIfNew` as
///     `frameProvider` (polled). H.264 mode (default): pass
///     `ScreenCaptureChannel.videoFrames` as `videoFrames` (pushed).
///     server_screen.dart wires up both; the native side only ever produces
///     one of them at a time, chosen in Settings.
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

  final _screenHub = _ScreenHub();
  StreamSubscription<Uint8List>? _videoSub;
  StreamSubscription<Uint8List>? _audioSub;
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

  /// Frames pushed by the capture side, in order: H.264 access units in
  /// TouchBridge wire format ("TBH4" + flag byte + Annex-B) or JPEG/PNG images.
  /// When supplied, [frameProvider] polling is not used.
  final Stream<Uint8List>? videoFrames;

  /// Called when a viewer fell behind and needs a fresh keyframe to resync.
  final Future<void> Function()? requestKeyframe;

  /// Optional shared-audio chunks ("TBA1" + channels + rate + PCM16LE), pushed
  /// by the capture side. Relayed to every viewer on the same connection as the
  /// video, in a lane of its own so audio never disturbs the picture.
  final Stream<Uint8List>? audioFrames;

  HostServerService({this.frameProvider, this.videoFrames, this.requestKeyframe, this.audioFrames}) {
    _screenHub.onNeedKeyframe = () => requestKeyframe?.call();
  }

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

    _audioSub = audioFrames?.listen(_screenHub.publishAudio, onError: (_) {});

    if (videoFrames != null) {
      // Push mode (H.264 AND JPEG): the native side delivers every frame as it
      // is produced — no polling, so no added delay and no repeated frames.
      _videoSub = videoFrames!.listen(_screenHub.publish, onError: (_) {});
      // The encoder started before we were listening, so its first keyframe
      // went nowhere — ask for a fresh one so the first viewer isn't left
      // waiting for the next scheduled keyframe.
      requestKeyframe?.call();
    } else {
      _broadcastTimer = Timer.periodic(frameInterval, (_) => _captureFrame());
    }
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
  // Two request styles, same as server.py:
  //   "stream:<token>\n"  persistent: [4-byte big-endian length][payload]
  //                       repeated (zero length = keepalive). Payload is a
  //                       JPEG/PNG image (newest only) or an H.264 access unit
  //                       ("TBH4" + flag byte + Annex-B; every frame, in
  //                       order, starting at a keyframe) — see _ScreenHub.
  //   "capture:<token>\n" legacy one-shot: the newest JPEG, then close.
  Future<void> _handleScreenClient(SecureSocket client) async {
    final addr = client.remoteAddress.address;
    var streaming = false;
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
      final sep = request.indexOf(':');
      final mode = sep < 0 ? '' : request.substring(0, sep);
      final token = sep < 0 ? '' : request.substring(sep + 1);
      if ((mode != 'capture' && mode != 'stream') || !pairingManager.validate(token)) {
        _log('[ERR] screen client $addr sent an invalid request or expired session token');
        return;
      }

      if (mode == 'capture') {
        final data = _screenHub.latestImage;
        if (data != null) client.add(data);
        return;
      }

      streaming = true;
      _log('Viewer streaming: $addr');
      await _screenHub.serve(client, () => pairingManager.validate(token));
      _log('Viewer stream ended: $addr');
    } catch (e) {
      _log('[ERR] screen client $addr: $e');
    } finally {
      if (streaming) {
        client.destroy();
      } else {
        await _flushAndDestroy(client);
      }
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
    if (cmd.startsWith('chat:') || cmd.startsWith('chat-host:')) {
      // chat:<text> goes to everyone; chat-host:<text> to the host only.
      final hostOnly = cmd.startsWith('chat-host:');
      final text = cmd.substring(cmd.indexOf(':') + 1);
      if (!chatState.enabled) {
        try {
          client.add(utf8.encode('CHAT_ERROR:disabled\n'));
        } catch (_) {}
        return;
      }
      if (!hostOnly) controlSession.broadcast('CHAT:$label:$text\n', excludeId: cid);
      final msg = ChatMessage(from: label, text: text, time: DateTime.now(), hostOnly: hostOnly);
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
      if (jpeg != null) _screenHub.publish(jpeg);
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
    await _videoSub?.cancel();
    _videoSub = null;
    await _audioSub?.cancel();
    _audioSub = null;
    _screenHub.closeAll();
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

// ───────────────────────────────────────────────────────────────────────
// Screen frame fan-out to streaming viewers.
//
// Payload kinds (see the module docs above):
//   * JPEG/PNG — every frame stands alone, so a slow viewer only ever gets
//     the newest one (frames are skipped, latency stays flat).
//   * H.264 — every delta frame depends on the previous one, so frames can't
//     simply be skipped. The hub caches the frames since the last keyframe
//     (the "GOP"): a new viewer starts from that keyframe, and a viewer that
//     falls too far behind abandons the rest of the GOP and waits for the next
//     keyframe (asking the encoder for one) instead of decoding garbage.
// ───────────────────────────────────────────────────────────────────────
bool _isH264Payload(Uint8List p) =>
    p.length > 5 && p[0] == 0x54 && p[1] == 0x42 && p[2] == 0x48 && p[3] == 0x34;
bool _isH264Key(Uint8List p) => _isH264Payload(p) && (p[4] & 1) == 1;
bool _isAudioPayload(Uint8List p) =>
    p.length > 9 && p[0] == 0x54 && p[1] == 0x42 && p[2] == 0x41 && p[3] == 0x31;

class _ScreenHub {
  static const _maxGopFrames = 900;
  static const _maxBacklog = 20;
  static const _sendTimeout = Duration(seconds: 5);
  static const _keepalive = Duration(seconds: 5);
  static const _revalidate = Duration(seconds: 2);

  final List<_Viewer> _viewers = [];
  final List<Uint8List> _gop = [];
  Uint8List? latestImage;

  void Function()? onNeedKeyframe;

  void publish(Uint8List frame) {
    if (_isH264Payload(frame)) {
      final key = _isH264Key(frame);
      if (key) {
        _gop
          ..clear()
          ..add(frame);
      } else if (_gop.isNotEmpty) {
        if (_gop.length >= _maxGopFrames) {
          _gop.clear(); // encoder stopped sending keyframes; wait for the next
          return;
        }
        _gop.add(frame);
      } else {
        return; // delta frame without a keyframe to hang it on
      }
    } else {
      _gop.clear();
      latestImage = frame;
    }
    for (final v in List<_Viewer>.of(_viewers)) {
      v.offer(frame);
    }
  }

  /// Audio goes to every viewer immediately; a viewer that can't keep up simply
  /// loses the oldest chunks (a gap beats growing delay).
  void publishAudio(Uint8List chunk) {
    for (final v in List<_Viewer>.of(_viewers)) {
      v.offerAudio(chunk);
    }
  }

  /// Streams to [socket] until it closes, errors, or the token stops being valid.
  Future<void> serve(SecureSocket socket, bool Function() tokenValid) async {
    final viewer = _Viewer(socket, this);
    // Start from the latest keyframe (H.264) or the newest image.
    if (_gop.isNotEmpty) {
      viewer.queue.addAll(_gop);
    } else if (latestImage != null) {
      viewer.queue.add(latestImage!);
    }
    _viewers.add(viewer);
    // Nothing cached yet (e.g. the encoder's first keyframe was missed): make
    // the encoder produce one now instead of leaving this viewer blank.
    if (_gop.isEmpty && latestImage == null) onNeedKeyframe?.call();
    viewer.pump();

    final keepalive = Timer.periodic(_keepalive, (_) => viewer.sendKeepaliveIfIdle());
    final check = Timer.periodic(_revalidate, (_) {
      if (!tokenValid()) viewer.close();
    });
    try {
      await viewer.closed;
    } finally {
      keepalive.cancel();
      check.cancel();
      _viewers.remove(viewer);
    }
  }

  void closeAll() {
    for (final v in List<_Viewer>.of(_viewers)) {
      v.close();
    }
    _gop.clear();
    latestImage = null;
  }
}

class _Viewer {
  final SecureSocket socket;
  final _ScreenHub hub;
  final Queue<Uint8List> queue = Queue<Uint8List>();
  final Queue<Uint8List> audioQueue = Queue<Uint8List>();
  static const _maxAudioBacklog = 40;
  final _closed = Completer<void>();
  bool _pumping = false;
  bool _waitKey = false; // dropped some delta frames; hold until the next keyframe
  DateTime _lastSent = DateTime.now();

  _Viewer(this.socket, this.hub);

  Future<void> get closed => _closed.future;

  void offerAudio(Uint8List chunk) {
    if (_closed.isCompleted) return;
    audioQueue.add(chunk);
    while (audioQueue.length > _maxAudioBacklog) {
      audioQueue.removeFirst();
    }
    pump();
  }

  void offer(Uint8List frame) {
    if (_closed.isCompleted) return;
    if (!_isH264Payload(frame)) {
      queue
        ..clear() // images: newest only
        ..add(frame);
      _waitKey = false;
    } else if (_isH264Key(frame)) {
      // A keyframe makes everything queued before it irrelevant if we're behind.
      if (_waitKey || queue.length > _ScreenHub._maxBacklog) queue.clear();
      _waitKey = false;
      queue.add(frame);
    } else {
      if (_waitKey) return;
      queue.add(frame);
      if (queue.length > _ScreenHub._maxBacklog) {
        // Too far behind: drop the rest of this GOP and resync at the next keyframe.
        queue.clear();
        _waitKey = true;
        hub.onNeedKeyframe?.call();
      }
    }
    pump();
  }

  Future<void> pump() async {
    if (_pumping || _closed.isCompleted) return;
    _pumping = true;
    try {
      while ((queue.isNotEmpty || audioQueue.isNotEmpty) && !_closed.isCompleted) {
        // Audio first: it is small and time-critical.
        final frame = audioQueue.isNotEmpty ? audioQueue.removeFirst() : queue.removeFirst();
        final header = Uint8List(4)..buffer.asByteData().setUint32(0, frame.length);
        socket.add(header);
        socket.add(frame);
        // flush() waits until the bytes are really written, which is what
        // gives a slow viewer backpressure (queue grows -> frames dropped).
        await socket.flush().timeout(_ScreenHub._sendTimeout);
        _lastSent = DateTime.now();
      }
    } catch (_) {
      close();
    } finally {
      _pumping = false;
    }
  }

  void sendKeepaliveIfIdle() {
    if (_closed.isCompleted || _pumping) return;
    if (DateTime.now().difference(_lastSent) < _ScreenHub._keepalive) return;
    try {
      socket.add(Uint8List(4)); // zero-length frame
      _lastSent = DateTime.now();
    } catch (_) {
      close();
    }
  }

  void close() {
    if (_closed.isCompleted) return;
    _closed.complete();
    try {
      socket.destroy();
    } catch (_) {}
  }
}
