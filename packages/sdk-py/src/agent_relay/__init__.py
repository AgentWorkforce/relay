"""Agent Relay Python SDK — direct spawn/message API and workflow builder."""

# ── Primary API: Direct spawn/message (matches TypeScript SDK) ────────────────

from .relay import AgentRelay, Agent, AgentSpawner, HumanHandle, Message, SpawnOptions
_has_communicate = False
try:
    from .communicate import Relay, RelayConfig, on_relay
    _has_communicate = True
except ImportError:
    # communicate extras not installed (pip install agent-relay-sdk[communicate])
    pass
from .models import Models
from .client import AgentRelayClient, AgentRelayProtocolError, AgentRelayProcessError
from .protocol import (
    AgentRuntime,
    BrokerEvent,
    MessageInjectionMode,
)

# ── Secondary API: Workflow builder (backward compatibility) ──────────────────

from .builder import workflow, WorkflowBuilder, run_yaml
from .templates import (
    PipelineStage,
    TemplateAgent,
    TemplateStep,
    WorkflowTemplates,
    dag,
    fan_out,
    pipeline,
)
from .types import (
    AgentOptions,
    AgentStats,
    Barrier,
    BrokerStats,
    CoordinationConfig,
    CrashInsightsResponse,
    CrashPattern,
    CrashRecord,
    StepOptions,
    ErrorOptions,
    RestartPolicy,
    RunStartedEvent,
    RunCompletedEvent,
    RunFailedEvent,
    RunCancelledEvent,
    StepStartedEvent,
    StepCompletedEvent,
    StepFailedEvent,
    StepSkippedEvent,
    StepRetryingEvent,
    StepNudgedEvent,
    StepForceReleasedEvent,
    WorkflowEvent,
    WorkflowEventCallback,
    RunOptions,
    TrajectoryConfig,
    WorkflowResult,
    WorkflowRunRow,
    WorkflowStepRow,
    SwarmPattern,
    AgentDefinition,
    AgentConstraints,
    PathDefinition,
    RelayYamlConfig,
    AgentCli,
    IdleNudgeConfig,
    StateConfig,
    ErrorHandlingConfig,
    VerificationCheck,
)

__all__ = [
    # Primary API
    "AgentRelay",
    "Agent",
    "AgentSpawner",
    "HumanHandle",
    "Message",
    "SpawnOptions",
    *(["Relay", "RelayConfig", "on_relay"] if _has_communicate else []),
    "Models",
    "AgentRelayClient",
    "AgentRelayProtocolError",
    "AgentRelayProcessError",
    "AgentRuntime",
    "BrokerEvent",
    "MessageInjectionMode",
    # Workflow builder (backward compat)
    "workflow",
    "WorkflowBuilder",
    "run_yaml",
    "fan_out",
    "pipeline",
    "dag",
    "WorkflowTemplates",
    "TemplateAgent",
    "TemplateStep",
    "PipelineStage",
    "AgentOptions",
    "AgentStats",
    "Barrier",
    "BrokerStats",
    "CoordinationConfig",
    "CrashInsightsResponse",
    "CrashPattern",
    "CrashRecord",
    "RestartPolicy",
    "StepOptions",
    "ErrorOptions",
    "RunStartedEvent",
    "RunCompletedEvent",
    "RunFailedEvent",
    "RunCancelledEvent",
    "StepStartedEvent",
    "StepCompletedEvent",
    "StepFailedEvent",
    "StepSkippedEvent",
    "StepRetryingEvent",
    "StepNudgedEvent",
    "StepForceReleasedEvent",
    "WorkflowEvent",
    "WorkflowEventCallback",
    "RunOptions",
    "TrajectoryConfig",
    "WorkflowResult",
    "WorkflowRunRow",
    "WorkflowStepRow",
    "SwarmPattern",
    "AgentDefinition",
    "AgentConstraints",
    "PathDefinition",
    "RelayYamlConfig",
    "AgentCli",
    "IdleNudgeConfig",
    "StateConfig",
    "ErrorHandlingConfig",
    "VerificationCheck",
]
