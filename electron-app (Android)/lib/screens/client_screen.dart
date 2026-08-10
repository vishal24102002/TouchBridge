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
    if (_connected) {
      return _RemoteView(
        session: _session,
        onDisconnect: _disconnect,
        controlAllowed: _session.control.allowed,
      );
    }

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
  final bool controlAllowed;
  const _RemoteView({
    required this.session,
    required this.onDisconnect,
    required this.controlAllowed,
  });

  @override
  State<_RemoteView> createState() => _RemoteViewState();
}

class _RemoteViewState extends State<_RemoteView> {
  Uint8List? _latestFrame;
  bool _controlsOpen = false;
  bool _zoomMode = false;
  final _typeController = TextEditingController();
  final _transformController = TransformationController();

  // Mirrors server.py's SHORTCUT_KEYS exactly — same names, same command
  // strings sent over the control channel. Includes the non-printable keys
  // (Tab, Caps Lock, Delete, F1-F12, etc.) that a touchscreen client has no
  // other way to send, since typed text only covers printable characters.
  static const List<_Shortcut> _shortcuts = [
    _Shortcut('Ctrl+C', 'ctrl_c'),
    _Shortcut('Ctrl+V', 'ctrl_v'),
    _Shortcut('Ctrl+X', 'ctrl_x'),
    _Shortcut('Ctrl+Z', 'ctrl_z'),
    _Shortcut('Ctrl+A', 'ctrl_a'),
    _Shortcut('Ctrl+Tab', 'ctrl_tab'),
    _Shortcut('↑', 'arrow_up'),
    _Shortcut('↓', 'arrow_down'),
    _Shortcut('←', 'arrow_left'),
    _Shortcut('→', 'arrow_right'),
    _Shortcut('PgUp', 'page_up'),
    _Shortcut('PgDn', 'page_down'),
    _Shortcut('⌫ Bksp', 'backspace'),
    _Shortcut('↵ Enter', 'enter'),
    _Shortcut('Esc', 'escape'),
    _Shortcut('Tab', 'tab'),
    _Shortcut('Caps Lock', 'caps_lock'),
    _Shortcut('Delete', 'delete'),
    _Shortcut('Insert', 'insert'),
    _Shortcut('Home', 'home'),
    _Shortcut('End', 'end'),
    _Shortcut('Print Scrn', 'print_screen'),
    _Shortcut('Alt+Tab', 'alt_tab'),
    _Shortcut('Alt+F4', 'alt_f4'),
    _Shortcut('Win+D', 'win_d'),
    _Shortcut('Super', 'super'),
    _Shortcut('F1', 'f1'), _Shortcut('F2', 'f2'), _Shortcut('F3', 'f3'),
    _Shortcut('F4', 'f4'), _Shortcut('F5', 'f5'), _Shortcut('F6', 'f6'),
    _Shortcut('F7', 'f7'), _Shortcut('F8', 'f8'), _Shortcut('F9', 'f9'),
    _Shortcut('F10', 'f10'), _Shortcut('F11', 'f11'), _Shortcut('F12', 'f12'),
  ];

  @override
  void initState() {
    super.initState();
    widget.session.screen.frames.listen((frame) {
      if (mounted) setState(() => _latestFrame = frame);
    });
  }

  @override
  void dispose() {
    _typeController.dispose();
    _transformController.dispose();
    super.dispose();
  }

  // Zoom is a separate mode from remote-control gestures on purpose: a
  // one-finger drag means "move the remote cursor" in control mode, but
  // "pan the zoomed view" in zoom mode — those two can't coexist on the
  // same gesture without constantly fighting each other. Toggle between
  // them with the appbar icon.
  void _zoomBy(double factor) {
    final current = _transformController.value.getMaxScaleOnAxis();
    final next = (current * factor).clamp(1.0, 5.0);
    _transformController.value = Matrix4.identity()..scale(next);
  }

  void _zoomReset() {
    _transformController.value = Matrix4.identity();
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

  void _sendTypedText() {
    final text = _typeController.text;
    if (text.isEmpty) return;
    widget.session.control.sendText(text);
    _typeController.clear();
  }

  Widget _buildFrame() {
    if (_latestFrame == null) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: Colors.white54),
            SizedBox(height: 16),
            Text('Waiting for first frame…',
                style: TextStyle(color: Colors.white54, fontFamily: 'monospace')),
          ],
        ),
      );
    }
    return Image.memory(_latestFrame!, gaplessPlayback: true, fit: BoxFit.contain);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      // Just a back arrow up here now — everything else (zoom, controls,
      // disconnect) moved to the bottom toolbar below, since cramming
      // icons + a title + Disconnect into one top bar left no room to
      // breathe on narrow phone screens.
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        toolbarHeight: 40,
      ),
      body: Column(
        children: [
          if (!widget.controlAllowed)
            Container(
              width: double.infinity,
              color: Colors.amber.withValues(alpha: 0.15),
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
              child: const Text(
                'View-only — the host has remote control disabled',
                textAlign: TextAlign.center,
                style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.amber),
              ),
            ),
          Expanded(
            child: Stack(
              children: [
                _zoomMode
                    ? InteractiveViewer(
                        transformationController: _transformController,
                        minScale: 1.0,
                        maxScale: 5.0,
                        child: SizedBox.expand(child: _buildFrame()),
                      )
                    : GestureDetector(
                        // Gestures do nothing when control isn't allowed —
                        // the control channel itself drops sends in that
                        // state too (see ControlChannelClient._send), this
                        // just avoids the pointless connection attempts.
                        onTapUp: widget.controlAllowed ? _handleTapUp : null,
                        onPanUpdate: widget.controlAllowed ? _handlePanUpdate : null,
                        onLongPress: widget.controlAllowed
                            ? () => widget.session.control.sendRightClick()
                            : null,
                        onDoubleTap: widget.controlAllowed
                            ? () => widget.session.control.sendDoubleClick()
                            : null,
                        child: SizedBox.expand(child: _buildFrame()),
                      ),
              ],
            ),
          ),
          if (widget.controlAllowed && _controlsOpen) _ControlPanel(
            session: widget.session,
            shortcuts: _shortcuts,
            typeController: _typeController,
            onSendText: _sendTypedText,
          ),
          _buildBottomToolbar(),
        ],
      ),
    );
  }

  Widget _buildBottomToolbar() {
    return Container(
      color: const Color(0xFF0B0C10),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: [
              IconButton(
                tooltip: _zoomMode ? 'Exit zoom' : 'Zoom',
                icon: Icon(
                  _zoomMode ? Icons.pan_tool_alt_rounded : Icons.zoom_in_rounded,
                  color: _zoomMode ? Colors.cyanAccent : Colors.white,
                ),
                onPressed: () => setState(() {
                  _zoomMode = !_zoomMode;
                  if (!_zoomMode) _zoomReset();
                }),
              ),
              if (_zoomMode) ...[
                IconButton(
                  tooltip: 'Zoom out',
                  icon: const Icon(Icons.remove, color: Colors.white, size: 20),
                  onPressed: () => _zoomBy(0.8),
                ),
                ValueListenableBuilder<Matrix4>(
                  valueListenable: _transformController,
                  builder: (context, matrix, _) {
                    final pct = (matrix.getMaxScaleOnAxis() * 100).round();
                    return SizedBox(
                      width: 44,
                      child: Text(
                        '$pct%',
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.white70),
                      ),
                    );
                  },
                ),
                IconButton(
                  tooltip: 'Zoom in',
                  icon: const Icon(Icons.add, color: Colors.white, size: 20),
                  onPressed: () => _zoomBy(1.25),
                ),
                IconButton(
                  tooltip: 'Reset zoom',
                  icon: const Icon(Icons.center_focus_weak, color: Colors.white70, size: 18),
                  onPressed: _zoomReset,
                ),
              ],
              const Spacer(),
              if (widget.controlAllowed && !_zoomMode)
                IconButton(
                  tooltip: 'Controls',
                  icon: Icon(
                    _controlsOpen ? Icons.keyboard_hide_rounded : Icons.gamepad_outlined,
                    color: Colors.white,
                  ),
                  onPressed: () => setState(() => _controlsOpen = !_controlsOpen),
                ),
              TextButton.icon(
                onPressed: widget.onDisconnect,
                icon: const Icon(Icons.close_rounded, color: Colors.redAccent, size: 18),
                label: const Text('Disconnect', style: TextStyle(color: Colors.redAccent, fontSize: 13)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Shortcut {
  final String label;
  final String command; // matches server.py's SHORTCUT_KEYS names
  const _Shortcut(this.label, this.command);
}

/// The slide-up panel: type-text field, mouse buttons, and the shortcut
/// grid — this is the Flutter equivalent of ClientPage.js's sidebar
/// "Remote Control" + "Shortcuts" boxes.
class _ControlPanel extends StatelessWidget {
  final RemoteSession session;
  final List<_Shortcut> shortcuts;
  final TextEditingController typeController;
  final VoidCallback onSendText;

  const _ControlPanel({
    required this.session,
    required this.shortcuts,
    required this.typeController,
    required this.onSendText,
  });

  @override
  Widget build(BuildContext context) {
    // Cap the whole panel to a fraction of the screen so it can never push
    // content off the bottom edge — the shortcut grid alone (18 keys +
    // F1-F12 + quick apps) is taller than most phone screens can show at
    // once, so it needs to scroll rather than just grow.
    final maxPanelHeight = MediaQuery.of(context).size.height * 0.42;

    return Container(
      color: const Color(0xFF0B0C10),
      constraints: BoxConstraints(maxHeight: maxPanelHeight),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Type text + mouse buttons stay pinned above the scroll area
            // so they're always reachable without scrolling.
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 0),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: typeController,
                      style: const TextStyle(fontFamily: 'monospace', color: Colors.white, fontSize: 14),
                      decoration: InputDecoration(
                        hintText: 'Type here…',
                        hintStyle: const TextStyle(color: Colors.white38),
                        isDense: true,
                        filled: true,
                        fillColor: Colors.white.withValues(alpha: 0.06),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: BorderSide.none,
                        ),
                      ),
                      onSubmitted: (_) => onSendText(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: onSendText,
                    icon: const Icon(Icons.send_rounded, size: 18),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 0),
              child: Row(
                children: [
                  Expanded(
                    child: _PanelButton(
                      label: 'Right Click',
                      onTap: () => session.control.sendRightClick(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _PanelButton(
                      label: 'Double Click',
                      onTap: () => session.control.sendDoubleClick(),
                    ),
                  ),
                ],
              ),
            ),

            // Everything below (shortcut grid + quick apps) scrolls within
            // whatever height is left in the panel's budget.
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    GridView.builder(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: shortcuts.length,
                      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 4,
                        mainAxisSpacing: 8,
                        crossAxisSpacing: 8,
                        childAspectRatio: 2.1,
                      ),
                      itemBuilder: (context, i) {
                        final s = shortcuts[i];
                        return _PanelButton(
                          label: s.label,
                          onTap: () => session.control.sendShortcut(s.command),
                        );
                      },
                    ),
                    const SizedBox(height: 12),

                    // Quick apps / media, matching ClientPage.js's row 4
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        _PanelButton(label: '🌐 Browser', onTap: () => session.control.openBrowser()),
                        _PanelButton(label: '📁 Folder', onTap: () => session.control.openFolder()),
                        _PanelButton(label: '🖥 Terminal', onTap: () => session.control.openTerminal()),
                        _PanelButton(label: '🎵 Play/Pause', onTap: () => session.control.mediaPlayPause()),
                        _PanelButton(label: '🔊 Vol+', onTap: () => session.control.volumeUp()),
                        _PanelButton(label: '🔇 Mute', onTap: () => session.control.volumeMute()),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PanelButton extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _PanelButton({required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
        ),
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: const TextStyle(fontFamily: 'monospace', color: Colors.white, fontSize: 12),
        ),
      ),
    );
  }
}
