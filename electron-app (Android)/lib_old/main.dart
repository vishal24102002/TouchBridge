import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/settings_service.dart';
import 'screens/splash_screen.dart';
import 'screens/home_screen.dart';

void main() {
  runApp(const TouchBridgeApp());
}

class TouchBridgeApp extends StatefulWidget {
  const TouchBridgeApp({super.key});

  @override
  State<TouchBridgeApp> createState() => _TouchBridgeAppState();
}

class _TouchBridgeAppState extends State<TouchBridgeApp> {
  final _settings = SettingsService();
  bool _ready = false;
  bool _splashDone = false;

  @override
  void initState() {
    super.initState();
    _settings.load().then((_) => setState(() => _ready = true));
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<SettingsService>.value(
      value: _settings,
      child: Builder(
        builder: (context) {
          final settings = context.watch<SettingsService>();
          return MaterialApp(
            title: 'TouchBridge',
            debugShowCheckedModeBanner: false,
            theme: settings.currentTheme.toThemeData(),
            home: (!_ready || !_splashDone)
                ? SplashScreen(onFinished: () => setState(() => _splashDone = true))
                : const HomeScreen(),
          );
        },
      ),
    );
  }
}
