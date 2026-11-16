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
  static const _kPairPort = 'pair_port';
  static const _kLabel = 'device_label';
  static const _kVideoCodec = 'video_codec';
  static const _kAudioSource = 'audio_source';
  static const _kPlayRemoteAudio = 'play_remote_audio';

  AppThemeId themeId = AppThemeId.matrix; // Matrix is the default theme
  String defaultHost = '';
  int screenPort = 8080;
  int controlPort = 9999;
  int pairPort = 9997; // pairing/handshake port, matches server.py's default
  String deviceLabel = ''; // friendly name shown to hosts you pair with

  /// Video codec used when this device HOSTS a session: 'h264' (default) or
  /// 'jpeg'. Viewing needs no setting — the codec is detected per frame.
  String videoCodec = 'h264';

  /// Sound shared when this device HOSTS: 'off' (default) | 'system' | 'mic'.
  String audioSource = 'off';

  /// When VIEWING, play the host's shared audio (can still be muted on the viewer screen).
  bool playRemoteAudio = true;

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
    pairPort = _prefs!.getInt(_kPairPort) ?? 9997;
    deviceLabel = _prefs!.getString(_kLabel) ?? '';
    final codec = _prefs!.getString(_kVideoCodec);
    videoCodec = (codec == 'jpeg') ? 'jpeg' : 'h264';
    final audio = _prefs!.getString(_kAudioSource);
    audioSource = (audio == 'mic' || audio == 'system') ? audio! : 'off';
    playRemoteAudio = _prefs!.getBool(_kPlayRemoteAudio) ?? true;
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

  Future<void> setPairPort(int port) async {
    pairPort = port;
    await _prefs?.setInt(_kPairPort, port);
    notifyListeners();
  }

  Future<void> setDeviceLabel(String label) async {
    deviceLabel = label;
    await _prefs?.setString(_kLabel, label);
    notifyListeners();
  }

  Future<void> setVideoCodec(String codec) async {
    videoCodec = codec == 'jpeg' ? 'jpeg' : 'h264';
    await _prefs?.setString(_kVideoCodec, videoCodec);
    notifyListeners();
  }

  Future<void> setAudioSource(String source) async {
    audioSource = (source == 'mic' || source == 'system') ? source : 'off';
    await _prefs?.setString(_kAudioSource, audioSource);
    notifyListeners();
  }

  Future<void> setPlayRemoteAudio(bool value) async {
    playRemoteAudio = value;
    await _prefs?.setBool(_kPlayRemoteAudio, value);
    notifyListeners();
  }
}
