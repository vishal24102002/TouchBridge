#!/usr/bin/env python3
"""
TouchBridge Python server (relay mode)
---------------------------------------
Screen capture is now done by Electron (desktopCapturer + getUserMedia +
canvas / WebCodecs), NOT by this script. Electron pipes encoded frames to
this process's stdin, length-prefixed:

    [4-byte big-endian length][payload]  (repeated, forever)

where each payload is one of:
    * JPEG / PNG image bytes (the "jpeg" codec setting; every frame stands
      alone), or
    * an H.264 access unit (the default "h264" codec setting):
          b"TBH4" + 1 flag byte (bit 0 = keyframe) + Annex-B NAL units
      Keyframes carry SPS+PPS in-band, so any viewer can start decoding at
      one. Delta frames are only meaningful after their keyframe, so the
      relay must never silently skip them (see FrameBuffer / ViewerCursor).

This script:
  1. Reads that stream on a background thread and keeps the most recent
     frame — plus, for H.264, every frame since the last keyframe — in
     memory (FrameBuffer).
  2. Serves it on TCP port 8080 (TLS-wrapped). Preferred: the client sends
     "stream:<session-token>\n" once and then receives a continuous
     [4-byte length][payload] stream (zero length = keepalive). Images:
     newest frame only. H.264: every frame in order, starting from the
     latest keyframe; a viewer that falls too far behind skips to the next
     keyframe instead of decoding garbage. Legacy:
     "capture:<session-token>\n" returns one JPEG/PNG and closes. Either
     way the token must currently be valid (see below).
  3. Runs a persistent TCP control server on port 9999 (also TLS-wrapped):
     newline-delimited text commands, but the very first line a client
     sends must be "AUTH:<session-token>\n" before anything else is
     accepted.

     Control is granted PER CONNECTED DEVICE. Any client with a valid
     token may open a control connection (view-only by default); the host
     UI sees a live list of connected control clients and can grant
     exclusive control to exactly one of them at a time via the admin
     port. See ControlSession below.

  4. Runs a TLS-wrapped PAIRING server on port 9997. Every device — found
     by direct IP or via LAN ID discovery — must connect here first,
     supply the host's password, and then wait for the host to explicitly
     Accept or Deny the request in the desktop UI before it receives a
     session token. See security.PairingManager.

  5. Runs a UDP discovery responder (default :47821) so a client that only
     knows this host's 9-digit Device ID can resolve it to an IP address
     on the local network. See security.py's module docstring for what
     this can and can't do.

  All three TCP servers (screen, control, pairing) are TLS-encrypted using
  a self-signed certificate generated once and stored in --config-dir —
  see security.py for what that does and doesn't guarantee on its own.

Usage:
    python3 server.py [--screen-port 8080] [--control-port 9999]
                       [--pair-port 9997] [--admin-port 9998]
                       [--discovery-port 47821] [--config-dir PATH]

Electron spawns this with stdio=['pipe','pipe','pipe'] so it can write to
stdin (frames) and read stdout/stderr (logs), matching electron.js.
"""

import sys
import os
import socket
import struct
import threading
import argparse
import subprocess
import webbrowser
import platform
import json
import time
import ssl
import base64
from datetime import datetime

# TLS + device identity + pairing + LAN discovery — see security.py
import security

# Import capability-tier input backend
from control import get_backend, CapabilityTier

# Try to import pyautogui for shortcuts that need it
try:
    import pyautogui
    pyautogui.FAILSAFE = False
except Exception as e:
    pyautogui = None
    print(f"[WARN] pyautogui unavailable ({e}); some shortcuts may not work", flush=True)

PLATFORM = platform.system().lower()  # 'linux' | 'windows' | 'darwin'
HOSTNAME = socket.gethostname()

# Set up in main() before any server thread starts; module-level so every
# handler function can reach them without threading them through call sites.
identity = None          # security.DeviceIdentity
pairing_manager = None   # security.PairingManager
SSL_CONTEXT = None        # ssl.SSLContext, wraps every TCP socket below

# Global input backend
_input_backend = None


def get_input_backend():
    """Lazily initialize the input backend."""
    global _input_backend
    if _input_backend is None:
        _input_backend = get_backend()
        tier, desc = _input_backend.get_capability()
        log(f"Input backend: {tier.value} - {desc}")
        if tier == CapabilityTier.NONE:
            log("WARNING: No input control available! Remote control will not work.")
    return _input_backend


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ─────────────────────────────────────────────────────────────────────────
# Frame buffer — filled by the stdin reader thread, read by screen clients
# ─────────────────────────────────────────────────────────────────────────
H264_MAGIC = b"TBH4"          # payload prefix for H.264 access units (see module docstring)
H264_FLAG_KEYFRAME = 0x01
AUDIO_MAGIC = b"TBA1"         # audio chunk: "TBA1" + channels u8 + sample-rate u32 BE + PCM16LE
AUDIO_MAX_BACKLOG = 40        # audio chunks (~20-40 ms each) a viewer may lag before the oldest are dropped

GOP_MAX_FRAMES = 900          # safety cap on frames cached since the last keyframe
GOP_MAX_BYTES = 64 * 1024 * 1024
VIEWER_MAX_BACKLOG = 20       # H.264 frames a viewer may be behind before it skips to the next keyframe


def is_h264(payload: bytes) -> bool:
    return payload[:4] == H264_MAGIC


def is_audio(payload: bytes) -> bool:
    return payload[:4] == AUDIO_MAGIC


def is_h264_keyframe(payload: bytes) -> bool:
    return len(payload) > 4 and payload[:4] == H264_MAGIC and bool(payload[4] & H264_FLAG_KEYFRAME)


class ViewerCursor:
    """Per-viewer delivery state for FrameBuffer.next_for()."""

    def __init__(self):
        self.last_seq = 0
        self.wait_key = False   # skipped some delta frames -> hold until the next keyframe
        self.last_aseq = 0      # last audio chunk delivered


class FrameBuffer:
    """Holds the newest frame and, for H.264, the frames since the last keyframe.

    Image (JPEG/PNG) viewers only ever get the newest frame, so a slow viewer
    skips frames instead of falling behind (this keeps latency flat).

    H.264 viewers must receive every frame since a keyframe, in order — a
    dropped delta frame corrupts everything until the next keyframe. So the
    buffer caches the current GOP (group of pictures): a new viewer starts from
    the latest keyframe, and a viewer that falls too far behind abandons the
    rest of the GOP and waits for the next keyframe instead.
    """

    def __init__(self):
        self._cond = threading.Condition()
        self._seq = 0
        self._frame = b""          # newest frame of any kind
        self._image = b""          # newest JPEG/PNG frame (legacy one-shot mode)
        self._gop = []             # [(seq, payload)] from the last keyframe on
        self._gop_bytes = 0
        self._aseq = 0
        self._audio = []           # [(aseq, payload)] newest audio chunks (small ring)

    def set(self, data: bytes):
        with self._cond:
            if is_audio(data):
                # Audio is its own lane: it never touches the video sequence or GOP cache.
                self._aseq += 1
                self._audio.append((self._aseq, data))
                if len(self._audio) > AUDIO_MAX_BACKLOG:
                    del self._audio[: len(self._audio) - AUDIO_MAX_BACKLOG]
                self._cond.notify_all()
                return
            if is_h264(data):
                if is_h264_keyframe(data):
                    self._gop = [(self._seq + 1, data)]
                    self._gop_bytes = len(data)
                elif self._gop:
                    if (len(self._gop) >= GOP_MAX_FRAMES
                            or self._gop_bytes + len(data) > GOP_MAX_BYTES):
                        # Encoder stopped emitting keyframes — drop the cache; viewers wait for the next one.
                        self._gop = []
                        self._gop_bytes = 0
                        return
                    self._gop.append((self._seq + 1, data))
                    self._gop_bytes += len(data)
                else:
                    return  # delta frame with no keyframe to hang it on — useless, ignore
            else:
                self._image = data
                self._gop = []
                self._gop_bytes = 0
            self._seq += 1
            self._frame = data
            self._cond.notify_all()

    def get(self) -> bytes:
        """Newest JPEG/PNG frame (legacy one-shot 'capture:' clients)."""
        with self._cond:
            return self._image

    def next_for(self, cursor: ViewerCursor, timeout: float):
        """Block until there is something new for this viewer; returns the
        payloads to send, in order (empty on timeout / when waiting for a keyframe).
        Audio chunks (if any) come first, then video."""
        with self._cond:
            if self._seq == cursor.last_seq and self._aseq == cursor.last_aseq:
                self._cond.wait(timeout)
            out = []
            if self._aseq != cursor.last_aseq:
                out = [p for s, p in self._audio if s > cursor.last_aseq]
                cursor.last_aseq = self._aseq
            return out + self._video_for(cursor)

    def _video_for(self, cursor: ViewerCursor):
        # (lock held by caller)
        if self._seq == cursor.last_seq:
            return []
        seq, latest = self._seq, self._frame

        if not is_h264(latest):
            cursor.last_seq = seq
            cursor.wait_key = False
            return [latest]

        if not self._gop:
            cursor.last_seq = seq
            return []
        if cursor.wait_key:
            if self._gop[0][0] <= cursor.last_seq:
                return []       # still the GOP we abandoned; keep waiting for a fresh keyframe
            cursor.wait_key = False
        pending = [p for s, p in self._gop if s > cursor.last_seq]
        cursor.last_seq = seq
        if len(pending) > VIEWER_MAX_BACKLOG and not is_h264_keyframe(pending[0]):
            cursor.wait_key = True   # too far behind: drop the rest of this GOP
            return []
        return pending

    def wait_newer(self, last_seq: int, timeout: float):
        """Block until a frame newer than last_seq exists (or timeout)."""
        with self._cond:
            if self._seq == last_seq:
                self._cond.wait(timeout)
            return self._seq, self._frame

    @property
    def audio_seq(self) -> int:
        with self._cond:
            return self._aseq

    @property
    def count(self) -> int:
        with self._cond:
            return self._seq


frame_buffer = FrameBuffer()


def stdin_reader_thread():
    """Reads length-prefixed frames (JPEG/PNG or H.264) piped in from Electron on stdin."""
    stdin = sys.stdin.buffer
    last_codec = None
    audio_logged = False
    log("Waiting for frames from Electron on stdin...")
    while True:
        header = _read_exact(stdin, 4)
        if header is None:
            log("stdin closed — Electron capture stream ended")
            return
        (length,) = struct.unpack(">I", header)
        payload = _read_exact(stdin, length)
        if payload is None:
            log("stdin closed mid-frame — Electron capture stream ended")
            return
        if is_audio(payload):
            if not audio_logged:
                log("Audio chunks from capture are flowing")
                audio_logged = True
            frame_buffer.set(payload)
            continue
        codec = "h264" if is_h264(payload) else "jpeg/png"
        if codec != last_codec:
            log(f"Video codec from capture: {codec}")
            last_codec = codec
        frame_buffer.set(payload)
        if frame_buffer.count == 1:
            log("First frame received from Electron")
        elif frame_buffer.count % 900 == 0:
            log(f"Received {frame_buffer.count} frames so far")


def _read_exact(stream, n: int):
    """Read exactly n bytes from a buffered stream, or None on EOF."""
    chunks = bytearray()
    while len(chunks) < n:
        chunk = stream.read(n - len(chunks))
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


# ─────────────────────────────────────────────────────────────────────────
# Screen server (port 8080, TLS) — request/response. Client must send
# "capture:<session-token>\n"; a missing/invalid/expired token gets no
# data back at all (connection just closes).
# ─────────────────────────────────────────────────────────────────────────
def _tune_socket(sock: socket.socket):
    """Disable Nagle so small control packets and frame headers go out
    immediately instead of waiting to be batched."""
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass


STREAM_SNDBUF_BYTES = 256 * 1024
STREAM_SEND_TIMEOUT = 5.0      # a viewer that can't accept data for this long is dropped
STREAM_KEEPALIVE_SECS = 5.0    # idle screen -> send an empty frame so dead peers are noticed
STREAM_REVALIDATE_SECS = 2.0   # stop streaming soon after a token is revoked/expired


def handle_screen_client(conn: socket.socket, addr):
    _tune_socket(conn)
    try:
        # Small send buffer = backpressure. Without this the OS queues MBs of
        # already-stale frames for a slow viewer and latency grows for seconds.
        # With it, sendall() blocks once ~2 frames are in flight and the loop
        # below then picks up the NEWEST frame instead of the oldest.
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, STREAM_SNDBUF_BYTES)
    except OSError:
        pass
    try:
        tls_conn = SSL_CONTEXT.wrap_socket(conn, server_side=True)
    except Exception as e:
        log(f"[ERR] TLS handshake failed for screen client {addr[0]}: {e}")
        conn.close()
        return

    try:
        tls_conn.settimeout(5.0)
        request = tls_conn.recv(1024).decode("utf-8", errors="ignore").strip()
        mode, _, token = request.partition(":")
        if mode not in ("capture", "stream") or not pairing_manager.validate(token):
            log(f"[ERR] screen client {addr[0]} sent an invalid request or expired session token")
            return

        if mode == "capture":
            # Legacy one-shot mode: one frame, then close.
            data = frame_buffer.get()
            if data:
                tls_conn.sendall(data)
            return

        # Streaming mode: [4-byte big-endian length][payload], repeated. A
        # zero-length frame is a keepalive. Images: only the newest frame is
        # sent, so a slow viewer drops frames rather than building up lag.
        # H.264: every frame in order from the latest keyframe (see FrameBuffer).
        log(f"Viewer streaming: {addr[0]}")
        tls_conn.settimeout(STREAM_SEND_TIMEOUT)
        audio_logged = False
        cursor = ViewerCursor()
        cursor.last_aseq = frame_buffer.audio_seq   # new viewers hear live audio, not the backlog
        last_sent = time.monotonic()
        last_check = last_sent
        while True:
            frames = frame_buffer.next_for(cursor, 1.0)
            now = time.monotonic()
            if frames:
                tls_conn.sendall(b"".join(struct.pack(">I", len(f)) + f for f in frames))
                last_sent = now
                if not audio_logged and any(is_audio(f) for f in frames):
                    audio_logged = True
                    log(f"Sending shared audio to viewer {addr[0]}")
            elif now - last_sent >= STREAM_KEEPALIVE_SECS:
                tls_conn.sendall(b"\x00\x00\x00\x00")
                last_sent = now
            if now - last_check >= STREAM_REVALIDATE_SECS:
                last_check = now
                if not pairing_manager.validate(token):
                    log(f"Stream for {addr[0]} ended — session token no longer valid")
                    return
    except Exception as e:
        log(f"Screen client {addr[0]} gone: {e}")
    finally:
        tls_conn.close()


def run_screen_server(port: int):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(8)
    log(f"Screen server listening on :{port}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_screen_client, args=(conn, addr), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────
# Control server (port 9999) — persistent, newline-delimited text commands
# Command set matches ClientPage.js's SHORTCUTS + sendMouseMove/sendMouseClick
# ─────────────────────────────────────────────────────────────────────────
SHORTCUT_KEYS = {
    "ctrl_c": ("ctrl", "c"),
    "ctrl_v": ("ctrl", "v"),
    "ctrl_x": ("ctrl", "x"),
    "ctrl_z": ("ctrl", "z"),
    "ctrl_a": ("ctrl", "a"),
    "ctrl_tab": ("ctrl", "tab"),
    "arrow_up": ("up",),
    "arrow_down": ("down",),
    "arrow_left": ("left",),
    "arrow_right": ("right",),
    "page_up": ("pageup",),
    "page_down": ("pagedown",),
    "backspace": ("backspace",),
    "enter": ("enter",),
    "escape": ("esc",),
    "alt_tab": ("alt", "tab"),
    "alt_f4": ("alt", "f4"),
    "win_d": ("win", "d") if PLATFORM == "windows" else ("super", "d"),
    "tab": ("tab",),
    "caps_lock": ("capslock",),
    "delete": ("delete",),
    "insert": ("insert",),
    "home": ("home",),
    "end": ("end",),
    "print_screen": ("printscreen",),
    "super": ("win",) if PLATFORM == "windows" else ("super",),
    "f1": ("f1",), "f2": ("f2",), "f3": ("f3",), "f4": ("f4",),
    "f5": ("f5",), "f6": ("f6",), "f7": ("f7",), "f8": ("f8",),
    "f9": ("f9",), "f10": ("f10",), "f11": ("f11",), "f12": ("f12",),
}


def open_terminal():
    if PLATFORM == "linux":
        for term in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm"):
            try:
                subprocess.Popen([term])
                return
            except FileNotFoundError:
                continue
        raise RuntimeError("No terminal emulator found")
    elif PLATFORM == "windows":
        subprocess.Popen(["cmd.exe"])
    elif PLATFORM == "darwin":
        subprocess.Popen(["open", "-a", "Terminal"])


def open_folder():
    home = os.path.expanduser("~")
    if PLATFORM == "linux":
        subprocess.Popen(["xdg-open", home])
    elif PLATFORM == "windows":
        os.startfile(home)  # type: ignore[attr-defined]
    elif PLATFORM == "darwin":
        subprocess.Popen(["open", home])


CLIENTS_MARKER = "__TB_CLIENTS__"  # prefix electron.js watches for on stdout


def _broadcast_clients():
    """Push the current control-client list to Electron over stdout.

    electron.js's stdout reader treats any line starting with
    CLIENTS_MARKER as structured data (not a log line) and forwards the
    JSON straight to the renderer as 'control-clients-updated', so the
    host UI updates the moment someone connects/disconnects or a grant
    changes — no polling needed.
    """
    print(CLIENTS_MARKER + json.dumps(control_session.list_clients()), flush=True)


class ControlSession:
    """Tracks every open control-channel connection and who (if anyone)
    currently holds the exclusive control grant.

    Replaces the old single global control_allowed flag: instead of one
    host-wide switch, each connecting device gets its own id and starts
    view-only. The host can grant exactly one device control at a time —
    granting a new one automatically revokes whoever had it before.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._clients = {}       # id -> {"conn": socket, "addr": ip, "connected_at": epoch}
        self._controller_id = None
        self._next_id = 1

    def register(self, conn: socket.socket, addr, label: str = "") -> int:
        with self._lock:
            cid = self._next_id
            self._next_id += 1
            self._clients[cid] = {
                "conn": conn,
                "addr": addr[0],
                "connected_at": time.time(),
                "label": label or addr[0],
            }
        return cid

    def unregister(self, cid: int):
        with self._lock:
            self._clients.pop(cid, None)
            if self._controller_id == cid:
                self._controller_id = None

    def grant(self, cid: int) -> bool:
        """Give `cid` exclusive control, revoking anyone who had it."""
        with self._lock:
            if cid not in self._clients:
                return False
            previous = self._controller_id
            self._controller_id = cid
        if previous is not None and previous != cid:
            self._notify(previous, "STATUS:REVOKED\n")
        self._notify(cid, "STATUS:GRANTED\n")
        return True

    def revoke_all(self):
        """Take control away from whoever currently has it."""
        with self._lock:
            previous = self._controller_id
            self._controller_id = None
        if previous is not None:
            self._notify(previous, "STATUS:REVOKED\n")

    def is_controller(self, cid: int) -> bool:
        with self._lock:
            return self._controller_id == cid

    def _notify(self, cid: int, message: str):
        with self._lock:
            client = self._clients.get(cid)
        if not client:
            return
        try:
            client["conn"].sendall(message.encode())
        except Exception:
            pass  # client's socket is going away on its own; nothing to do

    def list_clients(self):
        with self._lock:
            return [
                {
                    "id": cid,
                    "addr": c["addr"],
                    "label": c["label"],
                    "connectedAt": c["connected_at"],
                    "controlling": cid == self._controller_id,
                }
                for cid, c in self._clients.items()
            ]

    def broadcast(self, message: str, exclude_cid: int = None):
        """Send a raw line to every currently connected control client
        except (optionally) one — used to relay chat messages. Copies the
        connection list under the lock, then does the actual socket I/O
        outside it so one slow/dead peer can't block everyone else's turn."""
        with self._lock:
            targets = [(cid, c["conn"]) for cid, c in self._clients.items() if cid != exclude_cid]
        for cid, conn in targets:
            try:
                conn.sendall(message.encode())
            except Exception:
                pass  # that client's socket is on its way out; unregister() will clean it up


control_session = ControlSession()


class ChatState:
    """Whether chat is currently on, host-controlled. Off by default would
    be more conservative, but chat starts enabled to match what
    ServerPage.js's toggle already shows as its default; the host can turn
    it off any time via the admin port."""

    def __init__(self):
        self._lock = threading.Lock()
        self._enabled = True

    def get(self) -> bool:
        with self._lock:
            return self._enabled

    def set(self, value: bool):
        with self._lock:
            self._enabled = value


chat_state = ChatState()

CHAT_MARKER = "__TB_CHAT__"  # prefix electron.js watches for on stdout

# Files ride the same newline-delimited text channel as chat, as base64
# (see the "file:" handling below and in electron.js) rather than a
# separate binary framing scheme. Keeping a cap keeps that practical:
# MAX_FILE_BYTES bounds the decoded file itself, MAX_LINE_BYTES gives the
# line-accumulation loops below headroom for the base64 + protocol
# overhead before they give up on a single line.
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_LINE_BYTES = 8 * 1024 * 1024


def _emit_chat_to_electron(label: str, text: str = None, file_name_b64: str = None,
                            file_data_b64: str = None, source: str = "remote",
                            scope: str = "all"):
    """Tells Electron (and therefore the host's ServerPage) about a chat
    message — text or file — that just happened, so the host-side panel
    can show it. This is one-directional (server.py -> Electron); the
    host's own outgoing messages reach remote clients via
    control_session.broadcast(), called separately from the admin
    'chat:'/'file:' handlers."""
    # scope: "all" = relayed to every other device too; "host" = sent to the
    # host only (never relayed). The host UI shows a "private" badge for it.
    payload = {"from": label, "time": time.time(), "source": source, "scope": scope}
    if file_name_b64 is not None:
        payload["fileNameB64"] = file_name_b64
        payload["fileDataB64"] = file_data_b64
    else:
        payload["text"] = text
    print(CHAT_MARKER + json.dumps(payload), flush=True)


def handle_command(cmd: str):
    """Handle a control command using the capability-tier backend."""
    backend = get_input_backend()
    
    if cmd.startswith("mouse_move:"):
        dx_str, dy_str = cmd.split(":", 1)[1].split(",")
        backend.move_mouse(int(dx_str), int(dy_str))

    elif cmd == "mouse_click":
        backend.click_mouse()
    elif cmd == "mouse_right_click":
        backend.click_mouse(button="right")
    elif cmd == "mouse_double_click":
        backend.double_click()

    elif cmd.startswith("key:"):
        backend.type_text(cmd.split(":", 1)[1], interval=0.01)

    elif cmd.startswith("shortcut:"):
        name = cmd.split(":", 1)[1]
        keys = SHORTCUT_KEYS.get(name)
        ok = backend.hotkey(*keys)
        if not keys:
            raise ValueError(f"Unknown shortcut: {name}")
        if ok:
            log(f"[SHORTCUT] {name} -> {'+'.join(keys)} delivered (backend: {type(backend).__name__})")
        else:
            log(f"[WARN] shortcut '{name}' was not delivered (backend: {type(backend).__name__})")
        
    elif cmd == "open_browser":
        webbrowser.open("https://")
    elif cmd == "open_terminal":
        open_terminal()
    elif cmd.startswith("custom:open_folder"):
        open_folder()

    elif cmd in ("media_play_pause", "volume_up", "volume_mute"):
        key = {"media_play_pause": "playpause", "volume_up": "volumeup", "volume_mute": "volumemute"}[cmd]
        if hasattr(backend, "scroll"):      # uinput backend (Wayland): no pyautogui there
            backend.press_key(key)
        elif pyautogui:
            pyautogui.press(key)

    else:
        raise ValueError(f"Unrecognized command: {cmd}")


def handle_control_client(conn: socket.socket, addr):
    _tune_socket(conn)
    try:
        tls_conn = SSL_CONTEXT.wrap_socket(conn, server_side=True)
    except Exception as e:
        log(f"[ERR] TLS handshake failed for control client {addr[0]}: {e}")
        conn.close()
        return

    # First line MUST be a valid session token — issued only after this
    # device passed the password + host-acceptance pairing flow. Nothing
    # else is accepted before this succeeds.
    try:
        tls_conn.settimeout(10.0)
        first_line = b""
        while not first_line.endswith(b"\n"):
            chunk = tls_conn.recv(256)
            if not chunk:
                tls_conn.close()
                return
            first_line += chunk
        text = first_line.decode("utf-8", errors="ignore").strip()
        token = text[len("AUTH:"):] if text.startswith("AUTH:") else ""
        if not pairing_manager.validate(token):
            tls_conn.sendall(b"AUTH_FAILED:invalid_or_expired_token\n")
            tls_conn.close()
            log(f"Control client {addr[0]} rejected — invalid/missing session token")
            return
    except Exception as e:
        log(f"[ERR] control auth for {addr[0]}: {e}")
        tls_conn.close()
        return
    tls_conn.settimeout(None)
    conn = tls_conn  # rest of this function speaks over the TLS-wrapped socket

    # Get backend capability up front. A device with no input capability at
    # all can never be granted control, but it still needs a place in
    # control_session — this same channel is also how chat is carried, and
    # chat isn't gated by input capability (see the "chat:" handler below).
    # Previously a NONE-tier host closed the connection immediately after
    # NOCAP, which silently killed chat for every client too, whenever the
    # host machine had no usable input backend (e.g. Linux without
    # xdotool/ydotool installed).
    backend = get_input_backend()
    tier, description = backend.get_capability()
    no_input_capability = tier == CapabilityTier.NONE

    # Every device that connects starts view-only; the host grants control
    # explicitly and exclusively via the admin port (see run_admin_server).
    # The label comes from whatever this device supplied during pairing
    # (security.PairingManager.request's `label`), so chat and the
    # Connected Devices list can show a friendly name instead of a raw IP.
    label = pairing_manager.label_for(token)
    cid = control_session.register(conn, addr, label=label)
    log(f"Control client connected: {addr[0]} (id={cid}, label={label!r}, tier={tier.value})")
    _broadcast_clients()

    try:
        if no_input_capability:
            conn.sendall(f"NOCAP:{description}\n".encode())
        else:
            display = backend.display_server or "unknown"
            conn.sendall(f"INFO:{cid}:{tier.value}:{display}:{description}\n".encode())
            conn.sendall(
                b"STATUS:GRANTED\n" if control_session.is_controller(cid) else b"STATUS:VIEW_ONLY\n"
            )
        # Sent either way — chat availability doesn't depend on whether
        # this device can be granted control.
        conn.sendall(f"CHAT_STATE:{'on' if chat_state.get() else 'off'}\n".encode())
    except Exception as e:
        log(f"[ERR] handshake to {addr[0]}: {e}")
        control_session.unregister(cid)
        _broadcast_clients()
        conn.close()
        return

    buf = b""
    try:
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_LINE_BYTES and b"\n" not in buf:
                # A single line has grown implausibly large (bigger than
                # any legitimate file: payload should ever be) without a
                # terminator in sight — drop the connection rather than
                # buffering it indefinitely.
                log(f"[ERR] {addr[0]} (id={cid}) sent an oversized line — disconnecting")
                break
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                cmd = line.decode("utf-8", errors="ignore").strip()
                if not cmd:
                    continue

                if cmd.startswith("chat:") or cmd.startswith("chat-host:"):
                    # Chat isn't gated by the control grant — any paired,
                    # connected device can send a message regardless of
                    # whether it holds control, only whether the host has
                    # chat turned on at all.
                    #   chat:<text>       -> everyone (host + all other devices)
                    #   chat-host:<text>  -> the host only, never relayed
                    host_only = cmd.startswith("chat-host:")
                    text = cmd.split(":", 1)[1]
                    if not chat_state.get():
                        try:
                            conn.sendall(b"CHAT_ERROR:disabled\n")
                        except Exception:
                            pass
                        continue
                    if not host_only:
                        control_session.broadcast(f"CHAT:{label}:{text}\n", exclude_cid=cid)
                    _emit_chat_to_electron(label, text, source="remote",
                                           scope="host" if host_only else "all")
                    continue

                if cmd.startswith("file:") or cmd.startswith("file-host:"):
                    # Same channel/toggle as chat: — filename and content
                    # both travel as base64 (see electron.js), so this is
                    # still a plain newline-delimited text line rather than
                    # needing a separate binary framing scheme.
                    host_only = cmd.startswith("file-host:")
                    payload = cmd.split(":", 1)[1]
                    if not chat_state.get():
                        try:
                            conn.sendall(b"CHAT_ERROR:disabled\n")
                        except Exception:
                            pass
                        continue
                    try:
                        name_b64, data_b64 = payload.split(":", 1)
                        if len(base64.b64decode(data_b64)) > MAX_FILE_BYTES:
                            raise ValueError("file too large")
                    except Exception:
                        try:
                            conn.sendall(b"CHAT_ERROR:bad_file\n")
                        except Exception:
                            pass
                        continue
                    if not host_only:
                        control_session.broadcast(f"FILE:{label}:{payload}\n", exclude_cid=cid)
                    _emit_chat_to_electron(label, file_name_b64=name_b64, file_data_b64=data_b64,
                                           source="remote", scope="host" if host_only else "all")
                    continue

                if no_input_capability or not control_session.is_controller(cid):
                    # Either this host has no input backend at all (NONE
                    # tier — see above), or this device just isn't the
                    # granted controller. Either way, silently drop the
                    # command rather than executing it. The client is told
                    # about grant/revoke via pushed STATUS lines, so it
                    # shouldn't normally be sending commands in this state,
                    # but never trust the client side alone to enforce that.
                    log(f"[BLOCKED] {addr[0]} (id={cid}) sent '{cmd}' without control grant")
                    continue
                try:
                    handle_command(cmd)
                except Exception as e:
                    log(f"[ERR] control command '{cmd}': {e}")
    except Exception as e:
        log(f"[ERR] control client {addr}: {e}")
    finally:
        control_session.unregister(cid)
        _broadcast_clients()
        conn.close()
        log(f"Control client disconnected: {addr[0]} (id={cid})")


def run_control_server(port: int):
    # Initialize backend early so we know capabilities
    backend = get_input_backend()
    tier, description = backend.get_capability()
    log(f"Control backend: {tier.value} - {description}")
    
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(8)
    log(f"Control server listening on :{port}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_control_client, args=(conn, addr), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────
# Pairing server (port 9997, TLS) — every device, however it found this
# host (direct IP or LAN ID discovery), connects here FIRST. It sends one
# JSON line with the host's password and a human-readable label; if the
# password matches, the connection blocks while the host UI shows an
# Accept/Deny prompt (security.PairingManager.request). The result — a
# session token on acceptance, a denial reason otherwise — is sent back as
# one JSON line, and the connection closes either way. The token (not this
# connection) is what's actually used afterward on the screen/control
# ports.
# ─────────────────────────────────────────────────────────────────────────
PENDING_MARKER = "__TB_PENDING__"  # prefix electron.js watches for on stdout


def _broadcast_pending():
    """Push the current pending-pairing-request list to Electron, the same
    way _broadcast_clients() does for connected control clients."""
    print(PENDING_MARKER + json.dumps(pairing_manager.list_pending()), flush=True)


def handle_pairing_client(conn: socket.socket, addr):
    try:
        tls_conn = SSL_CONTEXT.wrap_socket(conn, server_side=True)
    except Exception as e:
        log(f"[ERR] TLS handshake failed for pairing client {addr[0]}: {e}")
        conn.close()
        return

    try:
        tls_conn.settimeout(10.0)
        buf = b""
        while b"\n" not in buf:
            chunk = tls_conn.recv(1024)
            if not chunk:
                return
            buf += chunk
        line, _ = buf.split(b"\n", 1)

        try:
            payload = json.loads(line.decode("utf-8", errors="ignore"))
        except Exception:
            tls_conn.sendall(b'{"status":"denied","reason":"bad_request"}\n')
            return

        password = payload.get("password", "")
        label = str(payload.get("label") or addr[0])[:64]

        if not identity.check_password(password):
            tls_conn.sendall(b'{"status":"denied","reason":"bad_password"}\n')
            log(f"Pairing rejected for {addr[0]} ({label}) — wrong password")
            return

        log(f"Pairing request from {addr[0]} ({label}) — waiting for host to accept/deny")
        # Give this thread enough headroom to sit blocked in
        # pairing_manager.request() for the full decision window.
        tls_conn.settimeout(security.PAIR_TIMEOUT_SECONDS + 10)
        token = pairing_manager.request(addr, label)

        if token:
            tls_conn.sendall((json.dumps({"status": "accepted", "token": token}) + "\n").encode())
            log(f"Pairing accepted for {addr[0]} ({label})")
        else:
            tls_conn.sendall((json.dumps({"status": "denied", "reason": "host_declined_or_timeout"}) + "\n").encode())
            log(f"Pairing denied or timed out for {addr[0]} ({label})")
    except Exception as e:
        log(f"[ERR] pairing client {addr[0]}: {e}")
    finally:
        tls_conn.close()


def run_pairing_server(port: int):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(8)
    log(f"Pairing server listening on :{port}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_pairing_client, args=(conn, addr), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────
# Admin port — LOOPBACK ONLY (127.0.0.1), never 0.0.0.0. This is how the
# local Electron process (the host's own UI) manages remote control. It is
# not reachable from other machines, so it can't be used to bypass control
# grants or the pairing flow from a remote peer.
#
# Commands:
#   list             -> JSON array of connected control clients
#   grant:<id>       -> give that client exclusive control (revokes anyone else)
#   revoke           -> take control away from whoever currently has it
#   list-pending     -> JSON array of in-flight pairing requests
#   accept:<reqid>   -> accept a pending pairing request (issues a token)
#   deny:<reqid>     -> deny a pending pairing request
#   get-id           -> JSON {"id": "...", "password": "..."}
#   regen-password   -> generates a new password, returns {"password": "..."}
#   set-password:<x> -> sets the password to exactly <x>
#   chat:<text>      -> broadcasts a message from the host to every
#                        connected control client (requires chat enabled)
#   file:<name_b64>:<data_b64> -> broadcasts a file (base64 name + base64
#                        content, both from electron.js) the same way as
#                        chat:, and under the same chat_state toggle
#   set-chat:on/off  -> toggles chat for everyone, pushes the new state
#                        live to every connected control client
def handle_admin_client(conn: socket.socket, addr):
    try:
        # Read a full line rather than a single small recv — file: payloads
        # (base64-encoded file content) can be far bigger than any other
        # admin command, so a single recv(256) would silently truncate
        # them. adminRequest on the electron.js side always terminates its
        # command with '\n' to match.
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_LINE_BYTES:
                conn.sendall(b"ERR payload_too_large\n")
                return
        data = buf.split(b"\n", 1)[0].decode("utf-8", errors="ignore").strip()
        if data == "list":
            conn.sendall((json.dumps(control_session.list_clients()) + "\n").encode())
        elif data.startswith("grant:"):
            raw_id = data.split(":", 1)[1]
            try:
                cid = int(raw_id)
            except ValueError:
                conn.sendall(b"ERR bad id\n")
                return
            ok = control_session.grant(cid)
            conn.sendall((b"OK\n" if ok else b"ERR no such client\n"))
            if ok:
                log(f"Control granted to client id={cid}")
                _broadcast_clients()
        elif data == "revoke":
            control_session.revoke_all()
            conn.sendall(b"OK\n")
            log("Control revoked from all clients")
            _broadcast_clients()
        elif data == "list-pending":
            conn.sendall((json.dumps(pairing_manager.list_pending()) + "\n").encode())
        elif data.startswith("accept:"):
            try:
                req_id = int(data.split(":", 1)[1])
            except ValueError:
                conn.sendall(b"ERR bad id\n")
                return
            ok = pairing_manager.decide(req_id, True)
            conn.sendall((b"OK\n" if ok else b"ERR no such request\n"))
            if ok:
                log(f"Pairing request id={req_id} accepted by host")
        elif data.startswith("deny:"):
            try:
                req_id = int(data.split(":", 1)[1])
            except ValueError:
                conn.sendall(b"ERR bad id\n")
                return
            ok = pairing_manager.decide(req_id, False)
            conn.sendall((b"OK\n" if ok else b"ERR no such request\n"))
            if ok:
                log(f"Pairing request id={req_id} denied by host")
        elif data == "get-id":
            conn.sendall((json.dumps(identity.info()) + "\n").encode())
        elif data == "regen-password":
            new_pw = identity.regenerate_password()
            conn.sendall((json.dumps({"password": new_pw}) + "\n").encode())
            log("Host password regenerated")
        elif data.startswith("set-password:"):
            try:
                identity.set_password(data.split(":", 1)[1])
                conn.sendall(b"OK\n")
                log("Host password changed")
            except ValueError as e:
                conn.sendall(f"ERR {e}\n".encode())
        elif data.startswith("chat:"):
            # The host itself isn't a control-channel client (it's the
            # local Electron process talking over the loopback admin
            # port), so its outgoing chat messages are broadcast here
            # rather than going through handle_control_client's "chat:"
            # branch. Still gated by the same chat_state toggle.
            text = data[len("chat:"):]
            if not chat_state.get():
                conn.sendall(b"ERR chat_disabled\n")
                return
            control_session.broadcast(f"CHAT:Host:{text}\n")
            conn.sendall(b"OK\n")
        elif data.startswith("file:"):
            # Same reasoning as chat: above — the host's outgoing files go
            # out through here rather than handle_control_client's "file:"
            # branch, but the payload shape (base64 name + base64 content)
            # and the chat_state gating are identical.
            payload = data[len("file:"):]
            if not chat_state.get():
                conn.sendall(b"ERR chat_disabled\n")
                return
            try:
                name_b64, file_b64 = payload.split(":", 1)
                if len(base64.b64decode(file_b64)) > MAX_FILE_BYTES:
                    raise ValueError("file too large")
            except Exception:
                conn.sendall(b"ERR bad_file\n")
                return
            control_session.broadcast(f"FILE:Host:{payload}\n")
            conn.sendall(b"OK\n")
        elif data == "set-chat:on":
            chat_state.set(True)
            control_session.broadcast("CHAT_STATE:on\n")
            conn.sendall(b"OK\n")
            log("Chat enabled by host")
        elif data == "set-chat:off":
            chat_state.set(False)
            control_session.broadcast("CHAT_STATE:off\n")
            conn.sendall(b"OK\n")
            log("Chat disabled by host")
        else:
            conn.sendall(b"ERR unknown command\n")
    except Exception as e:
        log(f"[ERR] admin client: {e}")
    finally:
        conn.close()


def run_admin_server(port: int):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))  # loopback only — not exposed remotely
    srv.listen(4)
    log(f"Admin (local-only) server listening on 127.0.0.1:{port}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_admin_client, args=(conn, addr), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────
def main():
    global identity, pairing_manager, SSL_CONTEXT

    default_config_dir = os.path.join(os.path.expanduser("~"), ".touchbridge")

    parser = argparse.ArgumentParser()
    parser.add_argument("--screen-port", type=int, default=8080)
    parser.add_argument("--control-port", type=int, default=9999)
    parser.add_argument("--admin-port", type=int, default=9998)
    parser.add_argument("--pair-port", type=int, default=9997)
    parser.add_argument("--discovery-port", type=int, default=security.DISCOVERY_PORT)
    parser.add_argument("--config-dir", type=str, default=default_config_dir,
                         help="Where the device ID, password, and TLS cert/key are stored")
    parser.add_argument("--chat-disabled", action="store_true",
                         help="Start this session with chat turned off (matches the Settings-page "
                              "default; the host can still flip it on/off later from the admin port "
                              "or ServerPage's Chat panel).")
    args = parser.parse_args()

    identity = security.DeviceIdentity(args.config_dir)
    SSL_CONTEXT = security.build_server_ssl_context(args.config_dir)
    pairing_manager = security.PairingManager(identity, on_change=_broadcast_pending)

    # chat_state defaults to enabled (see ChatState's docstring); apply the
    # persisted Settings-page preference on top of that before anything can
    # connect, so a "chat off by default" choice actually takes effect from
    # the first client rather than only from the next toggle.
    if args.chat_disabled:
        chat_state.set(False)

    log(f"TouchBridge relay server starting on {PLATFORM}")
    log(f"Device ID: {identity.device_id}   Password: {identity.password}")
    log("All connections are TLS-encrypted and require this password plus host acceptance.")

    threading.Thread(target=stdin_reader_thread, daemon=True).start()
    threading.Thread(target=run_control_server, args=(args.control_port,), daemon=True).start()
    threading.Thread(target=run_admin_server, args=(args.admin_port,), daemon=True).start()
    threading.Thread(target=run_pairing_server, args=(args.pair_port,), daemon=True).start()
    threading.Thread(
        target=security.run_discovery_responder,
        args=(identity, HOSTNAME, args.discovery_port),
        daemon=True,
    ).start()

    # Run the screen server on the main thread so a fatal bind error surfaces
    # clearly (and matches electron.js's expectation that startup failures
    # show up on stderr promptly).
    run_screen_server(args.screen_port)


if __name__ == "__main__":
    main()