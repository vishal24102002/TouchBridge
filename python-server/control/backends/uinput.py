"""Linux /dev/uinput backend (python-evdev) — input control on Wayland.

Wayland deliberately has no XTest-style API, so pyautogui can't inject input
there. This backend creates two virtual devices (a mouse and a keyboard)
through the kernel's uinput interface. The compositor sees them as ordinary
hardware, so it works on GNOME, KDE, Sway, Hyprland... and also on X11 and
at the login screen.

Requirements (one-time, see setup_uinput.sh in the project root):
  * the `uinput` kernel module loaded
  * the user in the `uinput` group (log out/in afterwards) with a udev rule
    giving that group access to /dev/uinput
  * `pip install evdev`

Limits: keyboard input assumes a US key layout (uinput sends physical key
codes, not characters), so type_text() can only type characters reachable on a
US keyboard; others are skipped and reported as a failure.
"""

import threading
import time
from typing import Dict, Optional, Tuple

from .base import CapabilityTier, InputBackend

try:
    from evdev import UInput, ecodes as e
    print("import sucessfull")
except ImportError:  # pragma: no cover - reported via RuntimeError in __init__
    UInput = None
    e = None


def _build_key_map() -> Dict[str, int]:
    k: Dict[str, int] = {}
    for c in "abcdefghijklmnopqrstuvwxyz":
        k[c] = getattr(e, f"KEY_{c.upper()}")
    for d in "0123456789":
        k[d] = getattr(e, f"KEY_{d}")
    for n in range(1, 13):
        k[f"f{n}"] = getattr(e, f"KEY_F{n}")
    k.update({
        "ctrl": e.KEY_LEFTCTRL, "control": e.KEY_LEFTCTRL,
        "alt": e.KEY_LEFTALT, "shift": e.KEY_LEFTSHIFT,
        "win": e.KEY_LEFTMETA, "super": e.KEY_LEFTMETA, "meta": e.KEY_LEFTMETA,
        "tab": e.KEY_TAB, "enter": e.KEY_ENTER, "return": e.KEY_ENTER,
        "esc": e.KEY_ESC, "escape": e.KEY_ESC,
        "backspace": e.KEY_BACKSPACE, "delete": e.KEY_DELETE,
        "insert": e.KEY_INSERT, "home": e.KEY_HOME, "end": e.KEY_END,
        "pageup": e.KEY_PAGEUP, "pagedown": e.KEY_PAGEDOWN,
        "up": e.KEY_UP, "down": e.KEY_DOWN, "left": e.KEY_LEFT, "right": e.KEY_RIGHT,
        "capslock": e.KEY_CAPSLOCK, "printscreen": e.KEY_SYSRQ,
        "space": e.KEY_SPACE,
        "playpause": e.KEY_PLAYPAUSE, "volumeup": e.KEY_VOLUMEUP,
        "volumedown": e.KEY_VOLUMEDOWN, "volumemute": e.KEY_MUTE,
    })
    return k


def _build_char_map() -> Dict[str, Tuple[int, bool]]:
    """char -> (keycode, needs_shift) for a US layout."""
    m: Dict[str, Tuple[int, bool]] = {}
    for c in "abcdefghijklmnopqrstuvwxyz":
        code = getattr(e, f"KEY_{c.upper()}")
        m[c] = (code, False)
        m[c.upper()] = (code, True)
    for d in "0123456789":
        m[d] = (getattr(e, f"KEY_{d}"), False)
    for ch, d in zip(")!@#$%^&*(", "0123456789"):
        m[ch] = (getattr(e, f"KEY_{d}"), True)
    plain = {
        " ": e.KEY_SPACE, "\n": e.KEY_ENTER, "\t": e.KEY_TAB,
        "-": e.KEY_MINUS, "=": e.KEY_EQUAL, "[": e.KEY_LEFTBRACE,
        "]": e.KEY_RIGHTBRACE, "\\": e.KEY_BACKSLASH, ";": e.KEY_SEMICOLON,
        "'": e.KEY_APOSTROPHE, "`": e.KEY_GRAVE, ",": e.KEY_COMMA,
        ".": e.KEY_DOT, "/": e.KEY_SLASH,
    }
    shifted = {
        "_": e.KEY_MINUS, "+": e.KEY_EQUAL, "{": e.KEY_LEFTBRACE,
        "}": e.KEY_RIGHTBRACE, "|": e.KEY_BACKSLASH, ":": e.KEY_SEMICOLON,
        '"': e.KEY_APOSTROPHE, "~": e.KEY_GRAVE, "<": e.KEY_COMMA,
        ">": e.KEY_DOT, "?": e.KEY_SLASH,
    }
    for ch, code in plain.items():
        m[ch] = (code, False)
    for ch, code in shifted.items():
        m[ch] = (code, True)
    return m


class UInputBackend(InputBackend):
    """Virtual mouse + keyboard via /dev/uinput."""

    capability_tier = CapabilityTier.NATIVE
    capability_description = "Full input control (virtual devices via /dev/uinput)"

    def __init__(self, display_server: Optional[str] = None):
        if UInput is None:
            raise RuntimeError("python-evdev is not installed (pip install evdev)")
        self.display_server = display_server
        self._lock = threading.Lock()
        self._key_map = _build_key_map()
        self._char_map = _build_char_map()
        try:
            self._mouse = UInput(
                {
                    e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE],
                    e.EV_REL: [e.REL_X, e.REL_Y, e.REL_WHEEL, e.REL_HWHEEL],
                },
                name="TouchBridge Virtual Mouse",
            )
            self._kbd = UInput(
                {e.EV_KEY: sorted(set(self._key_map.values())
                                  | {c for c, _ in self._char_map.values()})},
                name="TouchBridge Virtual Keyboard",
            )
        except PermissionError as exc:
            raise RuntimeError(
                "No permission for /dev/uinput — run setup_uinput.sh with sudo, "
                "then log out and back in"
            ) from exc
        except OSError as exc:
            raise RuntimeError(
                f"Cannot open /dev/uinput ({exc}) — is the uinput module loaded? "
                "(run setup_uinput.sh)"
            ) from exc
        # Give the compositor a moment to notice the new devices.
        time.sleep(0.3)

    # ── mouse ──────────────────────────────────────────────────────────
    def move_mouse(self, dx: int, dy: int) -> bool:
        try:
            with self._lock:
                if dx:
                    self._mouse.write(e.EV_REL, e.REL_X, int(dx))
                if dy:
                    self._mouse.write(e.EV_REL, e.REL_Y, int(dy))
                self._mouse.syn()
            return True
        except Exception:
            return False

    def scroll(self, h: int = 0, v: int = 0) -> bool:
        """Wheel notches (positive v = up, positive h = right)."""
        try:
            with self._lock:
                if v:
                    self._mouse.write(e.EV_REL, e.REL_WHEEL, int(v))
                if h:
                    self._mouse.write(e.EV_REL, e.REL_HWHEEL, int(h))
                self._mouse.syn()
            return True
        except Exception:
            return False

    def _click(self, btn: int) -> None:
        self._mouse.write(e.EV_KEY, btn, 1)
        self._mouse.syn()
        time.sleep(0.01)
        self._mouse.write(e.EV_KEY, btn, 0)
        self._mouse.syn()

    def click_mouse(self, button: str = "left") -> bool:
        btn = {"left": e.BTN_LEFT, "right": e.BTN_RIGHT, "middle": e.BTN_MIDDLE}.get(button)
        if btn is None:
            return False
        try:
            with self._lock:
                self._click(btn)
            return True
        except Exception:
            return False

    def double_click(self) -> bool:
        try:
            with self._lock:
                self._click(e.BTN_LEFT)
                time.sleep(0.05)
                self._click(e.BTN_LEFT)
            return True
        except Exception:
            return False

    # ── keyboard ───────────────────────────────────────────────────────
    def _tap(self, codes, shift: bool = False) -> None:
        """Press codes in order, then release in reverse (a chord)."""
        seq = ([e.KEY_LEFTSHIFT] if shift else []) + list(codes)
        for c in seq:
            self._kbd.write(e.EV_KEY, c, 1)
        self._kbd.syn()
        for c in reversed(seq):
            self._kbd.write(e.EV_KEY, c, 0)
        self._kbd.syn()

    def _chord(self, codes) -> None:
        """Press keys one at a time, hold, release in reverse — like a person
        (or the standalone uinput test): modifier down, key down, short hold, key up,
        modifier up, each step flushed with its own SYN. Compositors (GNOME, KDE,
        Hyprland...) act on shortcuts such as Super+D far more reliably this way
        than when everything happens in a single event batch."""
        codes = list(codes)
        for c in codes:
            self._kbd.write(e.EV_KEY, c, 1)
            self._kbd.syn()
            time.sleep(0.02)
        time.sleep(0.05)
        for c in reversed(codes):
            self._kbd.write(e.EV_KEY, c, 0)
            self._kbd.syn()
            time.sleep(0.02)

    def type_text(self, text: str, interval: float = 0.01) -> bool:
        ok = True
        try:
            with self._lock:
                for ch in text:
                    entry = self._char_map.get(ch)
                    if entry is None:
                        ok = False  # not reachable on a US layout
                        continue
                    code, shift = entry
                    self._tap([code], shift)
                    if interval:
                        time.sleep(interval)
            return ok
        except Exception:
            return False

    def _codes(self, keys):
        codes = [self._key_map.get(str(k).lower()) for k in keys]
        return None if any(c is None for c in codes) else codes

    def press_key(self, key: str) -> bool:
        codes = self._codes([key])
        if codes is None:
            return False
        try:
            with self._lock:
                self._chord(codes)
            return True
        except Exception:
            return False

    def press_keys(self, *keys: str) -> bool:
        return all([self.press_key(k) for k in keys])

    def hotkey(self, *keys: str) -> bool:
        codes = self._codes(keys)
        if codes is None:
            return False
        try:
            with self._lock:
                self._chord(codes)
            return True
        except Exception:
            return False

    def close(self) -> None:
        for dev in (getattr(self, "_mouse", None), getattr(self, "_kbd", None)):
            try:
                if dev:
                    dev.close()
            except Exception:
                pass
