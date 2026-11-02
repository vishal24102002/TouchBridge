import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/network_service.dart';
import '../services/settings_service.dart';
import '../widgets/common.dart';

class ClientScreen extends StatefulWidget {
  const ClientScreen({super.key});

  @override
  State<ClientScreen> createState() => _ClientScreenState();
}

class _ClientScreenState extends State<ClientScreen> {
  late final TextEditingController _hostController;
  final RemoteSession _session = RemoteSession();

  bool _connecting = false;
  bool _connected = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final settings = context.read<SettingsService>();
    _hostController = TextEditingController(text: settings.defaultHost);
  }

  Future<void> _connect(SettingsService settings) async {
    final host = _hostController.text.trim();
    if (host.isEmpty) {
      setState(() => _error = 'Enter the server IP address');
      return;
    }
    setState(() {
      _connecting = true;
      _error = null;
    });
    try {
      await _session.connect(host, settings.screenPort, settings.controlPort);
      if (!mounted) return;
      setState(() {
        _connecting = false;
        _connected = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _connecting = false;
        _error = 'Could not connect: $e';
      });
    }
  }

  void _disconnect() {
    _session.disconnect();
    setState(() => _connected = false);
  }

  @override
  void dispose() {
    _session.dispose();
    _hostController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_connected) return _RemoteView(session: _session, onDisconnect: _disconnect);

    final settings = context.watch<SettingsService>();
    final theme = settings.currentTheme;

    return Scaffold(
      appBar: buildSubAppBar(context, plainPart: 'Client', accentPart: 'Mode'),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const KickerLabel('Server Address'),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _hostController,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 20),
                    keyboardType: TextInputType.text,
                    decoration: const InputDecoration(
                      hintText: '192.168.1.100',
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 16, horizontal: 14),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(child: _PortChip(label: 'Screen', value: '${settings.screenPort}')),
                      const SizedBox(width: 12),
                      Expanded(child: _PortChip(label: 'Control', value: '${settings.controlPort}')),
                    ],
                  ),
                ],
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
            ],
            const SizedBox(height: 16),

            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const KickerLabel('Quick Tips'),
                  const SizedBox(height: 14),
                  _Tip('Both devices must be on the same Wi-Fi'),
                  _Tip('Start Server Mode on the host device first'),
                  _Tip('Check firewall if connection fails'),
                ],
              ),
            ),
            const SizedBox(height: 24),

            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _connecting ? null : () => _connect(settings),
                icon: _connecting
                    ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                )
                    : const Icon(Icons.add_link_rounded),
                label: Text(_connecting ? 'Connecting…' : 'Connect'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: theme.accent,
                  foregroundColor: Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  textStyle: const TextStyle(
                      fontFamily: 'monospace', fontSize: 17, fontWeight: FontWeight.bold),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PortChip extends StatelessWidget {
  final String label;
  final String value;
  const _PortChip({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.15)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontFamily: 'monospace', fontSize: 14)),
          Text(value,
              style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  color: theme.accent)),
        ],
      ),
    );
  }
}

class _Tip extends StatelessWidget {
  final String text;
  const _Tip(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('•  ', style: TextStyle(fontFamily: 'monospace', fontSize: 14)),
          Expanded(child: Text(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 14))),
        ],
      ),
    );
  }
}

/// Full-screen live remote view: renders incoming JPEG frames and forwards
/// taps/drags to the control channel as normalized (0-1) coordinates.
class _RemoteView extends StatefulWidget {
  final RemoteSession session;
  final VoidCallback onDisconnect;
  const _RemoteView({required this.session, required this.onDisconnect});

  @override
  State<_RemoteView> createState() => _RemoteViewState();
}

class _RemoteViewState extends State<_RemoteView> {
  Uint8List? _latestFrame;

  @override
  void initState() {
    super.initState();
    widget.session.screen.frames.listen((frame) {
      if (mounted) setState(() => _latestFrame = frame);
    });
  }

  // This protocol is trackpad-style: there's no "move cursor to x,y", only
  // relative deltas (mouse_move:dx,dy) plus a click-at-current-position
  // command. So a tap = click, and a drag = relative cursor movement,
  // matching exactly how ClientPage.js's onMouseMove/onMouseDown work.
  void _handleTapUp(TapUpDetails details) {
    widget.session.control.sendClick();
  }

  void _handlePanUpdate(DragUpdateDetails details) {
    final dx = details.delta.dx.round();
    final dy = details.delta.dy.round();
    if (dx != 0 || dy != 0) {
      widget.session.control.sendMouseMoveRelative(dx, dy);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: const Text('Remote Session', style: TextStyle(fontFamily: 'monospace')),
        actions: [
          TextButton.icon(
            onPressed: widget.onDisconnect,
            icon: const Icon(Icons.close_rounded, color: Colors.redAccent),
            label: const Text('Disconnect', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
      body: GestureDetector(
        onTapUp: _handleTapUp,
        onPanUpdate: _handlePanUpdate,
        child: SizedBox.expand(
          child: _latestFrame == null
              ? const Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                CircularProgressIndicator(color: Colors.white54),
                SizedBox(height: 16),
                Text('Waiting for first frame…',
                    style: TextStyle(color: Colors.white54, fontFamily: 'monospace')),
              ],
            ),
          )
              : Image.memory(_latestFrame!, gaplessPlayback: true, fit: BoxFit.contain),
        ),
      ),
    );
  }
}