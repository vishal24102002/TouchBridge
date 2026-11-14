"""Factory that detects display server and returns appropriate backend."""

import os
import sys
import platform
import subprocess
from typing import Optional

from .base import CapabilityTier, InputBackend
from .pyautogui import PyAutoGuiBackend
from .helper import LinuxInputHelperBackend
from .win32 import Win32Backend
from .utils import detect_display_server, detect_wayland_compositor


def get_backend() -> InputBackend:
    """
    Factory that returns the best available input backend for the current
    environment, with capability reporting.
    """
    system = platform.system().lower()
    display_server = detect_display_server()
    
    # Windows: try native Win32 backend first
    if system == "windows":
        try:
            backend = Win32Backend()
            return backend
        except Exception as e:
            print(f"[WARN] Win32 backend failed: {e}, falling back to pyautogui", flush=True)
            return PyAutoGuiBackend(display_server="windows")
    
    # macOS: pyautogui + Accessibility permissions
    if system == "darwin":
        return PyAutoGuiBackend(display_server="darwin")
    
    # Linux: detect X11 vs Wayland
    if system == "linux":
        if display_server == "x11":
            # Try native input helper first (works at login screen)
            try:
                backend = LinuxInputHelperBackend()
                return backend
            except Exception as e:
                print(f"[WARN] Linux helper failed: {e}, falling back to pyautogui (XTest)", flush=True)
                return PyAutoGuiBackend(display_server="x11")
        
        elif display_server == "wayland":
            # Wayland: try portal/libei if available
            try:
                backend = LinuxInputHelperBackend()
                return backend
            except Exception as e:
                print(f"[WARN] Linux helper failed on Wayland: {e}", flush=True)
                # No Wayland-capable backend available
                return _LimitedLinuxBackend(display_server="wayland")
        
        else:
            # Unknown display server - fall back to limited
            return _LimitedLinuxBackend(display_server="unknown")
    
    # Fallback for unknown platforms
    return PyAutoGuiBackend(display_server="unknown")


class _LimitedLinuxBackend(InputBackend):
    """Minimal backend for Linux when no input control is possible."""
    
    capability_tier = CapabilityTier.NONE
    capability_description = "No input control available on Wayland — install input helper"
    display_server: Optional[str] = None
    
    def __init__(self, display_server: Optional[str] = None):
        self.display_server = display_server
        if display_server == "wayland":
            self.capability_description = "No input control available on Wayland — install input helper"
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
