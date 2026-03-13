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
from .communicate import Relay, Message, RelayConfig, on_relay

__all__ = [
    "CLIs",
    "CLIVersions",
    "CLI_REGISTRY",
    "DEFAULT_MODELS",
    "Models",
    "ModelOptions",
    "SwarmPatterns",
    "Relay",
    "Message",
    "RelayConfig",
    "on_relay",
]
