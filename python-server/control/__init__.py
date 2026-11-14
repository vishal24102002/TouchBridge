"""TouchBridge control module with capability-tier input backends."""

from .backends import (
    CapabilityTier,
    InputBackend,
    get_backend,
    detect_display_server,
    detect_wayland_compositor,
)

__all__ = [
    'CapabilityTier',
    'InputBackend',
    'get_backend',
    'detect_display_server',
    'detect_wayland_compositor',
]
