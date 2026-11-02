import 'package:flutter/material.dart';

/// The 5 built-in TouchBridge themes: Obsidian, Aurora, Ember, Arctic, Matrix.
enum AppThemeId { obsidian, aurora, ember, arctic, matrix }

class AppThemeDef {
  final AppThemeId id;
  final String label;
  final String emoji;
  final Color background;
  final Color surface;
  final Color primary;
  final Color accent;
  final Color textPrimary;
  final Color textSecondary;

  const AppThemeDef({
    required this.id,
    required this.label,
    required this.emoji,
    required this.background,
    required this.surface,
    required this.primary,
    required this.accent,
    required this.textPrimary,
    required this.textSecondary,
  });

  ThemeData toThemeData() {
    return ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: background,
      colorScheme: ColorScheme.dark(
        primary: primary,
        secondary: accent,
        surface: surface,
        onSurface: textPrimary,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: background,
        foregroundColor: textPrimary,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: background,
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 24),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        labelStyle: TextStyle(color: textSecondary),
      ),
      textTheme: TextTheme(
        bodyLarge: TextStyle(color: textPrimary),
        bodyMedium: TextStyle(color: textSecondary),
        titleLarge: TextStyle(color: textPrimary, fontWeight: FontWeight.bold),
      ),
      fontFamily: 'monospace', // whole app uses a monospace/terminal look
    );
  }
}

class AppThemes {
  static const obsidian = AppThemeDef(
    id: AppThemeId.obsidian,
    label: 'Obsidian',
    emoji: '🖤',
    background: Color(0xFF121212),
    surface: Color(0xFF1E1E1E),
    primary: Color(0xFFB0B0B0),
    accent: Color(0xFF9E9E9E),
    textPrimary: Color(0xFFF5F5F5),
    textSecondary: Color(0xFFAAAAAA),
  );

  static const aurora = AppThemeDef(
    id: AppThemeId.aurora,
    label: 'Aurora',
    emoji: '🌌',
    background: Color(0xFF0F1030),
    surface: Color(0xFF1B1E4A),
    primary: Color(0xFF7C4DFF),
    accent: Color(0xFF00E5FF),
    textPrimary: Color(0xFFEDEBFF),
    textSecondary: Color(0xFFA9A6D8),
  );

  static const ember = AppThemeDef(
    id: AppThemeId.ember,
    label: 'Ember',
    emoji: '🔥',
    background: Color(0xFF1A0E0A),
    surface: Color(0xFF2B140D),
    primary: Color(0xFFFF5722),
    accent: Color(0xFFFFC107),
    textPrimary: Color(0xFFFFF3E0),
    textSecondary: Color(0xFFD8A98A),
  );

  static const arctic = AppThemeDef(
    id: AppThemeId.arctic,
    label: 'Arctic',
    emoji: '🧊',
    background: Color(0xFFF0F6FA),
    surface: Color(0xFFFFFFFF),
    primary: Color(0xFF2196F3),
    accent: Color(0xFF00BCD4),
    textPrimary: Color(0xFF0A2C3D),
    textSecondary: Color(0xFF5A7A8A),
  );

  static const matrix = AppThemeDef(
    id: AppThemeId.matrix,
    label: 'Matrix',
    emoji: '💚',
    background: Color(0xFF000000),
    surface: Color(0xFF0A1A0A),
    primary: Color(0xFF00FF41),
    accent: Color(0xFF00CC33),
    textPrimary: Color(0xFF00FF41),
    textSecondary: Color(0xFF4CAF50),
  );

  static const all = <AppThemeDef>[obsidian, aurora, ember, arctic, matrix];

  static AppThemeDef byId(AppThemeId id) =>
      all.firstWhere((t) => t.id == id, orElse: () => matrix);
}
