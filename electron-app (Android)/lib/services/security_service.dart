// Dart port of the Python backend's security.py + the session-management
// classes from server.py (ControlSession, ChatState, the pairing/admin
// wire format). This is what lets Flutter act as a full TouchBridge HOST
// (Server Mode) that a real Electron client — or another Flutter client —
// can pair with, exactly like the Python server does.
//
// Wire protocol this file's server side implements (see server.py):
//   Pairing (TLS):  client sends {"password":"...","label":"..."}\n
//                    server replies {"status":"accepted","token":"..."}\n
//                    or            {"status":"denied","reason":"..."}\n
//                    after blocking on host Accept/Deny (or timeout).
//   Screen  (TLS):   client sends "capture:<token>\n", server writes the
//                    latest JPEG/PNG bytes and closes the connection.
//   Control (TLS):   first line must be "AUTH:<token>\n". On success the
//                    server sends "INFO:<id>:<tier>:<display>:<desc>\n",
//                    then "STATUS:GRANTED\n"/"STATUS:VIEW_ONLY\n", then
//                    "CHAT_STATE:on|off\n". After that: newline-delimited
//                    commands in (only honored while granted), plus
//                    "chat:<text>" which is not gated by the grant.
//
// Requires (add to pubspec.yaml):
//   basic_utils: ^5.8.0      # pure-Dart RSA keypair + self-signed X.509 cert
//   path_provider: ^2.1.0    # persistent per-install config directory
//   shared_preferences: ^2.2.0 (already used elsewhere in the app)
//   crypto: ^3.0.0           # SHA-256 for TLS cert-pinning fingerprints

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:basic_utils/basic_utils.dart';
import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

const int discoveryPort = 47821;
const String discoveryMagic = 'TOUCHBRIDGE_DISCOVER';
const int tokenTtlSeconds = 12 * 60 * 60; // session token good for 12h
const int pairTimeoutSeconds = 60; // how long a pairing request waits

/// Persistent per-install config directory, mirroring security.py's
/// <config_dir> (~/.touchbridge on desktop).
Future<Directory> configDir() async {
  final base = await getApplicationSupportDirectory();
  final dir = Directory('${base.path}/touchbridge');
  if (!await dir.exists()) await dir.create(recursive: true);
  return dir;
}

// ───────────────────────────────────────────────────────────────────────
// Device identity — persistent 9-digit ID + a password. Defaults to a
// random 6-character code (TeamViewer/AnyDesk-style); host can change or
// regenerate it from Settings / Server Mode.
// ───────────────────────────────────────────────────────────────────────
class DeviceIdentity {
  static const _kId = 'device_id';
  static const _kPassword = 'device_password';

  String deviceId = '';
  String password = '';
  SharedPreferences? _prefs;

  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    deviceId = _prefs!.getString(_kId) ?? '';
    password = _prefs!.getString(_kPassword) ?? '';
    if (deviceId.isEmpty || password.isEmpty) {
      deviceId = _genId();
      password = _genPassword();
      await _save();
    }
  }

  static String _genId() {
    final rng = Random.secure();
    return List.generate(9, (_) => rng.nextInt(10)).join();
  }

  static String _genPassword() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    final rng = Random.secure();
    return List.generate(6, (_) => alphabet[rng.nextInt(alphabet.length)]).join();
  }

  Future<void> _save() async {
    await _prefs!.setString(_kId, deviceId);
    await _prefs!.setString(_kPassword, password);
  }

  Future<String> regeneratePassword() async {
    password = _genPassword();
    await _save();
    return password;
  }

  Future<void> setPassword(String newPassword) async {
    final pw = newPassword.trim();
    if (pw.isEmpty) throw ArgumentError('password cannot be empty');
    password = pw;
    await _save();
  }

  bool checkPassword(String candidate) => candidate == password;

  Map<String, String> info() => {'id': deviceId, 'password': password};
}

// ───────────────────────────────────────────────────────────────────────
// TLS — self-signed cert generated once per install and reused after.
// Not CA-signed (there's no third party to vouch for it, same as
// security.py) — it still encrypts every byte on the wire. The CLIENT
// side is responsible for trust-on-first-use pinning (see
// network_service.dart's CertPinStore); this class only produces the
// server-side cert+key and the SecurityContext to serve it from.
// ───────────────────────────────────────────────────────────────────────
class TlsCertificate {
  static Future<SecurityContext> ensureServerContext() async {
    final dir = await configDir();
    final certFile = File('${dir.path}/cert.pem');
    final keyFile = File('${dir.path}/key.pem');

    if (!await certFile.exists() || !await keyFile.exists()) {
      final pair = CryptoUtils.generateRSAKeyPair(keySize: 2048);
      final privateKey = pair.privateKey as dynamic; // RSAPrivateKey
      final publicKey = pair.publicKey as dynamic; // RSAPublicKey

      final csr = X509Utils.generateRsaCsrPem(
        {'CN': 'TouchBridge'},
        privateKey,
        publicKey,
      );
      final certPem = X509Utils.generateSelfSignedCertificate(
        privateKey,
        csr,
        3650, // days
      );
      final keyPem = CryptoUtils.encodeRSAPrivateKeyToPem(privateKey);

      await certFile.writeAsString(certPem);
      await keyFile.writeAsString(keyPem);
    }

    final ctx = SecurityContext(withTrustedRoots: false);
    ctx.useCertificateChainBytes(await certFile.readAsBytes());
    ctx.usePrivateKeyBytes(await keyFile.readAsBytes());
    return ctx;
  }

  /// SHA-256 fingerprint of our own cert (same format the client pins in
  /// network_service.dart's CertPinStore), shown in Settings so a user can
  /// manually cross-check it — same spirit as security.py's TOFU model.
  static Future<String> fingerprintHex() async {
    final dir = await configDir();
    final certFile = File('${dir.path}/cert.pem');
    if (!await certFile.exists()) return '';
    final pem = await certFile.readAsString();
    // Strip PEM armor and decode the base64 body to get the raw DER bytes,
    // matching exactly what network_service.dart hashes on the client side
    // (X509Certificate.der there is the same DER-encoded certificate).
    final b64 = pem
        .replaceAll('-----BEGIN CERTIFICATE-----', '')
        .replaceAll('-----END CERTIFICATE-----', '')
        .replaceAll(RegExp(r'\s'), '');
    final der = base64.decode(b64);
    return sha256.convert(der).toString();
  }
}

// ───────────────────────────────────────────────────────────────────────
// Pairing — password check + host acceptance -> short-lived session
// token. Unlike Python's thread-blocking implementation, this uses a
// Completer since Dart is single-threaded/event-loop based; behavior
// (timeout, one decision per request, token TTL) is identical.
// ───────────────────────────────────────────────────────────────────────
class PendingPairingRequest {
  final int id;
  final String addr;
  final String label;
  final DateTime requestedAt;
  final Completer<bool?> _decision = Completer<bool?>(); // null = timeout

  PendingPairingRequest(this.id, this.addr, this.label) : requestedAt = DateTime.now();

  Map<String, dynamic> toJson() => {
        'id': id,
        'addr': addr,
        'label': label,
        'requestedAt': requestedAt.millisecondsSinceEpoch / 1000,
      };
}

class PairingManager {
  final _pending = <int, PendingPairingRequest>{};
  final _tokens = <String, _TokenEntry>{};
  int _nextId = 1;
  final _rng = Random.secure();

  final _changesController = StreamController<List<Map<String, dynamic>>>.broadcast();
  Stream<List<Map<String, dynamic>>> get onPendingChanged => _changesController.stream;

  void _notifyChange() => _changesController.add(listPending());

  /// Blocks (via Future) until the host accepts/denies, or times out.
  /// Returns a fresh session token on acceptance, null otherwise.
  Future<String?> request(String addr, String label,
      {Duration timeout = const Duration(seconds: pairTimeoutSeconds)}) async {
    final id = _nextId++;
    final pr = PendingPairingRequest(id, addr, label);
    _pending[id] = pr;
    _notifyChange();

    bool? decision;
    try {
      decision = await pr._decision.future.timeout(timeout, onTimeout: () => null);
    } finally {
      _pending.remove(id);
      _notifyChange();
    }

    if (decision != true) return null;

    final token = _genToken();
    _tokens[token] = _TokenEntry(
      expiry: DateTime.now().add(const Duration(seconds: tokenTtlSeconds)),
      label: label,
    );
    return token;
  }

  String _genToken() {
    final bytes = List.generate(24, (_) => _rng.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  List<Map<String, dynamic>> listPending() => _pending.values.map((p) => p.toJson()).toList();

  bool decide(int reqId, bool accepted) {
    final pr = _pending[reqId];
    if (pr == null || pr._decision.isCompleted) return false;
    pr._decision.complete(accepted);
    return true;
  }

  bool validate(String? token) {
    if (token == null || token.isEmpty) return false;
    final entry = _tokens[token];
    if (entry == null) return false;
    if (entry.expiry.isBefore(DateTime.now())) {
      _tokens.remove(token);
      return false;
    }
    return true;
  }

  String labelFor(String token) => _tokens[token]?.label ?? 'Unknown device';

  void revokeToken(String token) => _tokens.remove(token);
}

class _TokenEntry {
  final DateTime expiry;
  final String label;
  _TokenEntry({required this.expiry, required this.label});
}

// ───────────────────────────────────────────────────────────────────────
// Control session — tracks every open control-channel connection and who
// (if anyone) currently holds the exclusive control grant. Mirrors
// server.py's ControlSession exactly, including "granting a new device
// automatically revokes whoever had it before".
// ───────────────────────────────────────────────────────────────────────
class ControlClientInfo {
  final int id;
  final Socket conn; // always a SecureSocket in practice (implements Socket)
  final String addr;
  final DateTime connectedAt;
  final String label;
  ControlClientInfo({
    required this.id,
    required this.conn,
    required this.addr,
    required this.connectedAt,
    required this.label,
  });
}

class ControlSession {
  final _clients = <int, ControlClientInfo>{};
  int? _controllerId;
  int _nextId = 1;

  final _changesController = StreamController<List<Map<String, dynamic>>>.broadcast();
  Stream<List<Map<String, dynamic>>> get onClientsChanged => _changesController.stream;

  void _notifyChange() => _changesController.add(listClients());

  int register(Socket conn, String addr, {String label = ''}) {
    final id = _nextId++;
    _clients[id] = ControlClientInfo(
      id: id,
      conn: conn,
      addr: addr,
      connectedAt: DateTime.now(),
      label: label.isNotEmpty ? label : addr,
    );
    _notifyChange();
    return id;
  }

  void unregister(int id) {
    _clients.remove(id);
    if (_controllerId == id) _controllerId = null;
    _notifyChange();
  }

  bool grant(int id) {
    if (!_clients.containsKey(id)) return false;
    final previous = _controllerId;
    _controllerId = id;
    if (previous != null && previous != id) _notify(previous, 'STATUS:REVOKED\n');
    _notify(id, 'STATUS:GRANTED\n');
    _notifyChange();
    return true;
  }

  void revokeAll() {
    final previous = _controllerId;
    _controllerId = null;
    if (previous != null) _notify(previous, 'STATUS:REVOKED\n');
    _notifyChange();
  }

  bool isController(int id) => _controllerId == id;

  void _notify(int id, String message) {
    try {
      _clients[id]?.conn.add(utf8.encode(message));
    } catch (_) {
      // socket is going away on its own; nothing to do
    }
  }

  List<Map<String, dynamic>> listClients() => _clients.values
      .map((c) => {
            'id': c.id,
            'addr': c.addr,
            'label': c.label,
            'connectedAt': c.connectedAt.millisecondsSinceEpoch / 1000,
            'controlling': c.id == _controllerId,
          })
      .toList();

  /// Sends a raw line to every connected control client except (optionally)
  /// one — used to relay chat messages.
  void broadcast(String message, {int? excludeId}) {
    for (final c in _clients.values) {
      if (c.id == excludeId) continue;
      try {
        c.conn.add(utf8.encode(message));
      } catch (_) {
        // will be cleaned up by unregister() when its stream closes
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Chat — host-controlled on/off, defaults to on.
// ───────────────────────────────────────────────────────────────────────
class ChatState {
  bool _enabled = true;
  final _controller = StreamController<bool>.broadcast();
  Stream<bool> get onChanged => _controller.stream;

  bool get enabled => _enabled;
  void set(bool value) {
    _enabled = value;
    _controller.add(value);
  }
}

/// One incoming/outgoing chat line, used by both host and client UIs.
class ChatMessage {
  final String from;
  final String text;
  final DateTime time;
  final bool isMe;

  /// Sent to the host only (never relayed to the other devices). On the
  /// host side: "this device wrote to me privately". On a viewer: "I sent
  /// this to the host only".
  final bool hostOnly;
  ChatMessage({required this.from, required this.text, required this.time, this.isMe = false, this.hostOnly = false});
}
