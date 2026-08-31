import 'package:network_info_plus/network_info_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';

/// Reads the info shown in the Server Mode "Your Network Info" panel:
/// hostname and local Wi-Fi IP address.
class DeviceInfoService {
  final _networkInfo = NetworkInfo();
  final _deviceInfo = DeviceInfoPlugin();

  /// Local IPv4 address on the current Wi-Fi/LAN, e.g. 192.168.1.42
  Future<String?> getLocalIp() async {
    try {
      return await _networkInfo.getWifiIP();
    } catch (_) {
      return null;
    }
  }

  /// Best-effort device/hostname label (Android has no true "hostname" API
  /// for user apps, so we fall back to the device model/name).
  Future<String> getHostname() async {
    try {
      final info = await _deviceInfo.androidInfo;
      return '${info.manufacturer} ${info.model}'.trim();
    } catch (_) {
      return 'Android Device';
    }
  }
}
