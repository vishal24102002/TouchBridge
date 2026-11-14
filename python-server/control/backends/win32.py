"""Windows native input backend using win32 APIs."""

import sys
import ctypes
import ctypes.wintypes
from typing import Optional

from .base import CapabilityTier, InputBackend


class Win32Backend(InputBackend):
    """Backend using Windows native input injection."""
    
    capability_tier = CapabilityTier.NATIVE
    capability_description = "Full Windows input control (native driver)"
    display_server = "windows"
    
    def __init__(self):
        try:
            # Try to load user32.dll
            self.user32 = ctypes.windll.user32
            # Test that keybd_event works
            self.user32.keybd_event(0, 0, 0, 0)
        except Exception as e:
            raise RuntimeError(f"Win32 backend initialization failed: {e}")
    
    def move_mouse(self, dx: int, dy: int) -> bool:
        try:
            # Get current position
            pt = ctypes.wintypes.POINT()
            self.user32.GetCursorPos(ctypes.byref(pt))
            # Move relative
            self.user32.SetCursorPos(pt.x + dx, pt.y + dy)
            return True
        except Exception:
            return False
    
    def click_mouse(self, button: str = "left") -> bool:
        try:
            MOUSEEVENTF_LEFTDOWN = 0x0002
            MOUSEEVENTF_LEFTUP = 0x0004
            MOUSEEVENTF_RIGHTDOWN = 0x0008
            MOUSEEVENTF_RIGHTUP = 0x0010
            
            if button == "left":
                down, up = MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP
            elif button == "right":
                down, up = MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP
            else:
                return False
            
            self.user32.mouse_event(down, 0, 0, 0, 0)
            self.user32.mouse_event(up, 0, 0, 0, 0)
            return True
        except Exception:
            return False
    
    def double_click(self) -> bool:
        try:
            # Double-click with minimal delay
            return self.click_mouse("left") and self.click_mouse("left")
        except Exception:
            return False
    
    def type_text(self, text: str, interval: float = 0.01) -> bool:
        # Use pyautogui as fallback for text
        try:
            import pyautogui
            pyautogui.write(text, interval=interval)
            return True
        except Exception:
            return False
    
    def press_keys(self, *keys: str) -> bool:
        try:
            for key in keys:
                self.press_key(key)
            return True
        except Exception:
            return False
    
    def press_key(self, key: str) -> bool:
        try:
            # Map key names to virtual key codes
            vk_map = {
                "ctrl": 0x11, "control": 0x11,
                "shift": 0x10, "alt": 0x12,
                "win": 0x5B, "windows": 0x5B,
                "tab": 0x09, "enter": 0x0D, "return": 0x0D,
                "esc": 0x1B, "escape": 0x1B,
                "space": 0x20, "backspace": 0x08,
                "delete": 0x2E, "del": 0x2E,
                "insert": 0x2D, "ins": 0x2D,
                "home": 0x24, "end": 0x23,
                "pageup": 0x21, "pagedown": 0x22,
                "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
                "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
                "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
                "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
                "printscreen": 0x2C, "prtsc": 0x2C,
                "scrolllock": 0x91, "pause": 0x13,
                "numlock": 0x90, "capslock": 0x14,
            }
            
            vk = vk_map.get(key.lower())
            if vk is None:
                return False
            
            # Press and release
            self.user32.keybd_event(vk, 0, 0, 0)
            self.user32.keybd_event(vk, 0, 0x0002, 0)
            return True
        except Exception:
            return False
    
    def hotkey(self, *keys: str) -> bool:
        try:
            # Press keys in order
            for key in keys:
                if not self.press_key(key):
                    return False
            # Release in reverse order
            for key in reversed(keys):
                self._release_key(key)
            return True
        except Exception:
            return False
    
    def _release_key(self, key: str) -> bool:
        # Same as press_key but with KEYEVENTF_KEYUP flag
        try:
            vk_map = {
                "ctrl": 0x11, "control": 0x11,
                "shift": 0x10, "alt": 0x12,
                "win": 0x5B, "windows": 0x5B,
                "tab": 0x09, "enter": 0x0D,
                "esc": 0x1B, "escape": 0x1B,
                "space": 0x20, "backspace": 0x08,
                "delete": 0x2E, "del": 0x2E,
                "insert": 0x2D, "ins": 0x2D,
                "home": 0x24, "end": 0x23,
                "pageup": 0x21, "pagedown": 0x22,
                "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
                "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
                "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
                "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
            }
            vk = vk_map.get(key.lower())
            if vk is None:
                return False
            self.user32.keybd_event(vk, 0, 0x0002, 0)
            return True
        except Exception:
            return False