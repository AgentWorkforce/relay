"""Framework-specific adapters for on_relay()."""

from .pi import on_relay as on_pi_relay

__all__ = ["on_pi_relay"]
