import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../services/device_info_service.dart';
import '../services/host_server_service.dart';
import '../services/settings_service.dart';
import '../widgets/common.dart';

class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key});

  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> {
  final _deviceInfo = DeviceInfoService();
  late final HostServerService _server;

  String _ip = '—';
  String _hostname = '—';
  bool _running = false;
  bool _logExpanded = false;
  final List<String> _logLines = [];

  @override
  void initState() {
    super.initState();
    _server = HostServerService();
    _server.logs.listen((line) {
      setState(() {
        _logLines.insert(0, line);
        if (_logLines.length > 200) _logLines.removeLast();
      });
    });
    _loadNetworkInfo();
  }

  Future<void> _loadNetworkInfo() async {
    final ip = await _deviceInfo.getLocalIp();
    final host = await _deviceInfo.getHostname();
    setState(() {
      _ip = ip ?? 'Unavailable';
      _hostname = host;
    });
  }

  Future<void> _toggleServer(SettingsService settings) async {
    if (_running) {
      await _server.stop();
      setState(() => _running = false);
    } else {
      try {
        await _server.start(
          screenPort: settings.screenPort,
          controlPort: settings.controlPort,
        );
        setState(() => _running = true);
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to start server: $e')),
          );
        }
      }
    }
  }

  @override
  void dispose() {
    _server.dispose();
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
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: StatusPill(
              label: _running ? 'ONLINE' : 'OFFLINE',
              color: _running ? theme.primary : scheme.onSurface.withValues(alpha: 0.4),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
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
                            fontSize: 30,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                  ),
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
            const SizedBox(height: 14),

            Row(
              children: [
                Expanded(
                  child: _InfoTile(label: 'Hostname', value: _hostname, mono: true),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _InfoTile(label: 'Screen', value: ':${settings.screenPort}'),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _InfoTile(label: 'Control', value: ':${settings.controlPort}'),
                ),
              ],
            ),
            const SizedBox(height: 20),

            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const KickerLabel('How Remote Users Connect'),
                  const SizedBox(height: 18),
                  _Step(number: 1, text: 'Open TouchBridge → Client Mode'),
                  _Step(number: 2, text: 'Enter the IP address shown above'),
                  _Step(
                    number: 3,
                    text: 'Ports: Screen=${settings.screenPort}, Control=${settings.controlPort}',
                  ),
                  _Step(number: 4, text: 'Tap Connect'),
                ],
              ),
            ),
            const SizedBox(height: 14),

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
                onPressed: () => _toggleServer(settings),
                icon: Icon(_running ? Icons.stop_rounded : Icons.play_arrow_rounded),
                label: Text(_running ? 'Stop Server' : 'Start Server'),
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
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          KickerLabel(label),
          const SizedBox(height: 8),
          Text(
            value,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
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
                style: TextStyle(
                    color: theme.primary, fontWeight: FontWeight.bold, fontSize: 13)),
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
