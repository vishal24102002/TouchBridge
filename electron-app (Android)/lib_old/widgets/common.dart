import 'package:flutter/material.dart';

/// A rounded outline "pill" badge, e.g. the "• REMOTE DESKTOP" badge on Home
/// or the "OFFLINE" status badge on Server Mode.
class StatusPill extends StatelessWidget {
  final String label;
  final Color color;
  final bool showDot;
  final bool filled;

  const StatusPill({
    super.key,
    required this.label,
    required this.color,
    this.showDot = true,
    this.filled = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: filled ? color.withValues(alpha: 0.15) : Colors.transparent,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (showDot) ...[
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            const SizedBox(width: 8),
          ],
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 12,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

/// A bordered rounded container matching the "card" look used for
/// info panels throughout the app (IP address card, tips card, etc).
class OutlinedPanel extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? borderColor;

  const OutlinedPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.borderColor,
  });

  @override
  Widget build(BuildContext context) {
    final surface = Theme.of(context).colorScheme.surface;
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: surface.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: borderColor ?? Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.12),
        ),
      ),
      child: child,
    );
  }
}

/// Small uppercase, letter-spaced label used above values ("YOUR IP ADDRESS",
/// "HOSTNAME", "SERVER ADDRESS", etc).
class KickerLabel extends StatelessWidget {
  final String text;
  const KickerLabel(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 2,
        fontWeight: FontWeight.w600,
        color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
      ),
    );
  }
}

/// Section header with emoji icon + title, e.g. "🎨 Color Theme".
class SectionHeader extends StatelessWidget {
  final String emoji;
  final String title;
  const SectionHeader({super.key, required this.emoji, required this.title});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text(emoji, style: const TextStyle(fontSize: 20)),
        const SizedBox(width: 10),
        Text(
          title,
          style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 19),
        ),
      ],
    );
  }
}

/// Reusable back-chevron + title app bar used on every sub-screen.
PreferredSizeWidget buildSubAppBar(
  BuildContext context, {
  required String plainPart,
  required String accentPart,
  List<Widget> actions = const [],
}) {
  final accent = Theme.of(context).colorScheme.primary;
  return AppBar(
    titleSpacing: 0,
    title: RichText(
      text: TextSpan(
        style: Theme.of(context).textTheme.titleLarge,
        children: [
          TextSpan(text: '$plainPart '),
          TextSpan(text: accentPart, style: TextStyle(color: accent)),
        ],
      ),
    ),
    actions: actions,
  );
}
