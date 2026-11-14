"""Input backends for TouchBridge control server."""

from .base import CapabilityTier, InputBackend
from .factory import get_backend
from .utils import detect_display_server, detect_wayland_compositor
from .pyautogui import PyAutoGuiBackend
from .helper import LinuxInputHelperBackend
from .win32 import Win32Backend

__all__ = [
    'CapabilityTier',
    'InputBackend',
    'get_backend',
    'detect_display_server',
    'detect_wayland_compositor',
    'PyAutoGuiBackend',
    'LinuxInputHelperBackend',
    'Win32Backend',
]
