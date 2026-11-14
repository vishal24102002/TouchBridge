import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'discovery_service.dart';
import 'security_service.dart' show ChatMessage;

/// -----------------------------------------------------------------------
/// WIRE PROTOCOL — matches server.py exactly.
/// -----------------------------------------------------------------------
/// Every channel below is TLS-wrapped over a self-signed cert (see
/// security.py). This client pins the cert's SHA-256 fingerprint on first
/// connect (trust-on-first-use, same model SSH uses) and refuses to
/// proceed if a LATER connection to the same host presents a different
/// one — see CertPinStore.
///
/// Pairing (port 9997) — one JSON line out, one JSON line back:
///   -> {"password":"...","label":"My Phone"}\n
///   <- {"status":"accepted","token":"..."}\n
///   <- {"status":"denied","reason":"bad_password"|"host_declined_or_timeout"}\n
///
/// Screen (port 8080) — request/response, not a stream:
///   -> "capture:<token>\n"
///   <- latest JPEG/PNG bytes, then the server closes the connection.
///   No data at all comes back if the token is invalid/expired.
///
/// Control (port 9999) — persistent, newline-delimited plain text:
///   -> "AUTH:<token>\n"                      (must be first line)
///   <- "AUTH_FAILED:<reason>\n"               (then closes) OR
///   <- "NOCAP:<description>\n"                (host has no input backend) OR
///   <- "INFO:<id>:<tier>:<display>:<desc>\n"
///   <- "STATUS:GRANTED\n" | "STATUS:VIEW_ONLY\n"
///   <- "CHAT_STATE:on\n" | "CHAT_STATE:off\n"
///   ... then pushed at any time:
///   <- "STATUS:GRANTED\n" / "STATUS:REVOKED\n"
///   <- "CHAT:<label>:<text>\n"
///   <- "CHAT_STATE:on|off\n"
///   <- "CHAT_ERROR:disabled\n"
///   -> "mouse_move_abs:<fx>,<fy>" (preferred; fx/fy are 0.0-1.0 fractions
///      of the screen, computed from where the pointer/touch tip actually
///      is — no accumulated drift) | "mouse_move:<dx>,<dy>" (legacy
///      relative deltas, still supported) | "mouse_click" |
///      "mouse_right_click" | "mouse_double_click" | "key:<text>" |
///      "shortcut:<name>" | "open_browser" | "open_terminal" |
///      "custom:open_folder" | "media_play_pause" | "volume_up" |
///      "volume_mute" | "scroll:<hNotches>,<vNotches>" | "chat:<text>"
/// -----------------------------------------------------------------------

enum ConnectionState { disconnected, connecting, pairing, connected, error }

class PairingDeniedException implements Exception {
  final String reason;
  PairingDeniedException(this.reason);
  @override
  String toString() => 'Pairing denied: $reason';
}

class CertificateChangedException implements Exception {
  final String host;
  CertificateChangedException(this.host);
  @override
  String toString() =>
      'The TLS certificate presented by $host does not match the one pinned on first connect. '
          'This could mean the host reinstalled TouchBridge, or someone is impersonating it.';
}

/// Trust-on-first-use certificate pinning, mirroring what security.py
/// documents as the client-side half of its TOFU model.
class CertPinStore {
  static String _key(String host) => 'cert_pin_$host';

  static Future<String?> get(String host) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_key(host));
  }

  static Future<void> set(String host, String fingerprint) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key(host), fingerprint);
  }

  static Future<void> clear(String host) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key(host));
  }
}

String _sha256Fingerprint(X509Certificate cert) => sha256.convert(cert.der).toString();

/// Opens a TLS connection to [host]:[port], enforcing trust-on-first-use
/// pinning. Throws [CertificateChangedException] if a previously-pinned
/// fingerprint doesn't match what's presented this time.
Future<SecureSocket> connectPinnedTls(String host, int port, {Duration? timeout}) async {
  String? presentedFingerprint;
  CertificateChangedException? mismatch;

  final socket = await SecureSocket.connect(
    host,
    port,
    timeout: timeout,
    onBadCertificate: (cert) {
      // Self-signed certs always fail normal chain validation — that's
      // expected. We do our own trust decision here instead.
      presentedFingerprint = _sha256Fingerprint(cert);
      return true; // don't let dart:io reject the handshake itself
    },
  );

  final fp = presentedFingerprint ?? _sha256Fingerprint(socket.peerCertificate!);
  final pinned = await CertPinStore.get(host);
  if (pinned == null) {
    await CertPinStore.set(host, fp);
  } else if (pinned != fp) {
    mismatch = CertificateChangedException(host);
  }

  if (mismatch != null) {
    socket.destroy();
    throw mismatch;
  }
  return socket;
}

// ───────────────────────────────────────────────────────────────────────
// Pairing client
// ───────────────────────────────────────────────────────────────────────
class PairingClient {
  /// Connects to the pairing port, sends the password + a friendly label,
  /// and waits (up to ~70s — the host's own accept window plus slack) for
  /// the host to Accept, Deny, or time out. Returns the session token.
  Future<String> pair(
      String host,
      int pairPort,
      String password,
      String label, {
        Duration connectTimeout = const Duration(seconds: 6),
        Duration decisionTimeout = const Duration(seconds: 70),
      }) async {
    final socket = await connectPinnedTls(host, pairPort, timeout: connectTimeout);
    try {
      socket.add(utf8.encode('${jsonEncode({'password': password, 'label': label})}\n'));
      await socket.flush();

      final buf = BytesBuilder(copy: false);
      final completer = Completer<void>();
      final sub = socket.listen(
        buf.add,
        onDone: () => completer.complete(),
        onError: (_) => completer.complete(),
        cancelOnError: true,
      );
      await completer.future.timeout(decisionTimeout, onTimeout: () {});
      await sub.cancel();

      final text = utf8.decode(buf.toBytes(), allowMalformed: true).trim();
      if (text.isEmpty) throw PairingDeniedException('no_response');
      final payload = jsonDecode(text) as Map<String, dynamic>;
      if (payload['status'] == 'accepted') {
        return payload['token'] as String;
      }
      throw PairingDeniedException((payload['reason'] ?? 'denied') as String);
    } finally {
      socket.destroy();
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Screen channel — polls a fresh TLS connection per frame, same cadence
// as before, now carrying the session token.
// ───────────────────────────────────────────────────────────────────────
class ScreenFrameClient {
  String? _host;
  int? _port;
  String? _token;
  Timer? _pollTimer;
  bool _requestInFlight = false;

  final _frameController = StreamController<Uint8List>.broadcast();
  final _stateController = StreamController<ConnectionState>.broadcast();

  Stream<Uint8List> get frames => _frameController.stream;
  Stream<ConnectionState> get connectionState => _stateController.stream;

  Future<void> connect(
      String host,
      int port,
      String token, {
        Duration pollInterval = const Duration(milliseconds: 200),
        Duration requestTimeout = const Duration(seconds: 6),
      }) async {
    _host = host;
    _port = port;
    _token = token;
    _stateController.add(ConnectionState.connecting);

    final firstFrame = await _requestFrame(requestTimeout);
    if (firstFrame == null) {
      _stateController.add(ConnectionState.error);
      throw Exception('Could not reach $host:$port');
    }
    _frameController.add(firstFrame);
    _stateController.add(ConnectionState.connected);

    _pollTimer = Timer.periodic(pollInterval, (_) async {
      if (_requestInFlight) return;
      _requestInFlight = true;
      final frame = await _requestFrame(requestTimeout);
      _requestInFlight = false;
      if (frame != null) _frameController.add(frame);
    });
  }

  Future<Uint8List?> _requestFrame(Duration timeout) async {
    SecureSocket? socket;
    try {
      socket = await connectPinnedTls(_host!, _port!, timeout: timeout);
      socket.add(utf8.encode('capture:$_token\n'));
      await socket.flush();

      final chunks = BytesBuilder(copy: false);
      final completer = Completer<void>();
      final sub = socket.listen(
        chunks.add,
        onDone: () => completer.complete(),
        onError: (_) => completer.complete(),
        cancelOnError: true,
      );
      await completer.future.timeout(timeout, onTimeout: () {});
      await sub.cancel();

      final bytes = chunks.toBytes();
      return bytes.isEmpty ? null : bytes;
    } catch (_) {
      return null;
    } finally {
      socket?.destroy();
    }
  }

  void disconnect() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _stateController.add(ConnectionState.disconnected);
  }

  void dispose() {
    disconnect();
    _frameController.close();
    _stateController.close();
  }
}

// ───────────────────────────────────────────────────────────────────────
// Control channel
// ───────────────────────────────────────────────────────────────────────
class ControlChannelClient {
  SecureSocket? _socket;
  StreamSubscription<Uint8List>? _sub;
  final _lineBuf = StringBuffer();

  /// True once the host has explicitly granted this device control
  /// (STATUS:GRANTED). Starts false — every device connects view-only.
  bool allowed = false;

  /// Host's reported input-capability tier + description, from the INFO
  /// handshake line — surfaced in the UI so "why can't I click anything"
  /// has an answer when the host genuinely has no input backend.
  String? capabilityTier;
  String? capabilityDescription;

  final _statusController = StreamController<bool>.broadcast(); // true=granted
  final _chatController = StreamController<ChatMessage>.broadcast();
  final _chatStateController = StreamController<bool>.broadcast();
  final _errorController = StreamController<String>.broadcast();

  Stream<bool> get onGrantChanged => _statusController.stream;
  Stream<ChatMessage> get onChat => _chatController.stream;
  Stream<bool> get onChatStateChanged => _chatStateController.stream;
  Stream<String> get onError => _errorController.stream;

  Future<void> connect(String host, int port, String token,
      {Duration timeout = const Duration(seconds: 8)}) async {
    allowed = false;
    final socket = await connectPinnedTls(host, port, timeout: timeout);
    _socket = socket;

    final handshakeDone = Completer<void>();
    var gotInfo = false, gotStatus = false, gotChatState = false;

    _sub = socket.listen(
          (chunk) {
        _lineBuf.write(utf8.decode(chunk, allowMalformed: true));
        var content = _lineBuf.toString();
        int nl;
        while ((nl = content.indexOf('\n')) != -1) {
          final line = content.substring(0, nl).trim();
          content = content.substring(nl + 1);
          if (line.isNotEmpty) _handleLine(line);
          if (!handshakeDone.isCompleted && (line.startsWith('INFO:'))) gotInfo = true;
          if (!handshakeDone.isCompleted && line.startsWith('STATUS:')) gotStatus = true;
          if (!handshakeDone.isCompleted && line.startsWith('CHAT_STATE:')) gotChatState = true;
          if (!handshakeDone.isCompleted &&
              (line.startsWith('AUTH_FAILED:') || line.startsWith('NOCAP:'))) {
            _errorController.add(line);
            if (!handshakeDone.isCompleted) handshakeDone.complete();
          }
        }
        _lineBuf
          ..clear()
          ..write(content);
        if (!handshakeDone.isCompleted && gotInfo && gotStatus && gotChatState) {
          handshakeDone.complete();
        }
      },
      onDone: () {
        allowed = false;
        if (!handshakeDone.isCompleted) handshakeDone.complete();
      },
      onError: (_) {
        if (!handshakeDone.isCompleted) handshakeDone.complete();
      },
    );

    socket.add(utf8.encode('AUTH:$token\n'));
    await socket.flush();

    await handshakeDone.future.timeout(timeout, onTimeout: () {});
  }

  void _handleLine(String line) {
    if (line.startsWith('INFO:')) {
      final parts = line.split(':');
      if (parts.length >= 5) {
        capabilityTier = parts[2];
        capabilityDescription = parts.sublist(4).join(':');
      }
    } else if (line == 'STATUS:GRANTED') {
      allowed = true;
      _statusController.add(true);
    } else if (line == 'STATUS:VIEW_ONLY' || line == 'STATUS:REVOKED') {
      allowed = false;
      _statusController.add(false);
    } else if (line.startsWith('CHAT_STATE:')) {
      final on = line.substring('CHAT_STATE:'.length) == 'on';
      _chatStateController.add(on);
    } else if (line.startsWith('CHAT_ERROR:')) {
      _errorController.add(line);
    } else if (line.startsWith('CHAT:')) {
      final rest = line.substring('CHAT:'.length);
      final sep = rest.indexOf(':');
      if (sep != -1) {
        final from = rest.substring(0, sep);
        final text = rest.substring(sep + 1);
        _chatController.add(ChatMessage(from: from, text: text, time: DateTime.now()));
      }
    } else if (line.startsWith('AUTH_FAILED:') || line.startsWith('NOCAP:')) {
      _errorController.add(line);
    }
  }

  void _send(String command) => _socket?.add(utf8.encode('$command\n'));

  /// Preferred over sendMouseMoveRelative: [fx]/[fy] are 0.0-1.0 fractions
  /// of the screen, computed from wherever the pointer/touch currently is
  /// within the displayed remote frame. Every call is independently
  /// correct — there's no accumulated delta to drift out of sync over a
  /// session, unlike relative movement.
  void sendMouseMoveAbsolute(double fx, double fy) {
    if (!allowed) return;
    final cfx = fx.clamp(0.0, 1.0);
    final cfy = fy.clamp(0.0, 1.0);
    _send('mouse_move_abs:${cfx.toStringAsFixed(4)},${cfy.toStringAsFixed(4)}');
  }

  /// Legacy relative movement — still supported host-side, but prefer
  /// sendMouseMoveAbsolute wherever the caller can compute a fractional
  /// on-image position (i.e. anywhere there's a displayed frame to
  /// measure against).
  void sendMouseMoveRelative(int dx, int dy) {
    if (!allowed) return;
    _send('mouse_move:$dx,$dy');
  }

  void sendClick() {
    if (allowed) _send('mouse_click');
  }

  void sendRightClick() {
    if (allowed) _send('mouse_right_click');
  }

  void sendDoubleClick() {
    if (allowed) _send('mouse_double_click');
  }

  void sendText(String text) {
    if (allowed) _send('key:$text');
  }

  void sendShortcut(String name) {
    if (allowed) _send('shortcut:$name');
  }

  void openBrowser() {
    if (allowed) _send('open_browser');
  }

  void openTerminal() {
    if (allowed) _send('open_terminal');
  }

  void openFolder() {
    if (allowed) _send('custom:open_folder');
  }

  void mediaPlayPause() {
    if (allowed) _send('media_play_pause');
  }

  void volumeUp() {
    if (allowed) _send('volume_up');
  }

  void volumeMute() {
    if (allowed) _send('volume_mute');
  }

  /// [hNotches]/[vNotches] are small integer scroll "notches" (positive
  /// vertical = scroll down), not raw platform-specific wheel deltas —
  /// normalize whatever gesture/scroll input you have to roughly this
  /// scale before calling.
  void sendScroll(int hNotches, int vNotches) {
    if (allowed) _send('scroll:$hNotches,$vNotches');
  }

  /// Chat is NOT gated by the control grant — any paired, connected
  /// device may send a message as long as the host has chat turned on.
  void sendChat(String text) => _send('chat:$text');

  void disconnect() {
    _sub?.cancel();
    _sub = null;
    _socket?.destroy();
    _socket = null;
    allowed = false;
  }

  void dispose() {
    disconnect();
    _statusController.close();
    _chatController.close();
    _chatStateController.close();
    _errorController.close();
  }
}

// ───────────────────────────────────────────────────────────────────────
// Bundles pairing + both channels for one remote session (Client Mode).
// ───────────────────────────────────────────────────────────────────────
class RemoteSession {
  final ScreenFrameClient screen = ScreenFrameClient();
  final ControlChannelClient control = ControlChannelClient();
  final PairingClient _pairing = PairingClient();

  String? token;

  /// Full flow: pair (password + wait for host accept) -> open screen +
  /// control channels with the resulting token. Throws
  /// [PairingDeniedException] if the host denies or the request times
  /// out, or [CertificateChangedException] if the pinned cert changed.
  Future<void> connect(
      String host,
      int screenPort,
      int controlPort,
      int pairPort,
      String password,
      String label,
      ) async {
    token = await _pairing.pair(host, pairPort, password, label);
    await screen.connect(host, screenPort, token!);
    await control.connect(host, controlPort, token!);
  }

  /// Resolves a 9-digit Device ID to an IP over the local network.
  static Future<String?> resolveDeviceId(String deviceId) async {
    final result = await DiscoveryResolver().resolveId(deviceId);
    return result?.ip;
  }

  void disconnect() {
    screen.disconnect();
    control.disconnect();
  }

  void dispose() {
    screen.dispose();
    control.dispose();
  }
}