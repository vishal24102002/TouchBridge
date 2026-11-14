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
     strings ClientPage.js sends) which are executed locally via pyautogui
     (mouse/keyboard) so a remote peer can drive this machine.

Usage:
    python3 server.py [--screen-port 8080] [--control-port 9999]

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
from datetime import datetime

try:
    import pyautogui
    pyautogui.FAILSAFE = False
except Exception as e:  # pragma: no cover - environment dependent
    pyautogui = None
    print(f"[WARN] pyautogui unavailable ({e}); input control will be disabled", flush=True)

PLATFORM = platform.system().lower()  # 'linux' | 'windows' | 'darwin'


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
}


def _require_pyautogui():
    if pyautogui is None:
        raise RuntimeError("pyautogui is not available on this host")


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


def handle_command(cmd: str):
    _require_pyautogui()

    if cmd.startswith("mouse_move:"):
        dx_str, dy_str = cmd.split(":", 1)[1].split(",")
        pyautogui.moveRel(int(dx_str), int(dy_str))

    elif cmd == "mouse_click":
        pyautogui.click()
    elif cmd == "mouse_right_click":
        pyautogui.click(button="right")
    elif cmd == "mouse_double_click":
        pyautogui.doubleClick()

    elif cmd.startswith("key:"):
        pyautogui.write(cmd.split(":", 1)[1], interval=0.01)

    elif cmd.startswith("shortcut:"):
        name = cmd.split(":", 1)[1]
        keys = SHORTCUT_KEYS.get(name)
        if not keys:
            raise ValueError(f"Unknown shortcut: {name}")
        pyautogui.hotkey(*keys)

    elif cmd == "open_browser":
        webbrowser.open("https://")
    elif cmd == "open_terminal":
        open_terminal()
    elif cmd.startswith("custom:open_folder"):
        open_folder()

    elif cmd == "media_play_pause":
        pyautogui.press("playpause")
    elif cmd == "volume_up":
        pyautogui.press("volumeup")
    elif cmd == "volume_mute":
        pyautogui.press("volumemute")

    else:
        raise ValueError(f"Unrecognized command: {cmd}")


def handle_control_client(conn: socket.socket, addr):
    log(f"Control client connected: {addr[0]}")
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
                try:
                    handle_command(cmd)
                except Exception as e:
                    log(f"[ERR] control command '{cmd}': {e}")
    except Exception as e:
        log(f"[ERR] control client {addr}: {e}")
    finally:
        conn.close()
        log(f"Control client disconnected: {addr[0]}")


def run_control_server(port: int):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(8)
    log(f"Control server listening on :{port}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle_control_client, args=(conn, addr), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--screen-port", type=int, default=8080)
    parser.add_argument("--control-port", type=int, default=9999)
    args = parser.parse_args()

    log(f"TouchBridge relay server starting on {PLATFORM}")
    threading.Thread(target=stdin_reader_thread, daemon=True).start()
    threading.Thread(target=run_control_server, args=(args.control_port,), daemon=True).start()

    # Run the screen server on the main thread so a fatal bind error surfaces
    # clearly (and matches electron.js's expectation that startup failures
    # show up on stderr promptly).
    run_screen_server(args.screen_port)


if __name__ == "__main__":
    main()
