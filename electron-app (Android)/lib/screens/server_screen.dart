import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../services/host_server_service.dart';
import '../services/input_injection_channel.dart';
import '../services/screen_capture_channel.dart';
import '../services/security_service.dart' show ChatMessage;
import '../services/settings_service.dart';
import '../services/device_info_service.dart';
import '../widgets/common.dart';

class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key});

  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> with WidgetsBindingObserver {
  final _deviceInfo = DeviceInfoService();
  late final HostServerService _server;

  String _ip = '—';
  String _hostname = '—';
  bool _running = false;
  bool _starting = false;
  bool _logExpanded = false;
  final List<String> _logLines = [];

  String _deviceId = '—';
  String _password = '—';
  bool _showPassword = false;
  final _newPasswordController = TextEditingController();
  String _passwordMsg = '';

  List<Map<String, dynamic>> _pending = [];
  List<Map<String, dynamic>> _clients = [];

  bool _chatOpen = false;
  bool _chatEnabled = true;
  final List<ChatMessage> _chatMessages = [];
  final _chatController = TextEditingController();

  bool _accessibilityEnabled = false;
  late SettingsService _settings;
  late String _appliedCodec;
  late VoidCallback _settingsListener;
  bool _overlayGranted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _server = HostServerService(
      videoFrames: ScreenCaptureChannel.videoFrames, // H.264 or JPEG frames, pushed as produced
      requestKeyframe: ScreenCaptureChannel.requestKeyframe,
      audioFrames: ScreenCaptureChannel.audioFrames, // shared sound, if enabled in Settings
    );
    // Apply a codec change from Settings to a running session right away.
    final settings = _settings = context.read<SettingsService>();
    _appliedCodec = settings.videoCodec;
    _settingsListener = () {
      if (_running && settings.videoCodec != _appliedCodec) {
        _appliedCodec = settings.videoCodec;
        ScreenCaptureChannel.setCodec(_appliedCodec);
      }
    };
    settings.addListener(_settingsListener);
    _server.init().then((_) {
      final info = _server.deviceInfo();
      if (mounted) setState(() {
        _deviceId = info['id'] ?? '—';
        _password = info['password'] ?? '—';
        _accessibilityEnabled = _server.inputReady;
      });
    });
    _server.logs.listen((line) {
      if (!mounted) return;
      setState(() {
        _logLines.insert(0, line);
        if (_logLines.length > 200) _logLines.removeLast();
      });
    });
    _server.pendingRequests.listen((list) {
      if (mounted) setState(() => _pending = list);
    });
    _server.connectedClients.listen((list) {
      if (mounted) setState(() => _clients = list);
    });
    _server.chatMessages.listen((msg) {
      if (mounted) setState(() => _chatMessages.add(msg));
    });
    _server.chatEnabledChanges.listen((v) {
      if (mounted) setState(() => _chatEnabled = v);
    });
    _loadNetworkInfo();
    _refreshInputPermissions();
  }

  // Both Accessibility and overlay permission are granted from a separate
  // Settings screen, not an in-app dialog — this is the only reliable way
  // to notice the user came back with them turned on.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refreshInputPermissions();
  }

  Future<void> _refreshInputPermissions() async {
    await _server.refreshInputCapability();
    final overlay = await InputInjectionChannel.hasOverlayPermission();
    if (!mounted) return;
    setState(() {
      _accessibilityEnabled = _server.inputReady;
      _overlayGranted = overlay;
    });
  }

  Future<void> _loadNetworkInfo() async {
    final ip = await _deviceInfo.getLocalIp();
    final host = await _deviceInfo.getHostname();
    if (!mounted) return;
    setState(() {
      _ip = ip ?? 'Unavailable';
      _hostname = host;
    });
  }

  Future<void> _toggleServer(SettingsService settings) async {
    if (_running) {
      await _server.stop();
      await ScreenCaptureChannel.stopCapture();
      if (mounted) setState(() => _running = false);
      return;
    }

    setState(() => _starting = true);

    final granted = await ScreenCaptureChannel.requestPermission();
    if (!granted) {
      if (mounted) {
        setState(() => _starting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Screen-recording permission is required to share your screen'),
          ),
        );
      }
      return;
    }
    _appliedCodec = settings.videoCodec;
    await ScreenCaptureChannel.startCapture(codec: _appliedCodec, audio: settings.audioSource);

    try {
      await _server.start(
        screenPort: settings.screenPort,
        controlPort: settings.controlPort,
      );
      if (mounted) setState(() {
        _running = true;
        _starting = false;
      });
    } catch (e) {
      await ScreenCaptureChannel.stopCapture();
      if (mounted) {
        setState(() => _starting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to start server: $e')),
        );
      }
    }
  }

  Future<void> _regeneratePassword() async {
    final pw = await _server.regeneratePassword();
    setState(() {
      _password = pw;
      _passwordMsg = 'New password generated.';
    });
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _passwordMsg = '');
    });
  }

  Future<void> _setCustomPassword() async {
    final pw = _newPasswordController.text.trim();
    if (pw.isEmpty) return;
    try {
      await _server.setPassword(pw);
      setState(() {
        _password = pw;
        _newPasswordController.clear();
        _passwordMsg = 'Password updated.';
      });
    } catch (e) {
      setState(() => _passwordMsg = 'Could not update password');
    }
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _passwordMsg = '');
    });
  }

  void _sendChat() {
    final text = _chatController.text.trim();
    if (text.isEmpty) return;
    if (_server.sendHostChat(text)) _chatController.clear();
  }

  @override
  void dispose() {
    _settings.removeListener(_settingsListener);
    WidgetsBinding.instance.removeObserver(this);
    _server.dispose();
    if (_running) ScreenCaptureChannel.stopCapture();
    _newPasswordController.dispose();
    _chatController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsService>();
    final theme = settings.currentTheme;
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: buildSubAppBar(
        context,
        plainPart: 'Server',
        accentPart: 'Mode',
        actions: [
          IconButton(
            tooltip: 'Chat',
            onPressed: () => setState(() => _chatOpen = !_chatOpen),
            icon: Badge(
              isLabelVisible: _chatMessages.isNotEmpty && !_chatOpen,
              child: const Icon(Icons.chat_bubble_outline_rounded, size: 20),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 16, left: 4),
            child: StatusPill(
              label: _running ? 'ONLINE' : 'OFFLINE',
              color: _running ? theme.primary : scheme.onSurface.withValues(alpha: 0.4),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Stack(
          children: [
            ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                OutlinedPanel(
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const KickerLabel('Your IP Address'),
                            const SizedBox(height: 8),
                            Text(
                              _ip,
                              style: const TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 26,
                                fontWeight: FontWeight.bold,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      OutlinedButton.icon(
                        onPressed: _ip == '—' || _ip == 'Unavailable'
                            ? null
                            : () {
                          Clipboard.setData(ClipboardData(text: _ip));
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('IP copied to clipboard')),
                          );
                        },
                        icon: const Icon(Icons.copy_rounded, size: 16),
                        label: const Text('Copy'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: theme.primary,
                          side: BorderSide(color: theme.primary.withValues(alpha: 0.5)),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                // 2-column info grid — reads cleanly on narrow phones,
                // unlike a 3-across Row which crowds/truncates on smaller
                // screens.
                GridView.count(
                  crossAxisCount: 2,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: 2.6,
                  children: [
                    _InfoTile(label: 'Hostname', value: _hostname, mono: true),
                    _InfoTile(label: 'Screen Port', value: '${settings.screenPort}'),
                    _InfoTile(label: 'Control Port', value: '${settings.controlPort}'),
                    const _InfoTile(label: 'Pairing Port', value: '9997'),
                  ],
                ),
                const SizedBox(height: 12),

                _DeviceIdentityPanel(
                  deviceId: _deviceId,
                  password: _password,
                  showPassword: _showPassword,
                  onToggleShow: () => setState(() => _showPassword = !_showPassword),
                  onRegenerate: _regeneratePassword,
                  newPasswordController: _newPasswordController,
                  onSetPassword: _setCustomPassword,
                  message: _passwordMsg,
                ),
                const SizedBox(height: 12),

                _InputCapabilityPanel(
                  accessibilityEnabled: _accessibilityEnabled,
                  overlayGranted: _overlayGranted,
                  onOpenAccessibilitySettings: InputInjectionChannel.openAccessibilitySettings,
                  onRequestOverlay: InputInjectionChannel.requestOverlayPermission,
                  onRefresh: _refreshInputPermissions,
                ),
                const SizedBox(height: 12),

                if (_pending.isNotEmpty) ...[
                  _PendingRequestsPanel(
                    pending: _pending,
                    onAccept: (id) => _server.acceptPairing(id),
                    onDeny: (id) => _server.denyPairing(id),
                  ),
                  const SizedBox(height: 12),
                ],

                _ConnectedDevicesPanel(
                  clients: _clients,
                  onGrant: (id) => _server.grantControl(id),
                  onRevoke: () => _server.revokeControl(),
                ),
                const SizedBox(height: 12),

                OutlinedPanel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const KickerLabel('How Remote Users Connect'),
                      const SizedBox(height: 18),
                      const _Step(number: 1, text: 'Open TouchBridge → Client Mode'),
                      const _Step(number: 2, text: 'Enter your Device ID (same network) or IP'),
                      const _Step(number: 3, text: 'Enter the password above'),
                      const _Step(number: 4, text: 'Wait for you to Accept the request here'),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                OutlinedPanel(
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
                  child: Column(
                    children: [
                      InkWell(
                        onTap: () => setState(() => _logExpanded = !_logExpanded),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          child: Row(
                            children: [
                              Icon(Icons.terminal_rounded,
                                  size: 18, color: scheme.onSurface.withValues(alpha: 0.6)),
                              const SizedBox(width: 10),
                              const Expanded(child: KickerLabel('Server Log')),
                              Icon(
                                _logExpanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                                color: scheme.onSurface.withValues(alpha: 0.6),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (_logExpanded)
                        Container(
                          width: double.infinity,
                          constraints: const BoxConstraints(maxHeight: 220),
                          padding: const EdgeInsets.only(bottom: 14),
                          child: _logLines.isEmpty
                              ? Text('No activity yet.',
                              style: TextStyle(color: scheme.onSurface.withValues(alpha: 0.4)))
                              : ListView.builder(
                            shrinkWrap: true,
                            itemCount: _logLines.length,
                            itemBuilder: (_, i) => Padding(
                              padding: const EdgeInsets.symmetric(vertical: 2),
                              child: Text(
                                _logLines[i],
                                style: TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 12,
                                  color: scheme.onSurface.withValues(alpha: 0.65),
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),

                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: _starting ? null : () => _toggleServer(settings),
                    icon: _starting
                        ? const SizedBox(
                        width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : Icon(_running ? Icons.stop_rounded : Icons.play_arrow_rounded),
                    label: Text(_starting ? 'Starting…' : (_running ? 'Stop Server' : 'Start Server')),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: theme.primary,
                      side: BorderSide(color: theme.primary.withValues(alpha: 0.6)),
                      padding: const EdgeInsets.symmetric(vertical: 18),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      textStyle: const TextStyle(
                          fontFamily: 'monospace', fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
              ],
            ),

            // Chat slides up from the bottom as a sheet rather than a
            // fixed sidebar (there's no room for a sidebar on a phone).
            if (_chatOpen)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: _ChatSheet(
                  messages: _chatMessages,
                  enabled: _chatEnabled,
                  controller: _chatController,
                  onSend: _sendChat,
                  onToggleEnabled: (v) => _server.setChatEnabled(v),
                  onClose: () => setState(() => _chatOpen = false),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _InfoTile extends StatelessWidget {
  final String label;
  final String value;
  final bool mono;
  const _InfoTile({required this.label, required this.value, this.mono = false});

  @override
  Widget build(BuildContext context) {
    return OutlinedPanel(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          KickerLabel(label),
          const SizedBox(height: 6),
          Text(
            value,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 14, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

class _Step extends StatelessWidget {
  final int number;
  final String text;
  const _Step({required this.number, required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: theme.primary.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: Text('$number',
                style: TextStyle(color: theme.primary, fontWeight: FontWeight.bold, fontSize: 13)),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 14)),
            ),
          ),
        ],
      ),
    );
  }
}

/// Device ID (permanent) + password (regenerate or set a permanent one) —
/// stacked, full-width fields read far better on a phone than the
/// side-by-side layout that works on a desktop settings panel.
class _DeviceIdentityPanel extends StatelessWidget {
  final String deviceId;
  final String password;
  final bool showPassword;
  final VoidCallback onToggleShow;
  final VoidCallback onRegenerate;
  final TextEditingController newPasswordController;
  final VoidCallback onSetPassword;
  final String message;

  const _DeviceIdentityPanel({
    required this.deviceId,
    required this.password,
    required this.showPassword,
    required this.onToggleShow,
    required this.onRegenerate,
    required this.newPasswordController,
    required this.onSetPassword,
    required this.message,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    return OutlinedPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const KickerLabel('Device ID & Password'),
          const SizedBox(height: 12),

          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('DEVICE ID', style: TextStyle(fontSize: 10, letterSpacing: 1.5, color: theme.textSecondary)),
                    const SizedBox(height: 4),
                    Text(deviceId,
                        style: TextStyle(
                            fontFamily: 'monospace', fontSize: 18, letterSpacing: 1.2, color: theme.primary, fontWeight: FontWeight.bold)),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Copy Device ID',
                icon: const Icon(Icons.copy_rounded, size: 18),
                onPressed: deviceId == '—'
                    ? null
                    : () {
                  Clipboard.setData(ClipboardData(text: deviceId));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Device ID copied')),
                  );
                },
              ),
            ],
          ),
          const SizedBox(height: 14),

          Row(
            children: [
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.15)),
                  ),
                  child: Text(
                    showPassword ? password : '•' * password.length,
                    style: TextStyle(fontFamily: 'monospace', fontSize: 16, letterSpacing: 1, color: theme.accent),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                tooltip: showPassword ? 'Hide' : 'Show',
                icon: Icon(showPassword ? Icons.visibility_off_rounded : Icons.visibility_rounded, size: 18),
                onPressed: onToggleShow,
              ),
              IconButton(
                tooltip: 'Generate a new password',
                icon: const Icon(Icons.refresh_rounded, size: 18),
                onPressed: onRegenerate,
              ),
            ],
          ),
          const SizedBox(height: 10),

          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: newPasswordController,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 14),
                  decoration: const InputDecoration(
                    hintText: 'Set a permanent password',
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(vertical: 12, horizontal: 12),
                  ),
                  onSubmitted: (_) => onSetPassword(),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: onSetPassword,
                style: OutlinedButton.styleFrom(
                  foregroundColor: theme.primary,
                  side: BorderSide(color: theme.primary.withValues(alpha: 0.5)),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                ),
                child: const Text('Save'),
              ),
            ],
          ),
          if (message.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(message, style: TextStyle(fontSize: 12, color: theme.accent, fontFamily: 'monospace')),
          ],
          const SizedBox(height: 8),
          Text(
            'Every connection — by ID or IP — needs this password, then your explicit '
                'Accept below. Connections are TLS-encrypted end to end.',
            style: TextStyle(fontSize: 11, color: theme.textSecondary, fontFamily: 'monospace', height: 1.5),
          ),
        ],
      ),
    );
  }
}

/// Whether this device can actually execute remote input right now.
/// Android requires the AccessibilityService be turned on by hand in
/// Settings — there's no in-app permission dialog for it — so this shows
/// live status plus buttons that jump straight to the right settings
/// screen, and a manual refresh in case the OS is slow to report back.
class _InputCapabilityPanel extends StatelessWidget {
  final bool accessibilityEnabled;
  final bool overlayGranted;
  final Future<void> Function() onOpenAccessibilitySettings;
  final Future<void> Function() onRequestOverlay;
  final Future<void> Function() onRefresh;

  const _InputCapabilityPanel({
    required this.accessibilityEnabled,
    required this.overlayGranted,
    required this.onOpenAccessibilitySettings,
    required this.onRequestOverlay,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    return OutlinedPanel(
      borderColor: accessibilityEnabled ? null : theme.accent.withValues(alpha: 0.5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(child: KickerLabel('Remote Input')),
              IconButton(
                tooltip: 'Re-check permissions',
                icon: const Icon(Icons.refresh_rounded, size: 18),
                onPressed: onRefresh,
              ),
            ],
          ),
          const SizedBox(height: 4),
          _PermissionRow(
            label: 'Accessibility Service',
            granted: accessibilityEnabled,
            actionLabel: 'Enable',
            onTap: onOpenAccessibilitySettings,
          ),
          const SizedBox(height: 10),
          _PermissionRow(
            label: 'Cursor overlay (optional)',
            granted: overlayGranted,
            actionLabel: 'Grant',
            onTap: onRequestOverlay,
          ),
          const SizedBox(height: 10),
          Text(
            accessibilityEnabled
                ? 'Connected devices with control can tap, drag, and type on this phone. '
                'Desktop-only shortcuts (arrow keys, Ctrl combos, F-keys) have no Android '
                'equivalent and are ignored.'
                : 'Without this, connected devices can view your screen and chat, but taps and '
                'typing won\'t do anything. Enable TouchBridge under Settings > Accessibility, '
                'then come back here.',
            style: TextStyle(fontSize: 11, color: theme.textSecondary, fontFamily: 'monospace', height: 1.5),
          ),
        ],
      ),
    );
  }
}

class _PermissionRow extends StatelessWidget {
  final String label;
  final bool granted;
  final String actionLabel;
  final Future<void> Function() onTap;

  const _PermissionRow({
    required this.label,
    required this.granted,
    required this.actionLabel,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    return Row(
      children: [
        Icon(
          granted ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
          size: 16,
          color: granted ? theme.primary : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.35),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(label, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
        ),
        if (!granted)
          OutlinedButton(
            onPressed: onTap,
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.primary,
              side: BorderSide(color: theme.primary.withValues(alpha: 0.6)),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(actionLabel, style: const TextStyle(fontSize: 12)),
          )
        else
          Text('On', style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: theme.primary)),
      ],
    );
  }
}

/// Pairing requests that passed the password check and are waiting on
/// Accept/Deny — no control or access is granted until you tap Accept.
class _PendingRequestsPanel extends StatelessWidget {
  final List<Map<String, dynamic>> pending;
  final void Function(int id) onAccept;
  final void Function(int id) onDeny;

  const _PendingRequestsPanel({required this.pending, required this.onAccept, required this.onDeny});

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    return OutlinedPanel(
      borderColor: theme.accent.withValues(alpha: 0.5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.notifications_active_rounded, size: 16, color: theme.accent),
              const SizedBox(width: 8),
              KickerLabel('Pending Requests (${pending.length})'),
            ],
          ),
          const SizedBox(height: 12),
          for (final r in pending)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${r['label']}',
                            style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, fontSize: 14)),
                        Text('${r['addr']} · password verified — awaiting your decision',
                            style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: theme.textSecondary)),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Deny',
                    icon: const Icon(Icons.close_rounded, color: Colors.redAccent),
                    onPressed: () => onDeny(r['id'] as int),
                  ),
                  IconButton(
                    tooltip: 'Accept',
                    icon: Icon(Icons.check_rounded, color: theme.primary),
                    onPressed: () => onAccept(r['id'] as int),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Every device currently holding a token'd control connection, and who
/// (if anyone) has the exclusive control grant.
class _ConnectedDevicesPanel extends StatelessWidget {
  final List<Map<String, dynamic>> clients;
  final void Function(int id) onGrant;
  final VoidCallback onRevoke;

  const _ConnectedDevicesPanel({required this.clients, required this.onGrant, required this.onRevoke});

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<SettingsService>().currentTheme;
    final anyControlling = clients.any((c) => c['controlling'] == true);
    return OutlinedPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(child: KickerLabel('Connected Devices')),
              if (anyControlling)
                TextButton(
                  onPressed: onRevoke,
                  child: const Text('Revoke All', style: TextStyle(fontSize: 12, color: Colors.redAccent)),
                ),
            ],
          ),
          const SizedBox(height: 8),
          if (clients.isEmpty)
            Text('No devices connected yet.',
                style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: theme.textSecondary))
          else
            for (final c in clients)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      margin: const EdgeInsets.only(right: 10),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: c['controlling'] == true ? theme.primary : theme.textSecondary,
                      ),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${c['label']}',
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 13, fontWeight: FontWeight.w600)),
                          Text('${c['addr']}',
                              style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: theme.textSecondary)),
                        ],
                      ),
                    ),
                    if (c['controlling'] == true)
                      OutlinedButton(
                        onPressed: onRevoke,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.redAccent,
                          side: const BorderSide(color: Colors.redAccent),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          minimumSize: Size.zero,
                        ),
                        child: const Text('Revoke', style: TextStyle(fontSize: 12)),
                      )
                    else
                      OutlinedButton(
                        onPressed: () => onGrant(c['id'] as int),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: theme.primary,
                          side: BorderSide(color: theme.primary.withValues(alpha: 0.6)),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          minimumSize: Size.zero,
                        ),
                        child: const Text('Grant', style: TextStyle(fontSize: 12)),
                      ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

/// Chat as a bottom sheet — the host side of the same relay chat that
/// Client Mode's remote view exposes. Not gated by who currently has
/// control, only whether the host has chat turned on.
class _ChatSheet extends StatelessWidget {
  final List<ChatMessage> messages;
  final bool enabled;
  final TextEditingController controller;
  final VoidCallback onSend;
  final ValueChanged<bool> onToggleEnabled;
  final VoidCallback onClose;

  const _ChatSheet({
    required this.messages,
    required this.enabled,
    required this.controller,
    required this.onSend,
    required this.onToggleEnabled,
    required this.onClose,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SafeArea(
      top: false,
      child: Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.55),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          border: Border.all(color: scheme.onSurface.withValues(alpha: 0.12)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
              child: Row(
                children: [
                  const Expanded(child: KickerLabel('Chat')),
                  Switch(value: enabled, onChanged: onToggleEnabled),
                  IconButton(icon: const Icon(Icons.close_rounded, size: 20), onPressed: onClose),
                ],
              ),
            ),
            Flexible(
              child: !enabled
                  ? Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  'Chat is turned off for this session.\nFlip the switch above to let devices message you.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: scheme.onSurface.withValues(alpha: 0.5)),
                ),
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
                          color: m.isMe
                              ? scheme.primary.withValues(alpha: 0.15)
                              : scheme.onSurface.withValues(alpha: 0.06),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (!m.isMe)
                              Text(m.hostOnly ? '${m.from} · 🔒 to you only' : '${m.from} · to everyone',
                                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: scheme.primary)),
                            Text(m.text, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
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
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: controller,
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 14),
                        decoration: const InputDecoration(
                          hintText: 'Message connected devices…',
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 12),
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