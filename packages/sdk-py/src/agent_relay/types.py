"""Type definitions for Agent Relay workflows."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

SwarmPattern = Literal[
    "fan-out",
    "pipeline",
    "hub-spoke",
    "consensus",
    "mesh",
    "handoff",
    "cascade",
    "dag",
    "debate",
    "hierarchical",
    # Additional patterns
    "map-reduce",
    "scatter-gather",
    "supervisor",
    "reflection",
    "red-team",
    "verifier",
    "auction",
    "escalation",
    "saga",
    "circuit-breaker",
    "blackboard",
    "swarm",
]

AgentCli = Literal["claude", "codex", "gemini", "aider", "goose"]


@dataclass
class VerificationCheck:
    type: Literal["output_contains", "exit_code", "file_exists", "custom"]
    value: str
    description: str | None = None

    def to_dict(self) -> dict:
        d: dict = {"type": self.type, "value": self.value}
        if self.description is not None:
            d["description"] = self.description
        return d


@dataclass
class AgentOptions:
    cli: AgentCli
    role: str | None = None
    task: str | None = None
    channels: list[str] | None = None
    model: str | None = None
    max_tokens: int | None = None
    timeout_ms: int | None = None
    retries: int | None = None


@dataclass
class StepOptions:
    agent: str
    task: str
    depends_on: list[str] | None = None
    verification: VerificationCheck | None = None
    timeout_ms: int | None = None
    retries: int | None = None


@dataclass
class ErrorOptions:
    max_retries: int | None = None
    retry_delay_ms: int | None = None
    notify_channel: str | None = None


@dataclass
class RunOptions:
    """Options for running a workflow."""

    workflow: str | None = None
    cwd: str | None = None
    vars: dict[str, str] | None = None


@dataclass
class WorkflowResult:
    """Result of a workflow execution."""

    status: str
    run_id: str
    error: str | None = None
    steps: list[StepResult] = field(default_factory=list)


@dataclass
class StepResult:
    """Result of a single workflow step."""

    name: str
    status: str
    output: str | None = None
    error: str | None = None
