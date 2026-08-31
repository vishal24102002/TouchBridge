import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_themes.dart';

/// Holds and persists user preferences: theme + connection defaults.
/// Mirrors the "Settings & Preferences" screen in the TouchBridge README:
/// - Color theme
/// - Default Server Host (pre-fills Client Mode IP field)
/// - Screen Port (default 8080)
/// - Control Port (default 9999)
class SettingsService extends ChangeNotifier {
  static const _kTheme = 'theme_id';
  static const _kDefaultHost = 'default_host';
  static const _kScreenPort = 'screen_port';
  static const _kControlPort = 'control_port';

  AppThemeId themeId = AppThemeId.matrix; // Matrix is the default theme
  String defaultHost = '';
  int screenPort = 8080;
  int controlPort = 9999;

  SharedPreferences? _prefs;

  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    final storedTheme = _prefs!.getString(_kTheme);
    if (storedTheme != null) {
      themeId = AppThemeId.values.firstWhere(
        (e) => e.name == storedTheme,
        orElse: () => AppThemeId.matrix,
      );
    }
    defaultHost = _prefs!.getString(_kDefaultHost) ?? '';
    screenPort = _prefs!.getInt(_kScreenPort) ?? 8080;
    controlPort = _prefs!.getInt(_kControlPort) ?? 9999;
    notifyListeners();
  }

  AppThemeDef get currentTheme => AppThemes.byId(themeId);

  Future<void> setTheme(AppThemeId id) async {
    themeId = id;
    await _prefs?.setString(_kTheme, id.name);
    notifyListeners();
  }

  Future<void> setDefaultHost(String host) async {
    defaultHost = host;
    await _prefs?.setString(_kDefaultHost, host);
    notifyListeners();
  }

  Future<void> setScreenPort(int port) async {
    screenPort = port;
    await _prefs?.setInt(_kScreenPort, port);
    notifyListeners();
  }

  Future<void> setControlPort(int port) async {
    controlPort = port;
    await _prefs?.setInt(_kControlPort, port);
    notifyListeners();
  }
}
