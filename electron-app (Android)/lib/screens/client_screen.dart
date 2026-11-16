import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/audio_player_channel.dart';
import '../services/device_info_service.dart';
import '../services/h264_decoder_channel.dart';
import '../services/network_service.dart';
import '../services/security_service.dart' show ChatMessage;
import '../services/settings_service.dart';
import '../widgets/common.dart';

enum _ConnectBy { ip, id }

class ClientScreen extends StatefulWidget {
  const ClientScreen({super.key});

  @override
  State<ClientScreen> createState() => _ClientScreenState();
}

class _ClientScreenState extends State<ClientScreen> {
  late final TextEditingController _hostController;
  late final TextEditingController _idController;
  late final TextEditingController _passwordController;
  late final TextEditingController _labelController;
  final RemoteSession _session = RemoteSession();

  _ConnectBy _connectBy = _ConnectBy.ip;
  bool _resolving = false;
  bool _pairing = false;
  bool _connected = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final settings = context.read<SettingsService>();
    _hostController = TextEditingController(text: settings.defaultHost);
    _idController = TextEditingController();
    _passwordController = TextEditingController();
    _labelController = TextEditingController(
      text: settings.deviceLabel,
    );
    // First run: name this device after the phone itself (e.g. "samsung SM-S911B")
    // so the host's Connected Devices list shows a real name, not just an IP.
    if (settings.deviceLabel.isEmpty) {
      DeviceInfoService().getHostname().then((name) {
        if (mounted && _labelController.text.isEmpty) _labelController.text = name;
      });
    }
  }

  Future<void> _connect(SettingsService settings) async {
    setState(() {
      _error = null;
    });

    String host;
    if (_connectBy == _ConnectBy.id) {
      final id = _idController.text.trim();
      if (id.length != 9) {
        setState(() => _error = 'Enter the 9-digit Device ID');
        return;
      }
      setState(() => _resolving = true);
      final resolved = await RemoteSession.resolveDeviceId(id);
      setState(() => _resolving = false);
      if (resolved == null) {
        setState(() => _error = 'Could not find that device on this network');
        return;
      }
      host = resolved;
    } else {
      host = _hostController.text.trim();
      if (host.isEmpty) {
        setState(() => _error = 'Enter the server IP address');
        return;
      }
    }

    final password = _passwordController.text;
    if (password.isEmpty) {
      setState(() => _error = 'Enter the host\'s password');
      return;
    }
    final label = _labelController.text.trim().isEmpty ? await DeviceInfoService().getHostname() : _labelController.text.trim();
    await settings.setDeviceLabel(label);

    setState(() => _pairing = true);
    try {
      await _session.connect(
        host,
        settings.screenPort,
        settings.controlPort,
        settings.pairPort,
        password,
        label,
      );
      if (!mounted) return;
      setState(() {
        _pairing = false;
        _connected = true;
      });
    } on PairingDeniedException catch (e) {
      if (!mounted) return;
      setState(() {
        _pairing = false;
        _error = switch (e.reason) {
          'bad_password' => 'Wrong password',
          'host_declined_or_timeout' => 'The host denied the request, or it timed out',
          _ => 'Pairing failed (${e.reason})',
        };
      });
    } on CertificateChangedException catch (e) {
      if (!mounted) return;
      setState(() => _pairing = false);
      final trustAnyway = await _showCertMismatchDialog(host);
      if (trustAnyway == true) {
        await CertPinStore.clear(host);
        _connect(settings);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _pairing = false;
        _error = 'Could not connect: $e';
      });
    }
  }

  Future<bool?> _showCertMismatchDialog(String host) {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Host identity changed'),
        content: Text(
          'The security certificate for $host does not match the one seen last time. '
              'This can happen if the host reinstalled TouchBridge — or it could mean someone '
              'else is impersonating it on this network.\n\nOnly continue if you\'re sure.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Trust anyway', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
  }

  void _disconnect() {
    _session.disconnect();
    setState(() => _connected = false);
  }

  @override
  void dispose() {
    _session.dispose();
    _hostController.dispose();
    _idController.dispose();
    _passwordController.dispose();
    _labelController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_connected) {
      return _RemoteView(session: _session, onDisconnect: _disconnect);
    }

    final settings = context.watch<SettingsService>();
    final theme = settings.currentTheme;
    final busy = _resolving || _pairing;

    return Scaffold(
      appBar: buildSubAppBar(context, plainPart: 'Client', accentPart: 'Mode'),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            // Segmented IP-vs-ID toggle — stacked full-width beats a
            // cramped two-tab row on narrow phones.
            Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.15)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: _SegmentButton(
                      label: 'By IP Address',
                      selected: _connectBy == _ConnectBy.ip,
                      color: theme.accent,
                      onTap: () => setState(() => _connectBy = _ConnectBy.ip),
                    ),
                  ),
                  Expanded(
                    child: _SegmentButton(
                      label: 'By Device ID',
                      selected: _connectBy == _ConnectBy.id,
                      color: theme.accent,
                      onTap: () => setState(() => _connectBy = _ConnectBy.id),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),

            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  KickerLabel(_connectBy == _ConnectBy.ip ? 'Server Address' : 'Device ID'),
                  const SizedBox(height: 10),
                  if (_connectBy == _ConnectBy.ip)
                    TextField(
                      controller: _hostController,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 20),
                      decoration: const InputDecoration(
                        hintText: '192.168.1.100',
                        isDense: true,
                        contentPadding: EdgeInsets.symmetric(vertical: 16, horizontal: 14),
                      ),
                    )
                  else
                    TextField(
                      controller: _idController,
                      keyboardType: TextInputType.number,
                      maxLength: 9,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 22, letterSpacing: 2),
                      decoration: const InputDecoration(
                        hintText: '123 456 789',
                        counterText: '',
                        isDense: true,
                        contentPadding: EdgeInsets.symmetric(vertical: 16, horizontal: 14),
                      ),
                    ),
                  const SizedBox(height: 4),
                  if (_connectBy == _ConnectBy.id)
                    Text(
                      'Only works on the same Wi-Fi/LAN as the host.',
                      style: TextStyle(fontSize: 11, color: theme.textSecondary, fontFamily: 'monospace'),
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
            const SizedBox(height: 14),

            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const KickerLabel('Host Password'),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _passwordController,
                    obscureText: true,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 18),
                    decoration: const InputDecoration(
                      hintText: 'Password shown on the host',
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 14, horizontal: 14),
                    ),
                  ),
                  const SizedBox(height: 14),
                  const KickerLabel('Your Label'),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _labelController,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 16),
                    decoration: const InputDecoration(
                      hintText: 'How you\'ll appear to the host',
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 12, horizontal: 14),
                    ),
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
                  const _Tip('Both devices must be on the same Wi-Fi'),
                  const _Tip('Start Server Mode on the host device first'),
                  const _Tip('The host must tap Accept before you connect'),
                ],
              ),
            ),
            const SizedBox(height: 24),

            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: busy ? null : () => _connect(settings),
                icon: busy
                    ? const SizedBox(
                  width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                )
                    : const Icon(Icons.add_link_rounded),
                label: Text(_resolving ? 'Finding device…' : (_pairing ? 'Waiting for host…' : 'Connect')),
                style: ElevatedButton.styleFrom(
                  backgroundColor: theme.accent,
                  foregroundColor: Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  textStyle: const TextStyle(fontFamily: 'monospace', fontSize: 17, fontWeight: FontWeight.bold),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SegmentButton extends StatelessWidget {
  final String label;
  final bool selected;
  final Color color;
  final VoidCallback onTap;
  const _SegmentButton({required this.label, required this.selected, required this.color, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? color.withValues(alpha: 0.15) : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: selected ? color : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
          ),
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
              style: TextStyle(fontFamily: 'monospace', fontSize: 14, fontWeight: FontWeight.bold, color: theme.accent)),
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

/// Full-screen live remote view: renders incoming JPEG frames, forwards
/// taps/drags to the control channel, and hosts the chat panel — this is
/// the Flutter equivalent of ClientPage.js's canvas + sidebar.
class _RemoteView extends StatefulWidget {
  final RemoteSession session;
  final VoidCallback onDisconnect;
  const _RemoteView({required this.session, required this.onDisconnect});

  @override
  State<_RemoteView> createState() => _RemoteViewState();
}

class _RemoteViewState extends State<_RemoteView> {
  Uint8List? _latestFrame;

  // H.264 frames are decoded natively into a Flutter texture; JPEG/PNG frames
  // go through Image.memory. The host can switch codec mid-session, so the
  // view follows whatever kind of frame arrives last.
  final H264Decoder _decoder = H264Decoder();
  bool _videoMode = false;
  bool _decoderStarting = false;
  final List<Uint8List> _videoBacklog = []; // frames that arrive while the texture is being created
  int? _frameWidth;
  int? _frameHeight;
  // Host audio (shown only once the host actually sends some).
  bool _hasAudio = false;
  bool _audioMuted = false;
  bool _controlsOpen = false;
  bool _chatOpen = false;
  bool _zoomMode = false;
  bool _controlAllowed = false;
  bool _chatEnabled = true;
  bool _chatHostOnly = false; // false = my messages go to everyone, true = host only
  String? _capabilityNote;
  final _typeController = TextEditingController();
  final _chatController = TextEditingController();
  final _transformController = TransformationController();
  final List<ChatMessage> _chatMessages = [];

  // Mirrors server.py's SHORTCUT_KEYS exactly.
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
    _controlAllowed = widget.session.control.allowed;
    widget.session.screen.frames.listen((frame) {
      if (mounted) setState(() {
        _latestFrame = frame;
        _videoMode = false;
      });
      _updateFrameDimensions(frame);
    });
    widget.session.screen.videoFrames.listen(_onVideoFrame);
    // Settings → Audio decides whether host audio starts muted; the speaker
    // button in the bottom bar toggles it for this session.
    _audioMuted = !context.read<SettingsService>().playRemoteAudio;
    AudioPlayerChannel.setMuted(_audioMuted);
    widget.session.screen.audioFrames.listen((chunk) {
      if (!mounted) return;
      if (!_hasAudio) setState(() => _hasAudio = true);
      if (!_audioMuted) AudioPlayerChannel.play(chunk);
    });
    _decoder.onSize.listen((size) {
      if (mounted) {
        setState(() {
          _frameWidth = size.width.round();
          _frameHeight = size.height.round();
        });
      }
    });
    widget.session.control.onGrantChanged.listen((granted) {
      if (mounted) setState(() => _controlAllowed = granted);
    });
    widget.session.control.onChatStateChanged.listen((on) {
      if (mounted) setState(() => _chatEnabled = on);
    });
    widget.session.control.onChat.listen((msg) {
      if (mounted) setState(() => _chatMessages.add(msg));
    });
    widget.session.control.onError.listen((line) {
      if (!mounted) return;
      if (line.startsWith('NOCAP:')) {
        setState(() => _capabilityNote = line.substring('NOCAP:'.length));
      } else if (line == 'CHAT_ERROR:disabled') {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Chat is currently disabled by the host')),
        );
      }
    });
  }

  Future<void> _onVideoFrame(Uint8List frame) async {
    if (!mounted) return;
    if (!_videoMode) setState(() => _videoMode = true);
    if (_decoder.textureId == null || _decoderStarting) {
      _videoBacklog.add(frame);
      if (_videoBacklog.length > 300) _videoBacklog.removeAt(0);
      if (!_decoderStarting && _decoder.textureId == null) {
        _decoderStarting = true;
        final ok = await _decoder.start();
        if (!mounted) return;
        if (!ok) {
          _decoderStarting = false;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('This device cannot decode H.264 — ask the host to switch to JPEG in Settings')),
          );
          return;
        }
        // Flush in order BEFORE accepting live frames again.
        for (final f in _videoBacklog) {
          _decoder.decode(f);
        }
        _videoBacklog.clear();
        _decoderStarting = false;
        setState(() {});
      }
      return;
    }
    _decoder.decode(frame);
  }

  @override
  void dispose() {
    AudioPlayerChannel.release();
    _decoder.release();
    _typeController.dispose();
    _chatController.dispose();
    _transformController.dispose();
    super.dispose();
  }

  void _zoomBy(double factor) {
    final current = _transformController.value.getMaxScaleOnAxis();
    final next = (current * factor).clamp(1.0, 5.0);
    _transformController.value = Matrix4.identity()..scale(next);
  }

  void _zoomReset() => _transformController.value = Matrix4.identity();

  /// Decodes just enough of each frame to know its real pixel dimensions,
  /// used to compute the actual rendered image content box (accounting
  /// for BoxFit.contain letterboxing) so gestures can be mapped to an
  /// exact absolute position — see _contentRectFor/_sendAbsoluteFromLocal.
  /// Skipped once dimensions are already known and haven't changed size
  /// class (still decodes the header on every frame, which is cheap
  /// relative to the frame sizes this app sends, but avoids the
  /// setState/rebuild when nothing actually changed).
  Future<void> _updateFrameDimensions(Uint8List bytes) async {
    try {
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final w = frame.image.width;
      final h = frame.image.height;
      frame.image.dispose();
      codec.dispose();
      if (mounted && (w != _frameWidth || h != _frameHeight)) {
        setState(() {
          _frameWidth = w;
          _frameHeight = h;
        });
      }
    } catch (_) {
      // Malformed/partial frame — keep whatever dimensions we already
      // have rather than losing gesture mapping over one bad frame.
    }
  }

  /// The real rendered image content rectangle within a box of [boxSize],
  /// accounting for BoxFit.contain letterboxing — mirrors ClientPage.js's
  /// recomputeContentRect. Null until the first frame's dimensions are
  /// known.
  Rect? _contentRectFor(Size boxSize) {
    final fw = _frameWidth;
    final fh = _frameHeight;
    if (fw == null || fh == null || fw == 0 || fh == 0) return null;
    if (boxSize.width == 0 || boxSize.height == 0) return null;

    final boxAspect = boxSize.width / boxSize.height;
    final imgAspect = fw / fh;
    double contentWidth, contentHeight;
    if (imgAspect > boxAspect) {
      contentWidth = boxSize.width;
      contentHeight = boxSize.width / imgAspect;
    } else {
      contentHeight = boxSize.height;
      contentWidth = boxSize.height * imgAspect;
    }
    final left = (boxSize.width - contentWidth) / 2;
    final top = (boxSize.height - contentHeight) / 2;
    return Rect.fromLTWH(left, top, contentWidth, contentHeight);
  }

  /// Maps a tap/drag position (relative to the gesture box) to an
  /// absolute fractional position and sends it — but only if that
  /// position actually falls within the real image content, never the
  /// empty letterboxed padding around it. Returns whether it sent
  /// anything, so callers can skip firing a click for a tap that landed
  /// outside the image.
  bool _sendAbsoluteFromLocal(Offset localPosition, Size boxSize) {
    final content = _contentRectFor(boxSize);
    if (content == null || !content.contains(localPosition)) return false;
    final fx = (localPosition.dx - content.left) / content.width;
    final fy = (localPosition.dy - content.top) / content.height;
    widget.session.control.sendMouseMoveAbsolute(fx, fy);
    return true;
  }

  void _sendTypedText() {
    final text = _typeController.text;
    if (text.isEmpty) return;
    widget.session.control.sendText(text);
    _typeController.clear();
  }

  void _sendChat() {
    final text = _chatController.text.trim();
    if (text.isEmpty) return;
    widget.session.control.sendChat(text, hostOnly: _chatHostOnly);
    setState(() => _chatMessages.add(
        ChatMessage(from: 'You', text: text, time: DateTime.now(), isMe: true, hostOnly: _chatHostOnly)));
    _chatController.clear();
  }

  Widget _buildFrame() {
    final tex = _decoder.textureId;
    if (_videoMode && tex != null && _frameWidth != null && _frameHeight != null) {
      // Same letterboxing as Image's BoxFit.contain, so _contentRectFor's
      // gesture mapping is identical for both codecs.
      return FittedBox(
        fit: BoxFit.contain,
        child: SizedBox(
          width: _frameWidth!.toDouble(),
          height: _frameHeight!.toDouble(),
          child: Texture(textureId: tex),
        ),
      );
    }
    if (_latestFrame == null || _videoMode) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: Colors.white54),
            SizedBox(height: 16),
            Text('Waiting for first frame…', style: TextStyle(color: Colors.white54, fontFamily: 'monospace')),
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
      appBar: AppBar(backgroundColor: Colors.black, elevation: 0, toolbarHeight: 40),
      body: Column(
        children: [
          if (!_controlAllowed)
            Container(
              width: double.infinity,
              color: Colors.amber.withValues(alpha: 0.15),
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
              child: Text(
                _capabilityNote != null
                    ? 'View-only — $_capabilityNote'
                    : 'View-only — the host hasn\'t granted you control',
                textAlign: TextAlign.center,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.amber),
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
                    : LayoutBuilder(
                  builder: (context, constraints) {
                    final boxSize = constraints.biggest;
                    // Every gesture callback sends the exact
                    // absolute position it fired at (only if that
                    // position is actually within the real image,
                    // per _sendAbsoluteFromLocal) before triggering
                    // its click type — so taps, long-presses, and
                    // double-taps all land precisely where touched,
                    // not wherever a prior drag happened to leave
                    // the virtual cursor.
                    return GestureDetector(
                      onTapUp: _controlAllowed
                          ? (d) {
                        if (_sendAbsoluteFromLocal(d.localPosition, boxSize)) {
                          widget.session.control.sendClick();
                        }
                      }
                          : null,
                      onPanUpdate: _controlAllowed
                          ? (d) => _sendAbsoluteFromLocal(d.localPosition, boxSize)
                          : null,
                      onLongPressStart: _controlAllowed
                          ? (d) {
                        if (_sendAbsoluteFromLocal(d.localPosition, boxSize)) {
                          widget.session.control.sendRightClick();
                        }
                      }
                          : null,
                      onDoubleTapDown: _controlAllowed
                          ? (d) => _sendAbsoluteFromLocal(d.localPosition, boxSize)
                          : null,
                      onDoubleTap: _controlAllowed ? () => widget.session.control.sendDoubleClick() : null,
                      child: SizedBox.expand(child: _buildFrame()),
                    );
                  },
                ),
                if (_chatOpen)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: _ChatPanel(
                      messages: _chatMessages,
                      enabled: _chatEnabled,
                      controller: _chatController,
                      onSend: _sendChat,
                      hostOnly: _chatHostOnly,
                      onTargetChanged: (v) => setState(() => _chatHostOnly = v),
                      onClose: () => setState(() => _chatOpen = false),
                    ),
                  ),
              ],
            ),
          ),
          if (_controlAllowed && _controlsOpen)
            _ControlPanel(
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
                icon: Icon(_zoomMode ? Icons.pan_tool_alt_rounded : Icons.zoom_in_rounded,
                    color: _zoomMode ? Colors.cyanAccent : Colors.white),
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
                      child: Text('$pct%',
                          textAlign: TextAlign.center,
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.white70)),
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
              if (_hasAudio && !_zoomMode)
                IconButton(
                  tooltip: _audioMuted ? 'Host audio muted — tap to listen' : 'Listening to host audio — tap to mute',
                  icon: Icon(_audioMuted ? Icons.volume_off_rounded : Icons.volume_up_rounded,
                      color: _audioMuted ? Colors.white54 : Colors.cyanAccent, size: 20),
                  onPressed: () {
                    setState(() => _audioMuted = !_audioMuted);
                    AudioPlayerChannel.setMuted(_audioMuted);
                  },
                ),
              if (!_zoomMode)
                IconButton(
                  tooltip: 'Chat',
                  icon: Badge(
                    isLabelVisible: _chatMessages.isNotEmpty && !_chatOpen,
                    child: const Icon(Icons.chat_bubble_outline_rounded, color: Colors.white, size: 20),
                  ),
                  onPressed: () => setState(() => _chatOpen = !_chatOpen),
                ),
              if (_controlAllowed && !_zoomMode)
                IconButton(
                  tooltip: 'Controls',
                  icon: Icon(_controlsOpen ? Icons.keyboard_hide_rounded : Icons.gamepad_outlined, color: Colors.white),
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
  final String command;
  const _Shortcut(this.label, this.command);
}

/// The slide-up panel: type-text field, mouse buttons, and the shortcut
/// grid — Flutter equivalent of ClientPage.js's sidebar "Remote Control" +
/// "Shortcuts" boxes.
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
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
                      ),
                      onSubmitted: (_) => onSendText(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(onPressed: onSendText, icon: const Icon(Icons.send_rounded, size: 18)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 0),
              child: Row(
                children: [
                  Expanded(child: _PanelButton(label: 'Right Click', onTap: () => session.control.sendRightClick())),
                  const SizedBox(width: 8),
                  Expanded(child: _PanelButton(label: 'Double Click', onTap: () => session.control.sendDoubleClick())),
                ],
              ),
            ),
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
                        return _PanelButton(label: s.label, onTap: () => session.control.sendShortcut(s.command));
                      },
                    ),
                    const SizedBox(height: 12),
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
        child: Text(label, textAlign: TextAlign.center, style: const TextStyle(fontFamily: 'monospace', color: Colors.white, fontSize: 12)),
      ),
    );
  }
}

/// In-session chat, relayed by the host over the control channel. Slides
/// up from the bottom rather than living in a permanent sidebar, since a
/// phone has no room to show the remote screen and a sidebar at once.
class _ChatPanel extends StatelessWidget {
  final List<ChatMessage> messages;
  final bool enabled;
  final TextEditingController controller;
  final VoidCallback onSend;
  final VoidCallback onClose;
  final bool hostOnly;
  final ValueChanged<bool> onTargetChanged;

  const _ChatPanel({
    required this.messages,
    required this.enabled,
    required this.controller,
    required this.onSend,
    required this.onClose,
    required this.hostOnly,
    required this.onTargetChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.5),
        decoration: const BoxDecoration(
          color: Color(0xF0121212),
          borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 8, 6),
              child: Row(
                children: [
                  const Expanded(
                    child: Text('Chat', style: TextStyle(fontFamily: 'monospace', color: Colors.white70, fontSize: 13, letterSpacing: 1)),
                  ),
                  IconButton(icon: const Icon(Icons.close_rounded, color: Colors.white54, size: 20), onPressed: onClose),
                ],
              ),
            ),
            Flexible(
              child: !enabled
                  ? const Padding(
                padding: EdgeInsets.all(20),
                child: Text('Chat is turned off by the host.',
                    style: TextStyle(fontFamily: 'monospace', color: Colors.white38, fontSize: 12)),
              )
                  : ListView.builder(
                shrinkWrap: true,
                reverse: true,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: messages.length,
                itemBuilder: (context, i) {
                  final m = messages[messages.length - 1 - i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Align(
                      alignment: m.isMe ? Alignment.centerRight : Alignment.centerLeft,
                      child: Container(
                        constraints: const BoxConstraints(maxWidth: 260),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: m.isMe ? Colors.blueAccent.withValues(alpha: 0.25) : Colors.white.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (!m.isMe)
                              Text(m.from, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.white54)),
                            Text(m.text, style: const TextStyle(fontFamily: 'monospace', fontSize: 13, color: Colors.white)),
                            if (m.isMe)
                              Text(m.hostOnly ? '🔒 Host only' : 'Everyone',
                                  style: const TextStyle(fontSize: 9, color: Colors.white38)),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            if (enabled)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
                child: Row(
                  children: [
                    const Text('SEND TO', style: TextStyle(fontFamily: 'monospace', fontSize: 10, color: Colors.white38)),
                    const SizedBox(width: 8),
                    ChoiceChip(
                      label: const Text('Everyone', style: TextStyle(fontSize: 11)),
                      selected: !hostOnly,
                      visualDensity: VisualDensity.compact,
                      onSelected: (_) => onTargetChanged(false),
                    ),
                    const SizedBox(width: 6),
                    ChoiceChip(
                      label: const Text('Host only', style: TextStyle(fontSize: 11)),
                      selected: hostOnly,
                      visualDensity: VisualDensity.compact,
                      onSelected: (_) => onTargetChanged(true),
                    ),
                  ],
                ),
              ),
            if (enabled)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: controller,
                        style: const TextStyle(fontFamily: 'monospace', color: Colors.white, fontSize: 14),
                        decoration: InputDecoration(
                          hintText: hostOnly ? 'Message to host only…' : 'Message to everyone…',
                          hintStyle: const TextStyle(color: Colors.white38),
                          isDense: true,
                          filled: true,
                          fillColor: Colors.white.withValues(alpha: 0.06),
                          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
                        ),
                        onSubmitted: (_) => onSend(),
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton.filled(onPressed: onSend, icon: const Icon(Icons.send_rounded, size: 18)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}