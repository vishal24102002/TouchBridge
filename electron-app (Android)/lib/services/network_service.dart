import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// -----------------------------------------------------------------------
/// WIRE PROTOCOL — matches python-server/server.py exactly (not a guess
/// anymore; this was written against the real server + electron.js/
/// ClientPage.js source).
/// -----------------------------------------------------------------------
/// Screen channel (port 8080) — REQUEST/RESPONSE, not a stream:
///   1. Client opens a new TCP connection
///   2. Client writes anything (server ignores the content; "capture\n"
///      by convention, matching ClientPage.js)
///   3. Server writes the latest JPEG bytes, then closes the connection
///   4. Client must reconnect for the next frame — there is no persistent
///      streaming socket. We poll this on an interval (~5 fps) to emulate
///      "live" video, exactly like ClientPage.js's setInterval(...,200).
///
/// Control channel (port 9999) — persistent connection, newline-delimited
/// PLAIN TEXT commands (not JSON):
///   mouse_move:<dx>,<dy>     — relative cursor movement (trackpad-style,
///                              NOT absolute position — there is no
///                              "move to x,y" command in this protocol)
///   mouse_click              — left click at the current cursor position
///   mouse_right_click
///   mouse_double_click
///   key:<text>               — types literal text
///   shortcut:<name>          — e.g. ctrl_c, ctrl_v, arrow_up, backspace,
///                              enter, escape, alt_tab, alt_f4, win_d, ...
///   open_browser / open_terminal / custom:open_folder
///   media_play_pause / volume_up / volume_mute
/// See server.py's SHORTCUT_KEYS / handle_command() for the full set.
/// -----------------------------------------------------------------------

enum ConnectionState { disconnected, connecting, connected, error }

class ScreenFrameClient {
  String? _host;
  int? _port;
  Timer? _pollTimer;
  bool _requestInFlight = false;

  final _frameController = StreamController<Uint8List>.broadcast();
  final _stateController = StreamController<ConnectionState>.broadcast();

  Stream<Uint8List> get frames => _frameController.stream;
  Stream<ConnectionState> get connectionState => _stateController.stream;

  /// Connects (validates reachability with one capture) and starts polling.
  Future<void> connect(
    String host,
    int port, {
    Duration pollInterval = const Duration(milliseconds: 200),
    Duration requestTimeout = const Duration(seconds: 6),
  }) async {
    _host = host;
    _port = port;
    _stateController.add(ConnectionState.connecting);

    final firstFrame = await _requestFrame(requestTimeout);
    if (firstFrame == null) {
      _stateController.add(ConnectionState.error);
      throw Exception('Could not reach $host:$port');
    }
    _frameController.add(firstFrame);
    _stateController.add(ConnectionState.connected);

    _pollTimer = Timer.periodic(pollInterval, (_) async {
      if (_requestInFlight) return; // don't stack requests if one is slow
      _requestInFlight = true;
      final frame = await _requestFrame(requestTimeout);
      _requestInFlight = false;
      if (frame != null) {
        _frameController.add(frame);
      }
      // A single missed frame isn't fatal (matches ClientPage.js, which
      // just skips updating the <img> on a failed poll); only surface an
      // error state after connect() itself fails.
    });
  }

  /// Opens one connection, writes the capture request, reads until the
  /// server closes the socket, and returns the JPEG bytes (or null).
  Future<Uint8List?> _requestFrame(Duration timeout) async {
    Socket? socket;
    try {
      socket = await Socket.connect(_host!, _port!, timeout: timeout);
      socket.write('capture\n');

      final chunks = BytesBuilder(copy: false);
      final completer = Completer<void>();
      final sub = socket.listen(
        chunks.add,
        onDone: () => completer.complete(),
        onError: (_) => completer.complete(),
        cancelOnError: true,
      );
      await completer.future.timeout(timeout, onTimeout: () {});
      await sub.cancel();

      final bytes = chunks.toBytes();
      return bytes.isEmpty ? null : bytes;
    } catch (_) {
      return null;
    } finally {
      socket?.destroy();
    }
  }

  void disconnect() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _stateController.add(ConnectionState.disconnected);
  }

  void dispose() {
    disconnect();
    _frameController.close();
    _stateController.close();
  }
}

class ControlChannelClient {
  Socket? _socket;
  StreamSubscription<Uint8List>? _sub;

  /// True once connected AND the host's handshake said "ALLOWED". False if
  /// the host currently has remote control turned off (server.py sends
  /// "DENIED\n" and closes the connection) — check this before showing any
  /// control UI, don't just assume a successful socket connect means input
  /// will work.
  bool allowed = false;

  Future<void> connect(String host, int port, {Duration timeout = const Duration(seconds: 6)}) async {
    allowed = false;
    final socket = await Socket.connect(host, port, timeout: timeout);
    _socket = socket;

    final completer = Completer<void>();
    final buf = BytesBuilder(copy: false);
    _sub = socket.listen(
      (chunk) {
        if (completer.isCompleted) return; // handshake already read
        buf.add(chunk);
        final bytes = buf.toBytes();
        final newlineIndex = bytes.indexOf(10); // '\n'
        if (newlineIndex == -1) return;
        final line = String.fromCharCodes(bytes.sublist(0, newlineIndex)).trim();
        allowed = line == 'ALLOWED';
        if (!completer.isCompleted) completer.complete();
      },
      onDone: () {
        if (!completer.isCompleted) completer.complete();
      },
      onError: (_) {
        if (!completer.isCompleted) completer.complete();
      },
    );

    await completer.future.timeout(timeout, onTimeout: () {});
    if (!allowed) {
      disconnect();
    }
  }

  void _send(String command) {
    if (!allowed) return; // no point sending — host has control disabled
    _socket?.write('$command\n');
  }

  /// Relative movement, e.g. from a drag gesture's delta — this protocol
  /// has no "move to absolute x,y", only trackpad-style deltas.
  void sendMouseMoveRelative(int dx, int dy) => _send('mouse_move:$dx,$dy');

  void sendClick() => _send('mouse_click');
  void sendRightClick() => _send('mouse_right_click');
  void sendDoubleClick() => _send('mouse_double_click');

  /// Types literal text at the remote cursor/focus.
  void sendText(String text) => _send('key:$text');

  /// name matches server.py's SHORTCUT_KEYS keys, e.g. 'ctrl_c', 'enter',
  /// 'arrow_up', 'backspace', 'alt_tab', 'win_d', etc.
  void sendShortcut(String name) => _send('shortcut:$name');

  void openBrowser() => _send('open_browser');
  void openTerminal() => _send('open_terminal');
  void openFolder() => _send('custom:open_folder');
  void mediaPlayPause() => _send('media_play_pause');
  void volumeUp() => _send('volume_up');
  void volumeMute() => _send('volume_mute');

  void disconnect() {
    _sub?.cancel();
    _sub = null;
    _socket?.destroy();
    _socket = null;
    allowed = false;
  }
}

/// Bundles both channels for a single remote session (used by Client Mode).
class RemoteSession {
  final ScreenFrameClient screen = ScreenFrameClient();
  final ControlChannelClient control = ControlChannelClient();

  Future<void> connect(String host, int screenPort, int controlPort) async {
    await screen.connect(host, screenPort);
    await control.connect(host, controlPort);
  }

  void disconnect() {
    screen.disconnect();
    control.disconnect();
  }

  void dispose() {
    screen.dispose();
    control.disconnect();
  }
}
