"""PyAutoGUI backend with capability tier reporting."""

import sys
from typing import Optional

try:
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0
except ImportError:
    pyautogui = None

from .base import CapabilityTier, InputBackend


class PyAutoGuiBackend(InputBackend):
    """Backend using pyautogui (XTest on X11, Accessibility on macOS)."""
    
    capability_description = "X11 input control (pyautogui/XTest)"
    display_server: Optional[str] = None
    
    def __init__(self, display_server: Optional[str] = None):
        self.display_server = display_server
        
        if pyautogui is None:
            self.capability_tier = CapabilityTier.NONE
            self.capability_description = "pyautogui not installed"
            return
        
        # Detect tier based on display server
        if display_server == "x11":
            self.capability_tier = CapabilityTier.X11
            self.capability_description = "Full X11 input control (XTest extension)"
        elif display_server == "darwin":
            self.capability_tier = CapabilityTier.LIMITED
            self.capability_description = "macOS input control (requires Accessibility permissions)"
        elif display_server == "windows":
            self.capability_tier = CapabilityTier.LIMITED
            self.capability_description = "Windows input control (pyautogui fallback)"
        else:
            self.capability_tier = CapabilityTier.LIMITED
            self.capability_description = "Limited input control (pyautogui fallback)"
    
    def _check_available(self) -> bool:
        return pyautogui is not None
    
    def move_mouse(self, dx: int, dy: int) -> bool:
        if not self._check_available():
            return False
        try:
            pyautogui.moveRel(dx, dy)
            return True
        except Exception:
            return False
    
    def click_mouse(self, button: str = "left") -> bool:
        if not self._check_available():
            return False
        try:
            pyautogui.click(button=button)
            return True
        except Exception:
            return False
    
    def double_click(self) -> bool:
        if not self._check_available():
            return False
        try:
            pyautogui.doubleClick()
            return True
        except Exception:
            return False
    
    def type_text(self, text: str, interval: float = 0.01) -> bool:
        if not self._check_available():
            return False
        try:
            pyautogui.write(text, interval=interval)
            return True
        except Exception:
            return False
    
    def press_keys(self, *keys: str) -> bool:
        if not self._check_available():
            return False
        try:
            for key in keys:
                pyautogui.press(key)
            return True
        except Exception:
            return False
    
    def press_key(self, key: str) -> bool:
        if not self._check_available():
            return False
        try:
            pyautogui.press(key)
            return True
        except Exception:
            return False
    
    def hotkey(self, *keys: str) -> bool:
        if not self._check_available():
            return False
        try:
            pyautogui.hotkey(*keys)
            return True
        except Exception:
            return False