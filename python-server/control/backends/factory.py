"""Factory that detects display server and returns appropriate backend."""

import os
import sys
import platform
import subprocess
from typing import Optional

from .base import CapabilityTier, InputBackend
from .pyautogui import PyAutoGuiBackend
from .helper import LinuxInputHelperBackend
from .uinput import UInputBackend
from .win32 import Win32Backend
from .utils import detect_display_server, detect_wayland_compositor


def get_backend() -> InputBackend:
    """
    Factory that returns the best available input backend for the current
    environment, with capability reporting.
    """
    system = platform.system().lower()
    display_server = detect_display_server()
    
    # Windows: pyautogui (SendInput under the hood). The native Win32 backend
    # is kept only as a fallback if pyautogui isn't installed.
    if system == "windows":
        backend = PyAutoGuiBackend(display_server="windows")
        if backend.capability_tier != CapabilityTier.NONE:
            return backend
        try:
            return Win32Backend()
        except Exception as e:
            print(f"[WARN] Win32 backend failed: {e}", flush=True)
            return backend

    # macOS: pyautogui + Accessibility permissions
    if system == "darwin":
        return PyAutoGuiBackend(display_server="darwin")
    
    # Linux priority: 1) evdev (/dev/uinput)  2) pyautogui (X11/XTest)
    #                 3) native helpers (X11 helper / ydotool)  4) none
    if system == "linux":
        # 1) evdev/uinput: the compositor sees a real keyboard/mouse, so chords
        #    (Ctrl+C, Alt+Tab, Win+D...) and the Super key behave like hardware.
        #    Works on X11 and Wayland.
        try:
            return UInputBackend(display_server=display_server)
        except Exception as e:
            print(f"[WARN] evdev/uinput backend unavailable: {e}", flush=True)

        # 2) pyautogui: only useful on X11 (Wayland has no XTest).
        if display_server == "x11":
            backend = PyAutoGuiBackend(display_server="x11")
            if backend.capability_tier != CapabilityTier.NONE:
                return backend
            print("[WARN] pyautogui unavailable on X11", flush=True)

        # 3) Last-resort helpers (X11 XTest helper, or ydotool on Wayland).
        if display_server in ("x11", "wayland"):
            try:
                return LinuxInputHelperBackend()
            except Exception as e:
                print(f"[WARN] Linux helper unavailable: {e}", flush=True)

        # 4) Nothing worked.
        return _LimitedLinuxBackend(display_server=display_server or "unknown")

    # Fallback for unknown platforms
    return PyAutoGuiBackend(display_server="unknown")


class _LimitedLinuxBackend(InputBackend):
    """Minimal backend for Linux when no input control is possible."""
    
    capability_tier = CapabilityTier.NONE
    capability_description = "No input control on Wayland — run setup_uinput.sh, then log out and back in"
    display_server: Optional[str] = None
    
    def __init__(self, display_server: Optional[str] = None):
        self.display_server = display_server
        if display_server == "wayland":
            self.capability_description = "No input control on Wayland — run setup_uinput.sh, then log out and back in"
        else:
            self.capability_description = "No input control available — unknown display server"
    
    def move_mouse(self, dx: int, dy: int) -> bool:
        return False
    
    def click_mouse(self, button: str = "left") -> bool:
        return False
    
    def double_click(self) -> bool:
        return False
    
    def type_text(self, text: str, interval: float = 0.01) -> bool:
        return False
    
    def press_keys(self, *keys: str) -> bool:
        return False
    
    def press_key(self, key: str) -> bool:
        return False
    
    def hotkey(self, *keys: str) -> bool:
        return False