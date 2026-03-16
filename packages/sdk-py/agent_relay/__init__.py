"""Agent Relay Python SDK."""

from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)

from .models import (
    CLIs,
    CLIVersions,
    CLI_REGISTRY,
    DEFAULT_MODELS,
    Models,
    ModelOptions,
    SwarmPatterns,
)
_has_communicate = False
try:
    from .communicate import Relay, Message, RelayConfig, on_relay
    _has_communicate = True
except ImportError:
    pass

__all__ = [
    "CLIs",
    "CLIVersions",
    "CLI_REGISTRY",
    "DEFAULT_MODELS",
    "Models",
    "ModelOptions",
    "SwarmPatterns",
    *(["Relay", "Message", "RelayConfig", "on_relay"] if _has_communicate else []),
]
