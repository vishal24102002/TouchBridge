"""Utility functions for display server detection."""

import os
import platform
import subprocess
from typing import Optional


def detect_display_server() -> Optional[str]:
    """Detect whether we're running on X11, Wayland, or unknown."""
    system = platform.system().lower()
    
    if system == "windows":
        return "windows"
    elif system == "darwin":
        return "darwin"
    elif system == "linux":
        # Check $XDG_SESSION_TYPE first (most reliable)
        session_type = os.environ.get("XDG_SESSION_TYPE", "").lower()
        if session_type in ("x11", "wayland"):
            return session_type
        
        # Check $WAYLAND_DISPLAY (set if Wayland is running)
        if os.environ.get("WAYLAND_DISPLAY"):
            return "wayland"
        
        # Check $DISPLAY (set if X11 is running)
        if os.environ.get("DISPLAY"):
            return "x11"
        
        # Fallback: try logind
        try:
            result = subprocess.run(
                ["loginctl", "show-session", "-p", "Type"],
                capture_output=True,
                text=True,
                timeout=1,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if line.startswith("Type="):
                        stype = line.split("=", 1)[1].strip().lower()
                        if stype in ("x11", "wayland"):
                            return stype
        except Exception:
            pass
    
    return None


def detect_wayland_compositor() -> Optional[str]:
    """Return the Wayland compositor name, or None if not Wayland."""
    if os.environ.get("XDG_SESSION_TYPE", "").lower() != "wayland":
        return None
    
    # Check common environment variables
    if os.environ.get("SWAYSOCK"):
        return "sway"
    if os.environ.get("HYPRLAND_INSTANCE_SIGNATURE"):
        return "hyprland"
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "")
    if "GNOME" in desktop:
        return "gnome"
    if "KDE" in desktop:
        return "kde"
    
    return "unknown"
