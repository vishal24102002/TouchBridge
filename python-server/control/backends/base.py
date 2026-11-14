"""Base input backend with capability tier reporting."""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Tuple, Optional


class CapabilityTier(str, Enum):
    """How capable this input backend is, highest to lowest."""
    
    # Native driver-level injection (works at login screen, no permissions needed)
    NATIVE = "native"
    
    # X11 XTest extension (works on X11, no permission prompt)
    X11 = "x11"
    
    # Wayland portal/libei (requires logged-in session + user consent)
    WAYLAND_PORTAL = "wayland_portal"
    
    # Limited fallback (may not work at all on modern systems)
    LIMITED = "limited"
    
    # No input control available
    NONE = "none"
    
    @property
    def human_name(self) -> str:
        names = {
            "native": "Full control (native driver)",
            "x11": "Full control (X11)",
            "wayland_portal": "Limited control (Wayland — requires permission)",
            "limited": "Limited control (fallback)",
            "none": "No input control available",
        }
        return names[self.value]
    
    @property
    def is_full_control(self) -> bool:
        """True if this tier can inject input without user session limitations."""
        return self in (CapabilityTier.NATIVE, CapabilityTier.X11)
    
    @property
    def needs_permission(self) -> bool:
        """True if this tier requires user consent to work."""
        return self == CapabilityTier.WAYLAND_PORTAL


class InputBackend(ABC):
    """Abstract base class for input injection backends."""
    
    # Set by subclass
    capability_tier: CapabilityTier = CapabilityTier.NONE
    
    # Human-readable description of what's available
    capability_description: str = "No input control available"
    
    # The display server type this backend works with
    display_server: Optional[str] = None  # "x11", "wayland", "windows", "darwin"
    
    @abstractmethod
    def move_mouse(self, dx: int, dy: int) -> bool:
        """Move mouse by relative pixels. Returns True on success."""
        pass
    
    @abstractmethod
    def click_mouse(self, button: str = "left") -> bool:
        """Click mouse button. Returns True on success."""
        pass
    
    @abstractmethod
    def double_click(self) -> bool:
        """Double-click. Returns True on success."""
        pass
    
    @abstractmethod
    def type_text(self, text: str, interval: float = 0.01) -> bool:
        """Type text. Returns True on success."""
        pass
    
    @abstractmethod
    def press_keys(self, *keys: str) -> bool:
        """Press key combination. Returns True on success."""
        pass
    
    @abstractmethod
    def press_key(self, key: str) -> bool:
        """Press a single key. Returns True on success."""
        pass
    
    @abstractmethod
    def hotkey(self, *keys: str) -> bool:
        """Press hotkey combination. Returns True on success."""
        pass
    
    def get_capability(self) -> Tuple[CapabilityTier, str]:
        """Return (tier, description) for this backend."""
        return (self.capability_tier, self.capability_description)