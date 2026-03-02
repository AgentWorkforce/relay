"""Wire protocol types for the Agent Relay broker communication.

Matches the TypeScript definitions in packages/sdk/src/protocol.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

PROTOCOL_VERSION = 1

AgentRuntime = Literal["pty", "headless_claude"]


@dataclass
class RestartPolicy:
    enabled: bool = False
    max_restarts: int = 3
    cooldown_ms: int = 1000
    max_consecutive_failures: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "max_restarts": self.max_restarts,
            "cooldown_ms": self.cooldown_ms,
            "max_consecutive_failures": self.max_consecutive_failures,
        }


@dataclass
class AgentSpec:
    """Specification for spawning an agent."""

    name: str
    runtime: AgentRuntime = "pty"
    cli: Optional[str] = None
    args: list[str] = field(default_factory=list)
    channels: list[str] = field(default_factory=list)
    model: Optional[str] = None
    cwd: Optional[str] = None
    team: Optional[str] = None
    shadow_of: Optional[str] = None
    shadow_mode: Optional[str] = None
    restart_policy: Optional[RestartPolicy] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "runtime": self.runtime,
        }
        if self.cli is not None:
            d["cli"] = self.cli
        if self.args:
            d["args"] = self.args
        if self.channels:
            d["channels"] = self.channels
        if self.model is not None:
            d["model"] = self.model
        if self.cwd is not None:
            d["cwd"] = self.cwd
        if self.team is not None:
            d["team"] = self.team
        if self.shadow_of is not None:
            d["shadow_of"] = self.shadow_of
        if self.shadow_mode is not None:
            d["shadow_mode"] = self.shadow_mode
        if self.restart_policy is not None:
            d["restart_policy"] = self.restart_policy.to_dict()
        return d


@dataclass
class ProtocolEnvelope:
    """JSON envelope for all broker communication."""

    v: int
    type: str
    payload: dict[str, Any]
    request_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "v": self.v,
            "type": self.type,
            "payload": self.payload,
        }
        if self.request_id is not None:
            d["request_id"] = self.request_id
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProtocolEnvelope:
        return cls(
            v=data.get("v", 0),
            type=data.get("type", ""),
            payload=data.get("payload", {}),
            request_id=data.get("request_id"),
        )


# BrokerEvent is a dict with a 'kind' field discriminator.
# Event kinds: agent_spawned, agent_released, agent_exit, agent_exited,
# relay_inbound, worker_stream, worker_ready, worker_error,
# delivery_queued, delivery_injected, delivery_verified, delivery_failed,
# delivery_active, delivery_ack, delivery_retry, delivery_dropped,
# relaycast_published, relaycast_publish_failed, acl_denied,
# agent_idle, agent_restarting, agent_restarted, agent_permanently_dead
BrokerEvent = dict[str, Any]
