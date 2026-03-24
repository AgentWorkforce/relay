"""Types shared by the communicate-mode relay client."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Awaitable, Callable, TypeAlias

DEFAULT_RELAY_BASE_URL = "https://api.relaycast.dev"


@dataclass(frozen=True)
class Message:
    sender: str
    text: str
    channel: str | None = None
    thread_id: str | None = None
    timestamp: float | None = None
    message_id: str | None = None


MessageCallback: TypeAlias = Callable[[Message], None] | Callable[[Message], Awaitable[None]]


@dataclass
class RelayConfig:
    workspace: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    channels: list[str] = field(default_factory=lambda: ["general"])
    poll_interval_ms: int = 1000
    auto_cleanup: bool = True

    def __post_init__(self) -> None:
        if self.workspace is None:
            self.workspace = os.getenv("RELAY_WORKSPACE")
        if self.api_key is None:
            self.api_key = os.getenv("RELAY_API_KEY")
        if self.base_url is None:
            self.base_url = os.getenv("RELAY_BASE_URL")

    @classmethod
    def resolve(
        cls,
        workspace: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        channels: list[str] | None = None,
        poll_interval_ms: int = 1000,
        auto_cleanup: bool = True,
    ) -> "RelayConfig":
        resolved_workspace = workspace if workspace is not None else os.getenv("RELAY_WORKSPACE")
        resolved_api_key = api_key if api_key is not None else os.getenv("RELAY_API_KEY")
        resolved_base_url = base_url if base_url is not None else os.getenv("RELAY_BASE_URL") or DEFAULT_RELAY_BASE_URL
        return cls(
            workspace=resolved_workspace,
            api_key=resolved_api_key,
            base_url=resolved_base_url,
            channels=list(channels) if channels is not None else ["general"],
            poll_interval_ms=poll_interval_ms,
            auto_cleanup=auto_cleanup,
        )


class RelayConnectionError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        self.message = message
        super().__init__(f"{status_code}: {message}")


class RelayConfigError(Exception):
    pass


class RelayAuthError(RelayConnectionError):
    def __init__(self, message: str = "Unauthorized", status_code: int = 401) -> None:
        super().__init__(status_code=status_code, message=message)


__all__ = [
    "DEFAULT_RELAY_BASE_URL",
    "Message",
    "MessageCallback",
    "RelayAuthError",
    "RelayConfig",
    "RelayConfigError",
    "RelayConnectionError",
]
