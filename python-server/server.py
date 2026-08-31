#!/usr/bin/env python3
"""
TouchBridge Python server (relay mode)
---------------------------------------
Screen capture is now done by Electron (desktopCapturer + getUserMedia +
canvas), NOT by this script. Electron pipes JPEG frames to this process's
stdin, length-prefixed:

    [4-byte big-endian length][JPEG bytes]  (repeated, forever)

This script:
  1. Reads that stream on a background thread and keeps the most recent
     frame in memory (FrameBuffer).
  2. Serves it on TCP port 8080 using the exact request/response protocol
     electron.js's `capture-screen` IPC handler and ClientPage.js already
     speak: client connects, writes anything (normally "capture\n"), this
     server writes the latest JPEG bytes back and closes the connection.
  3. Runs a persistent TCP control server on port 9999: newline-delimited
     text commands (see COMMANDS / SHORTCUTS below, matching the exact
     strings ClientPage.js sends) which are executed locally via the
     capability-tier input backend.

     Control is now granted PER CONNECTED DEVICE rather than a single
     host-wide on/off switch. Any client may open a control connection
     (view-only by default); the host UI sees a live list of connected
     control clients and can grant exclusive control to exactly one of
     them at a time via the admin port. See ControlSession below.

Usage:
    python3 server.py [--screen-port 8080] [--control-port 9999] [--admin-port 9998]

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
from datetime import datetime

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
class FrameBuffer:
    def __init__(self):
        self._lock = threading.Lock()
        self._frame = b""
        self._frame_count = 0

    def set(self, data: bytes):
        with self._lock:
            self._frame = data
            self._frame_count += 1

    def get(self) -> bytes:
        with self._lock:
            return self._frame

    @property
    def count(self) -> int:
        with self._lock:
            return self._frame_count


frame_buffer = FrameBuffer()


def stdin_reader_thread():
    """Reads length-prefixed JPEG frames piped in from Electron on stdin."""
    stdin = sys.stdin.buffer
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
        frame_buffer.set(payload)
        if frame_buffer.count == 1:
            log("First frame received from Electron")
        elif frame_buffer.count % 50 == 0:
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
# Screen server (port 8080) — request/response, matches electron.js exactly
# ─────────────────────────────────────────────────────────────────────────
def handle_screen_client(conn: socket.socket, addr):
    try:
        conn.settimeout(5.0)
        conn.recv(1024)  # consume the "capture\n" request (content ignored)
        data = frame_buffer.get()
        if data:
            conn.sendall(data)
        # closing (falling out of `with`) triggers 'end' on the Electron side
    except Exception as e:
        log(f"[ERR] screen client {addr}: {e}")
    finally:
        conn.close()


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

    def register(self, conn: socket.socket, addr) -> int:
        with self._lock:
            cid = self._next_id
            self._next_id += 1
            self._clients[cid] = {
                "conn": conn,
                "addr": addr[0],
                "connected_at": time.time(),
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
                    "connectedAt": c["connected_at"],
                    "controlling": cid == self._controller_id,
                }
                for cid, c in self._clients.items()
            ]


control_session = ControlSession()


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
        if not keys:
            raise ValueError(f"Unknown shortcut: {name}")
        backend.hotkey(*keys)

    elif cmd == "open_browser":
        webbrowser.open("https://")
    elif cmd == "open_terminal":
        open_terminal()
    elif cmd.startswith("custom:open_folder"):
        open_folder()

    elif cmd == "media_play_pause":
        if pyautogui:
            pyautogui.press("playpause")
    elif cmd == "volume_up":
        if pyautogui:
            pyautogui.press("volumeup")
    elif cmd == "volume_mute":
        if pyautogui:
            pyautogui.press("volumemute")

    else:
        raise ValueError(f"Unrecognized command: {cmd}")


def handle_control_client(conn: socket.socket, addr):
    # Get backend capability up front — a device with no input capability
    # at all can't be granted control regardless of what the host wants,
    # so there's no point registering it as a controllable device.
    backend = get_input_backend()
    tier, description = backend.get_capability()

    if tier == CapabilityTier.NONE:
        try:
            conn.sendall(f"NOCAP:{description}\n".encode())
        except Exception:
            pass
        conn.close()
        log(f"Control client {addr[0]} rejected — no input capability on this host")
        return

    # Every device that connects starts view-only; the host grants control
    # explicitly and exclusively via the admin port (see run_admin_server).
    cid = control_session.register(conn, addr)
    log(f"Control client connected: {addr[0]} (id={cid}, tier={tier.value})")
    _broadcast_clients()

    try:
        display = backend.display_server or "unknown"
        conn.sendall(f"INFO:{cid}:{tier.value}:{display}:{description}\n".encode())
        conn.sendall(
            b"STATUS:GRANTED\n" if control_session.is_controller(cid) else b"STATUS:VIEW_ONLY\n"
        )
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
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                cmd = line.decode("utf-8", errors="ignore").strip()
                if not cmd:
                    continue
                if not control_session.is_controller(cid):
                    # Connected but not (or no longer) the granted
                    # controller — silently drop the command rather than
                    # executing it. The client is told about grant/revoke
                    # via pushed STATUS lines, so it shouldn't normally be
                    # sending commands in this state, but never trust the
                    # client side alone to enforce that.
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
# Admin port — LOOPBACK ONLY (127.0.0.1), never 0.0.0.0. This is how the
# local Electron process (the host's own UI) manages remote control. It is
# not reachable from other machines, so it can't be used to bypass control
# grants from a remote peer.
#
# Commands:
#   list         -> JSON array of connected control clients
#   grant:<id>   -> give that client exclusive control (revokes anyone else)
#   revoke       -> take control away from whoever currently has it
def handle_admin_client(conn: socket.socket, addr):
    try:
        data = conn.recv(256).decode("utf-8", errors="ignore").strip()
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--screen-port", type=int, default=8080)
    parser.add_argument("--control-port", type=int, default=9999)
    parser.add_argument("--admin-port", type=int, default=9998)
    args = parser.parse_args()

    log(f"TouchBridge relay server starting on {PLATFORM}")
    threading.Thread(target=stdin_reader_thread, daemon=True).start()
    threading.Thread(target=run_control_server, args=(args.control_port,), daemon=True).start()
    threading.Thread(target=run_admin_server, args=(args.admin_port,), daemon=True).start()

    # Run the screen server on the main thread so a fatal bind error surfaces
    # clearly (and matches electron.js's expectation that startup failures
    # show up on stderr promptly).
    run_screen_server(args.screen_port)


if __name__ == "__main__":
    main()