import 'package:flutter/material.dart';
import '../theme/app_themes.dart';

class SplashScreen extends StatefulWidget {
  final VoidCallback onFinished;
  const SplashScreen({super.key, required this.onFinished});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    Future.delayed(const Duration(milliseconds: 1400), widget.onFinished);
  }

  @override
  Widget build(BuildContext context) {
    // Splash always uses the Matrix theme accent, matching the screenshot,
    // regardless of the user's saved theme (brand moment).
    const accent = AppThemes.matrix;

    return Scaffold(
      backgroundColor: accent.background,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                color: accent.primary,
                borderRadius: BorderRadius.circular(22),
                boxShadow: [
                  BoxShadow(
                    color: accent.primary.withValues(alpha: 0.55),
                    blurRadius: 60,
                    spreadRadius: 10,
                  ),
                ],
              ),
              child: Icon(Icons.podcasts_rounded, color: accent.background, size: 46),
            ),
            const SizedBox(height: 28),
            RichText(
              text: TextSpan(
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 40,
                  fontWeight: FontWeight.bold,
                ),
                children: [
                  TextSpan(text: 'Touch', style: TextStyle(color: accent.textPrimary)),
                  TextSpan(text: 'Bridge', style: TextStyle(color: accent.primary)),
                ],
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'CROSS-PLATFORM REMOTE DESKTOP',
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                letterSpacing: 4,
                color: accent.textSecondary,
              ),
            ),
            const SizedBox(height: 56),
            SizedBox(
              width: 28,
              height: 28,
              child: CircularProgressIndicator(
                strokeWidth: 2.4,
                valueColor: AlwaysStoppedAnimation(accent.primary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
