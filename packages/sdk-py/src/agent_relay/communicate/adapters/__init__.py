"""Framework-specific adapters for on_relay()."""

_has_pi = False
try:
    from .pi import on_relay as on_pi_relay
    _has_pi = True
except ImportError:
    pass

__all__ = [*(["on_pi_relay"] if _has_pi else [])]
