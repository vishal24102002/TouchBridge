// LAN discovery — resolves a 9-digit Device ID to an IP via UDP broadcast.
// Mirrors security.py's run_discovery_responder + electron.js's client-side
// resolver. Only works within the same broadcast domain (same Wi-Fi/LAN),
// not across the open internet — see security.py's module docstring.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'security_service.dart' show discoveryPort, discoveryMagic;

/// Host side: listens on UDP :47821 and replies only to queries asking for
/// THIS device's id.
class DiscoveryResponder {
  RawDatagramSocket? _socket;

  Future<void> start(String deviceId, String hostname) async {
    final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, discoveryPort);
    socket.broadcastEnabled = true;
    _socket = socket;
    socket.listen((event) {
      if (event != RawSocketEvent.read) return;
      final dg = socket.receive();
      if (dg == null) return;
      try {
        final msg = jsonDecode(utf8.decode(dg.data)) as Map<String, dynamic>;
        if (msg['magic'] != discoveryMagic || msg['type'] != 'query') return;
        if (msg['id'] != deviceId) return; // not us — ignore
        final reply = utf8.encode(jsonEncode({
          'magic': discoveryMagic,
          'type': 'reply',
          'id': deviceId,
          'hostname': hostname,
        }));
        socket.send(reply, dg.address, dg.port);
      } catch (_) {
        // ignore malformed packets
      }
    });
  }

  void stop() {
    _socket?.close();
    _socket = null;
  }
}

/// Client side: "Connect by ID" — broadcasts a query for a 9-digit device
/// ID and waits briefly for a reply carrying the responder's IP.
class DiscoveryResolver {
  Future<({String ip, String hostname})?> resolveId(
    String deviceId, {
    Duration timeout = const Duration(seconds: 4),
  }) async {
    RawDatagramSocket? socket;
    try {
      socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      socket.broadcastEnabled = true;

      final query = utf8.encode(jsonEncode({
        'magic': discoveryMagic,
        'type': 'query',
        'id': deviceId,
      }));

      final completer = Completer<({String ip, String hostname})?>();
      final sub = socket.listen((event) {
        if (event != RawSocketEvent.read) return;
        final dg = socket!.receive();
        if (dg == null) return;
        try {
          final msg = jsonDecode(utf8.decode(dg.data)) as Map<String, dynamic>;
          if (msg['magic'] != discoveryMagic || msg['type'] != 'reply') return;
          if (msg['id'] != deviceId) return;
          if (!completer.isCompleted) {
            completer.complete((ip: dg.address.address, hostname: (msg['hostname'] ?? '') as String));
          }
        } catch (_) {
          // ignore malformed packets
        }
      });

      socket.send(query, InternetAddress('255.255.255.255'), discoveryPort);

      final result = await completer.future.timeout(timeout, onTimeout: () => null);
      await sub.cancel();
      return result;
    } catch (_) {
      return null;
    } finally {
      socket?.close();
    }
  }
}
