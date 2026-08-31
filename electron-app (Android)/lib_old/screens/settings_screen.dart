import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../services/settings_service.dart';
import '../theme/app_themes.dart';
import '../widgets/common.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late TextEditingController _hostController;
  late TextEditingController _screenPortController;
  late TextEditingController _controlPortController;

  @override
  void initState() {
    super.initState();
    final settings = context.read<SettingsService>();
    _hostController = TextEditingController(text: settings.defaultHost);
    _screenPortController = TextEditingController(text: '${settings.screenPort}');
    _controlPortController = TextEditingController(text: '${settings.controlPort}');
  }

  @override
  void dispose() {
    _hostController.dispose();
    _screenPortController.dispose();
    _controlPortController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsService>();
    final theme = settings.currentTheme;

    const setupSnippet = '# Install dependencies\n'
        'pip install -r requirements.txt\n\n'
        '# Linux (X11)\nsudo apt install xdotool\n\n'
        '# Linux (Wayland)\nsudo apt install ydotool\n'
        'sudo systemctl enable --now ydotoold';

    return Scaffold(
      appBar: buildSubAppBar(context, plainPart: '', accentPart: 'Settings'),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            const SectionHeader(emoji: '🎨', title: 'Color Theme'),
            const SizedBox(height: 16),
            GridView.count(
              crossAxisCount: 3,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1,
              children: AppThemes.all.map((t) {
                final selected = t.id == settings.themeId;
                return _ThemeTile(
                  def: t,
                  selected: selected,
                  onTap: () => settings.setTheme(t.id),
                );
              }).toList(),
            ),
            const SizedBox(height: 20),

            // Live preview strip
            OutlinedPanel(
              child: Row(
                children: [
                  Expanded(
                    child: RichText(
                      text: TextSpan(
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 17, fontWeight: FontWeight.bold),
                        children: [
                          TextSpan(text: 'Touch', style: TextStyle(color: theme.textPrimary)),
                          TextSpan(text: 'Bridge', style: TextStyle(color: theme.primary)),
                        ],
                      ),
                    ),
                  ),
                  StatusPill(label: 'OK', color: theme.primary, showDot: false, filled: true),
                  const SizedBox(width: 8),
                  const StatusPill(label: 'ERR', color: Colors.redAccent, showDot: false),
                  const SizedBox(width: 8),
                  StatusPill(
                    label: 'OFF',
                    color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.4),
                    showDot: false,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),

            const SectionHeader(emoji: '🌐', title: 'Connection Defaults'),
            const SizedBox(height: 16),
            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const KickerLabel('Default Host Address'),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _hostController,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 18),
                    decoration: const InputDecoration(
                      hintText: '192.168.1.100',
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(vertical: 14, horizontal: 14),
                    ),
                    onChanged: settings.setDefaultHost,
                  ),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const KickerLabel('Screen Port'),
                            const SizedBox(height: 8),
                            TextField(
                              controller: _screenPortController,
                              keyboardType: TextInputType.number,
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 16),
                              decoration: const InputDecoration(isDense: true),
                              onChanged: (v) {
                                final p = int.tryParse(v);
                                if (p != null) settings.setScreenPort(p);
                              },
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const KickerLabel('Control Port'),
                            const SizedBox(height: 8),
                            TextField(
                              controller: _controlPortController,
                              keyboardType: TextInputType.number,
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 16),
                              decoration: const InputDecoration(isDense: true),
                              onChanged: (v) {
                                final p = int.tryParse(v);
                                if (p != null) settings.setControlPort(p);
                              },
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),

            const SectionHeader(emoji: '⚙️', title: 'Server Setup'),
            const SizedBox(height: 16),
            OutlinedPanel(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    setupSnippet,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 13,
                      height: 1.6,
                      color: theme.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                      onPressed: () {
                        Clipboard.setData(const ClipboardData(text: setupSnippet));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Setup commands copied')),
                        );
                      },
                      icon: const Icon(Icons.copy_rounded, size: 16),
                      label: const Text('Copy'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ThemeTile extends StatelessWidget {
  final AppThemeDef def;
  final bool selected;
  final VoidCallback onTap;
  const _ThemeTile({required this.def, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        decoration: BoxDecoration(
          color: selected ? def.primary.withValues(alpha: 0.15) : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: selected
                ? def.primary
                : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.15),
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(def.emoji, style: const TextStyle(fontSize: 26)),
            const SizedBox(height: 8),
            Text(
              def.label,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 13,
                color: selected
                    ? def.primary
                    : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
