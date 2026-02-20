"""Type definitions for Agent Relay workflows."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, TypeAlias

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
    "competitive",
]

AgentCli = Literal["claude", "codex", "gemini", "aider", "goose", "opencode", "droid"]
AgentStatus = Literal["healthy", "restarting", "dead", "released"]
CrashCategory = Literal["oom", "segfault", "error", "signal", "unknown"]
WorkflowOnError = Literal["fail", "skip", "retry"]
ConsensusStrategy = Literal["majority", "unanimous", "quorum"]
ErrorStrategy = Literal["fail-fast", "continue", "retry"]
StateBackend = Literal["memory", "redis", "database"]
WorkflowRunStatus = Literal["pending", "running", "completed", "failed", "cancelled"]
WorkflowStepStatus = Literal["pending", "running", "completed", "failed", "skipped"]


@dataclass
class TrajectoryConfig:
    enabled: bool | None = None
    reflect_on_barriers: bool | None = None
    reflect_on_converge: bool | None = None
    auto_decisions: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.enabled is not None:
            result["enabled"] = self.enabled
        if self.reflect_on_barriers is not None:
            result["reflectOnBarriers"] = self.reflect_on_barriers
        if self.reflect_on_converge is not None:
            result["reflectOnConverge"] = self.reflect_on_converge
        if self.auto_decisions is not None:
            result["autoDecisions"] = self.auto_decisions
        return result


@dataclass
class IdleNudgeConfig:
    nudge_after_ms: int | None = None
    escalate_after_ms: int | None = None
    max_nudges: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.nudge_after_ms is not None:
            result["nudgeAfterMs"] = self.nudge_after_ms
        if self.escalate_after_ms is not None:
            result["escalateAfterMs"] = self.escalate_after_ms
        if self.max_nudges is not None:
            result["maxNudges"] = self.max_nudges
        return result


@dataclass
class SwarmConfig:
    pattern: SwarmPattern
    max_concurrency: int | None = None
    timeout_ms: int | None = None
    channel: str | None = None
    idle_nudge: IdleNudgeConfig | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"pattern": self.pattern}
        if self.max_concurrency is not None:
            result["maxConcurrency"] = self.max_concurrency
        if self.timeout_ms is not None:
            result["timeoutMs"] = self.timeout_ms
        if self.channel is not None:
            result["channel"] = self.channel
        if self.idle_nudge is not None:
            result["idleNudge"] = self.idle_nudge.to_dict()
        return result


@dataclass
class AgentConstraints:
    max_tokens: int | None = None
    timeout_ms: int | None = None
    retries: int | None = None
    model: str | None = None
    idle_threshold_secs: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.max_tokens is not None:
            result["maxTokens"] = self.max_tokens
        if self.timeout_ms is not None:
            result["timeoutMs"] = self.timeout_ms
        if self.retries is not None:
            result["retries"] = self.retries
        if self.model is not None:
            result["model"] = self.model
        if self.idle_threshold_secs is not None:
            result["idleThresholdSecs"] = self.idle_threshold_secs
        return result


@dataclass
class AgentDefinition:
    name: str
    cli: AgentCli
    role: str | None = None
    task: str | None = None
    channels: list[str] | None = None
    constraints: AgentConstraints | None = None
    interactive: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "cli": self.cli,
        }
        if self.role is not None:
            result["role"] = self.role
        if self.task is not None:
            result["task"] = self.task
        if self.channels is not None:
            result["channels"] = self.channels
        if self.constraints is not None:
            constraints = self.constraints.to_dict()
            if constraints:
                result["constraints"] = constraints
        if self.interactive is not None:
            result["interactive"] = self.interactive
        return result


@dataclass
class VerificationCheck:
    type: Literal["output_contains", "exit_code", "file_exists", "custom"]
    value: str
    description: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"type": self.type, "value": self.value}
        if self.description is not None:
            result["description"] = self.description
        return result


@dataclass
class WorkflowStep:
    name: str
    agent: str
    task: str
    depends_on: list[str] | None = None
    verification: VerificationCheck | None = None
    timeout_ms: int | None = None
    retries: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "agent": self.agent,
            "task": self.task,
        }
        if self.depends_on is not None:
            result["dependsOn"] = self.depends_on
        if self.verification is not None:
            result["verification"] = self.verification.to_dict()
        if self.timeout_ms is not None:
            result["timeoutMs"] = self.timeout_ms
        if self.retries is not None:
            result["retries"] = self.retries
        return result


@dataclass
class WorkflowDefinition:
    name: str
    steps: list[WorkflowStep]
    description: str | None = None
    on_error: WorkflowOnError | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "steps": [step.to_dict() for step in self.steps],
        }
        if self.description is not None:
            result["description"] = self.description
        if self.on_error is not None:
            result["onError"] = self.on_error
        return result


@dataclass
class Barrier:
    name: str
    wait_for: list[str]
    timeout_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "waitFor": self.wait_for,
        }
        if self.timeout_ms is not None:
            result["timeoutMs"] = self.timeout_ms
        return result


@dataclass
class CoordinationConfig:
    barriers: list[Barrier] | None = None
    voting_threshold: float | None = None
    consensus_strategy: ConsensusStrategy | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.barriers is not None:
            result["barriers"] = [barrier.to_dict() for barrier in self.barriers]
        if self.voting_threshold is not None:
            result["votingThreshold"] = self.voting_threshold
        if self.consensus_strategy is not None:
            result["consensusStrategy"] = self.consensus_strategy
        return result


@dataclass
class StateConfig:
    backend: StateBackend
    ttl_ms: int | None = None
    namespace: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"backend": self.backend}
        if self.ttl_ms is not None:
            result["ttlMs"] = self.ttl_ms
        if self.namespace is not None:
            result["namespace"] = self.namespace
        return result


@dataclass
class ErrorHandlingConfig:
    strategy: ErrorStrategy
    max_retries: int | None = None
    retry_delay_ms: int | None = None
    notify_channel: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"strategy": self.strategy}
        if self.max_retries is not None:
            result["maxRetries"] = self.max_retries
        if self.retry_delay_ms is not None:
            result["retryDelayMs"] = self.retry_delay_ms
        if self.notify_channel is not None:
            result["notifyChannel"] = self.notify_channel
        return result


@dataclass
class RelayYamlConfig:
    name: str
    swarm: SwarmConfig
    agents: list[AgentDefinition]
    version: str = "1.0"
    description: str | None = None
    workflows: list[WorkflowDefinition] | None = None
    coordination: CoordinationConfig | None = None
    state: StateConfig | None = None
    error_handling: ErrorHandlingConfig | None = None
    trajectories: TrajectoryConfig | Literal[False] | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "version": self.version,
            "name": self.name,
            "swarm": self.swarm.to_dict(),
            "agents": [agent.to_dict() for agent in self.agents],
        }
        if self.description is not None:
            result["description"] = self.description
        if self.workflows is not None:
            result["workflows"] = [workflow.to_dict() for workflow in self.workflows]
        if self.coordination is not None:
            result["coordination"] = self.coordination.to_dict()
        if self.state is not None:
            result["state"] = self.state.to_dict()
        if self.error_handling is not None:
            result["errorHandling"] = self.error_handling.to_dict()
        if self.trajectories is False:
            result["trajectories"] = False
        elif isinstance(self.trajectories, TrajectoryConfig):
            result["trajectories"] = self.trajectories.to_dict()
        return result


@dataclass
class RestartPolicy:
    """Auto-restart policy for crashed agents."""

    enabled: bool = True
    max_restarts: int = 5
    cooldown_ms: int = 2000
    max_consecutive_failures: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "max_restarts": self.max_restarts,
            "cooldown_ms": self.cooldown_ms,
            "max_consecutive_failures": self.max_consecutive_failures,
        }


@dataclass
class AgentStats:
    """Per-agent statistics from the broker."""

    spawns: int = 0
    crashes: int = 0
    restarts: int = 0
    releases: int = 0
    status: AgentStatus = "healthy"
    current_uptime_secs: int = 0
    memory_bytes: int = 0


@dataclass
class BrokerStats:
    """Broker-wide statistics snapshot."""

    uptime_secs: int = 0
    total_agents_spawned: int = 0
    total_crashes: int = 0
    total_restarts: int = 0
    active_agents: int = 0


@dataclass
class CrashRecord:
    """A single crash record."""

    agent_name: str = ""
    exit_code: int | None = None
    signal: str | None = None
    timestamp: int = 0
    uptime_secs: int = 0
    category: CrashCategory = "unknown"
    description: str = ""


@dataclass
class CrashPattern:
    """A detected crash pattern grouping."""

    category: CrashCategory = "unknown"
    count: int = 0
    agents: list[str] = field(default_factory=list)


@dataclass
class CrashInsightsResponse:
    """Response from the crash insights API."""

    total_crashes: int = 0
    recent: list[CrashRecord] = field(default_factory=list)
    patterns: list[CrashPattern] = field(default_factory=list)
    health_score: int = 100


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
    idle_threshold_secs: int | None = None
    interactive: bool | None = None


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


@dataclass(frozen=True)
class RunStartedEvent:
    type: Literal["run:started"] = "run:started"
    run_id: str = ""


@dataclass(frozen=True)
class RunCompletedEvent:
    type: Literal["run:completed"] = "run:completed"
    run_id: str = ""


@dataclass(frozen=True)
class RunFailedEvent:
    type: Literal["run:failed"] = "run:failed"
    run_id: str = ""
    error: str = ""


@dataclass(frozen=True)
class RunCancelledEvent:
    type: Literal["run:cancelled"] = "run:cancelled"
    run_id: str = ""


@dataclass(frozen=True)
class StepStartedEvent:
    type: Literal["step:started"] = "step:started"
    run_id: str = ""
    step_name: str = ""


@dataclass(frozen=True)
class StepCompletedEvent:
    type: Literal["step:completed"] = "step:completed"
    run_id: str = ""
    step_name: str = ""
    output: str | None = None


@dataclass(frozen=True)
class StepFailedEvent:
    type: Literal["step:failed"] = "step:failed"
    run_id: str = ""
    step_name: str = ""
    error: str = ""


@dataclass(frozen=True)
class StepSkippedEvent:
    type: Literal["step:skipped"] = "step:skipped"
    run_id: str = ""
    step_name: str = ""


@dataclass(frozen=True)
class StepRetryingEvent:
    type: Literal["step:retrying"] = "step:retrying"
    run_id: str = ""
    step_name: str = ""
    attempt: int | None = None


@dataclass(frozen=True)
class StepNudgedEvent:
    type: Literal["step:nudged"] = "step:nudged"
    run_id: str = ""
    step_name: str = ""
    nudge_count: int | None = None


@dataclass(frozen=True)
class StepForceReleasedEvent:
    type: Literal["step:force-released"] = "step:force-released"
    run_id: str = ""
    step_name: str = ""


WorkflowEvent: TypeAlias = (
    RunStartedEvent
    | RunCompletedEvent
    | RunFailedEvent
    | RunCancelledEvent
    | StepStartedEvent
    | StepCompletedEvent
    | StepFailedEvent
    | StepSkippedEvent
    | StepRetryingEvent
    | StepNudgedEvent
    | StepForceReleasedEvent
)

WorkflowEventCallback: TypeAlias = Callable[[WorkflowEvent], None]


@dataclass
class RunOptions:
    """Options for running a workflow via the `agent-relay run` CLI command."""

    workflow: str | None = None
    cwd: str | None = None
    vars: dict[str, str | int | bool] | None = None
    trajectories: TrajectoryConfig | Literal[False] | dict[str, Any] | bool | None = None
    on_event: WorkflowEventCallback | None = None


@dataclass
class StepResult:
    """Result of a single workflow step."""

    name: str
    status: WorkflowStepStatus
    output: str | None = None
    error: str | None = None


@dataclass
class WorkflowResult:
    """Result of a workflow execution."""

    status: WorkflowRunStatus
    run_id: str
    error: str | None = None
    steps: list[StepResult] = field(default_factory=list)
    events: list[WorkflowEvent] = field(default_factory=list)


@dataclass
class WorkflowRunRow:
    id: str
    workspace_id: str
    workflow_name: str
    pattern: SwarmPattern
    status: WorkflowRunStatus
    config: RelayYamlConfig | dict[str, Any]
    state_snapshot: dict[str, Any] | None = None
    started_at: str = ""
    completed_at: str | None = None
    error: str | None = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class WorkflowStepRow:
    id: str
    run_id: str
    step_name: str
    agent_name: str
    status: WorkflowStepStatus
    task: str
    depends_on: list[str]
    retry_count: int
    output: str | None = None
    error: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    created_at: str = ""
    updated_at: str = ""
