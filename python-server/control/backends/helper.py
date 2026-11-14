"""Linux input helper backend (native driver) with capability tier.

IMPORTANT: there are two distinct helper binaries, and they are NOT
interchangeable:

  * input_helper_x11      — compiled from input_helper.c, uses the XTest
                              extension directly. Zero permission prompts,
                              works even at the login screen. This is the
                              only thing that should ever report
                              CapabilityTier.NATIVE.

  * input_helper_wayland   — a shell wrapper around `ydotool`, which
                              injects input via /dev/uinput through
                              ydotoold. Requires ydotoold to be running and
                              the invoking user to have uinput access
                              (typically via the `input` group or udev
                              rule). This is a real capability, but it is
                              NOT the same guarantee as the native X11
                              path, so it must never report NATIVE.

Previously both cases resolved to a file literally named "input_helper",
so on an X11 session that happened to have the Wayland ydotool script
sitting next to it (e.g. from a bad build/deploy step), the backend would
silently run ydotool instead of the native XTest binary while still
claiming NATIVE/"native driver" capability to the client. This version
picks the helper by display server explicitly and ties the reported tier
to which one was actually found.
"""

import os
import sys
import subprocess
from typing import Optional, Tuple

from .base import CapabilityTier, InputBackend
from .utils import detect_display_server

# display_server -> ordered list of (path, kind) candidates.
# kind is "native_x11" or "ydotool".
_HELPER_CANDIDATES = {
    "x11": [
        ("./input_helper_x11", "native_x11"),
        ("../input_helper_x11", "native_x11"),
        ("/usr/local/bin/touchbridge_helper_x11", "native_x11"),
        ("/usr/bin/touchbridge_helper_x11", "native_x11"),
    ],
    "wayland": [
        ("./input_helper_wayland", "ydotool"),
        ("../input_helper_wayland", "ydotool"),
        ("/usr/local/bin/touchbridge_helper_wayland", "ydotool"),
        ("/usr/bin/touchbridge_helper_wayland", "ydotool"),
    ],
}

_TIER_BY_KIND = {
    "native_x11": (
        CapabilityTier.NATIVE,
        "Full X11 input control (native XTest driver)",
    ),
    "ydotool": (
        CapabilityTier.WAYLAND_PORTAL,
        "Wayland input control (ydotool via uinput — requires ydotoold "
        "running and uinput access)",
    ),
}


class LinuxInputHelperBackend(InputBackend):
    """Backend using a native helper binary, chosen per display server."""

    display_server: Optional[str] = None
    helper_path: Optional[str] = None
    helper_kind: Optional[str] = None  # "native_x11" | "ydotool"

    def __init__(self):
        self.display_server = detect_display_server()

        self.helper_path, self.helper_kind = self._find_helper(self.display_server)
        if not self.helper_path:
            raise RuntimeError(
                f"No input helper available for display server "
                f"'{self.display_server}'"
            )

        if not self._test_helper():
            raise RuntimeError(
                f"Input helper test failed ({self.helper_path}, "
                f"kind={self.helper_kind})"
            )

        tier, description = _TIER_BY_KIND.get(
            self.helper_kind,
            (CapabilityTier.LIMITED, "Linux input control (fallback mode)"),
        )
        self.capability_tier = tier
        self.capability_description = description

    def _find_helper(self, display_server: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        """Locate the input helper binary appropriate for display_server.

        Only ever looks at candidates registered for the detected display
        server — an X11 session will never pick up a Wayland/ydotool
        helper and vice versa, even if both happen to be present on disk.
        """
        candidates = list(_HELPER_CANDIDATES.get(display_server, []))

        # Packaged environment (PyInstaller etc.)
        if hasattr(sys, "_MEIPASS"):
            if display_server == "x11":
                candidates.append(
                    (os.path.join(sys._MEIPASS, "input_helper_x11"), "native_x11")
                )
            elif display_server == "wayland":
                candidates.append(
                    (os.path.join(sys._MEIPASS, "input_helper_wayland"), "ydotool")
                )

        for path, kind in candidates:
            if os.path.exists(path) and os.access(path, os.X_OK):
                return path, kind
        return None, None

    def _test_helper(self) -> bool:
        """Test if the helper binary works."""
        if not self.helper_path:
            return False
        try:
            result = subprocess.run(
                [self.helper_path, "--test"],
                capture_output=True,
                timeout=2,
            )
            return result.returncode == 0
        except Exception:
            return False

    def _run_helper(self, *args) -> bool:
        """Run helper with args, return True on success."""
        if not self.helper_path:
            return False

        try:
            result = subprocess.run(
                [self.helper_path] + list(args),
                capture_output=True,
                timeout=2,
            )
            return result.returncode == 0
        except Exception:
            return False

    def move_mouse(self, dx: int, dy: int) -> bool:
        return self._run_helper("move", str(dx), str(dy))

    def click_mouse(self, button: str = "left") -> bool:
        btn = "1" if button == "left" else "3"
        return self._run_helper("click", btn)

    def double_click(self) -> bool:
        return self._run_helper("doubleclick")

    def type_text(self, text: str, interval: float = 0.01) -> bool:
        # Neither helper implements bulk text typing; use pyautogui as
        # fallback (works on X11 via XTest; on Wayland this will typically
        # fail silently unless pyautogui has its own Wayland support).
        try:
            import pyautogui
            pyautogui.write(text, interval=interval)
            return True
        except Exception:
            return False

    def press_keys(self, *keys: str) -> bool:
        return self._run_helper("keys", *keys)

    def press_key(self, key: str) -> bool:
        return self._run_helper("key", key)

    def hotkey(self, *keys: str) -> bool:
        return self._run_helper("hotkey", *keys)
