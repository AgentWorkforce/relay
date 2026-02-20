"""Fluent workflow builder for Agent Relay.

Example::

    from agent_relay import workflow

    result = (
        workflow("my-migration")
        .pattern("dag")
        .agent("backend", cli="claude", role="Backend engineer")
        .agent("tester", cli="claude", role="Test engineer")
        .step("build", agent="backend", task="Build the API endpoints")
        .step("test", agent="tester", task="Write integration tests", depends_on=["build"])
        .run()
    )
"""

from __future__ import annotations

import copy
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .types import (
    AgentCli,
    AgentOptions,
    Barrier,
    ConsensusStrategy,
    ErrorOptions,
    ErrorStrategy,
    IdleNudgeConfig,
    RunCancelledEvent,
    RunCompletedEvent,
    RunFailedEvent,
    RunOptions,
    RunStartedEvent,
    StateBackend,
    StepCompletedEvent,
    StepFailedEvent,
    StepForceReleasedEvent,
    StepNudgedEvent,
    StepOptions,
    StepResult,
    StepRetryingEvent,
    StepSkippedEvent,
    StepStartedEvent,
    SwarmPattern,
    TrajectoryConfig,
    VerificationCheck,
    WorkflowEvent,
    WorkflowEventCallback,
    WorkflowRunStatus,
    WorkflowResult,
)

_RUN_LINE_RE = re.compile(r"^\[run\]\s+(started|completed|failed|cancelled)(?::\s*(.*))?$")
_STEP_LINE_RE = re.compile(
    r"^\[step\]\s+(.+?)\s+"
    r"(started|completed|failed|skipped|retrying|nudged|force-released)"
    r"(?::\s*(.*))?$"
)
_VAR_RE = re.compile(r"{{\s*([^{}\s]+)\s*}}")
_INT_RE = re.compile(r"\d+")


class WorkflowBuilder:
    """Fluent builder that constructs Relay workflow config and runs it via agent-relay CLI."""

    def __init__(self, name: str) -> None:
        self._name = name
        self._description: str | None = None
        self._pattern: SwarmPattern = "dag"
        self._max_concurrency: int | None = None
        self._timeout_ms: int | None = None
        self._channel: str | None = None
        self._idle_nudge: dict[str, Any] | None = None
        self._agents: list[dict[str, Any]] = []
        self._steps: list[dict[str, Any]] = []
        self._error_handling: dict[str, Any] | None = None
        self._coordination: dict[str, Any] | None = None
        self._state: dict[str, Any] | None = None
        self._trajectories: dict[str, Any] | bool | None = None

    def description(self, desc: str) -> WorkflowBuilder:
        """Set workflow description."""
        self._description = desc
        return self

    def pattern(self, p: SwarmPattern) -> WorkflowBuilder:
        """Set swarm pattern (default: "dag")."""
        self._pattern = p
        return self

    def max_concurrency(self, n: int) -> WorkflowBuilder:
        """Set maximum concurrent agents."""
        self._max_concurrency = n
        return self

    def timeout(self, ms: int) -> WorkflowBuilder:
        """Set global timeout in milliseconds."""
        self._timeout_ms = ms
        return self

    def channel(self, ch: str) -> WorkflowBuilder:
        """Set the relay channel for agent communication."""
        self._channel = ch
        return self

    def idle_nudge(
        self,
        *,
        nudge_after_ms: int | None = None,
        escalate_after_ms: int | None = None,
        max_nudges: int | None = None,
    ) -> WorkflowBuilder:
        """Configure idle-agent nudging and escalation at the swarm level."""
        self._idle_nudge = IdleNudgeConfig(
            nudge_after_ms=nudge_after_ms,
            escalate_after_ms=escalate_after_ms,
            max_nudges=max_nudges,
        ).to_dict()
        return self

    def coordination(
        self,
        *,
        barriers: list[Barrier | dict[str, Any]] | None = None,
        voting_threshold: float | None = None,
        consensus_strategy: ConsensusStrategy | None = None,
    ) -> WorkflowBuilder:
        """Set workflow coordination settings (barriers/voting/consensus)."""
        config: dict[str, Any] = {}
        if barriers is not None:
            config["barriers"] = [
                barrier.to_dict() if isinstance(barrier, Barrier) else dict(barrier)
                for barrier in barriers
            ]
        if voting_threshold is not None:
            config["votingThreshold"] = voting_threshold
        if consensus_strategy is not None:
            config["consensusStrategy"] = consensus_strategy
        self._coordination = config
        return self

    def state(
        self,
        backend: StateBackend,
        *,
        ttl_ms: int | None = None,
        namespace: str | None = None,
    ) -> WorkflowBuilder:
        """Configure shared workflow state backend settings."""
        config: dict[str, Any] = {"backend": backend}
        if ttl_ms is not None:
            config["ttlMs"] = ttl_ms
        if namespace is not None:
            config["namespace"] = namespace
        self._state = config
        return self

    def trajectories(
        self,
        config: TrajectoryConfig | dict[str, Any] | bool = True,
        *,
        enabled: bool | None = None,
        reflect_on_barriers: bool | None = None,
        reflect_on_converge: bool | None = None,
        auto_decisions: bool | None = None,
    ) -> WorkflowBuilder:
        """Configure trajectory recording, or pass ``False`` to disable it."""
        self._trajectories = _serialize_trajectory_override(
            config,
            enabled=enabled,
            reflect_on_barriers=reflect_on_barriers,
            reflect_on_converge=reflect_on_converge,
            auto_decisions=auto_decisions,
        )
        return self

    def agent(
        self,
        name: str,
        *,
        cli: AgentCli = "claude",
        role: str | None = None,
        task: str | None = None,
        channels: list[str] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        timeout_ms: int | None = None,
        retries: int | None = None,
        idle_threshold_secs: int | None = None,
        interactive: bool | None = None,
    ) -> WorkflowBuilder:
        """Add an agent definition."""
        opts = AgentOptions(
            cli=cli,
            role=role,
            task=task,
            channels=channels,
            model=model,
            max_tokens=max_tokens,
            timeout_ms=timeout_ms,
            retries=retries,
            idle_threshold_secs=idle_threshold_secs,
            interactive=interactive,
        )
        agent_def: dict[str, Any] = {"name": name, "cli": opts.cli}

        if opts.role is not None:
            agent_def["role"] = opts.role
        if opts.task is not None:
            agent_def["task"] = opts.task
        if opts.channels is not None:
            agent_def["channels"] = opts.channels
        if opts.interactive is not None:
            agent_def["interactive"] = opts.interactive

        constraints: dict[str, Any] = {}
        if opts.model is not None:
            constraints["model"] = opts.model
        if opts.max_tokens is not None:
            constraints["maxTokens"] = opts.max_tokens
        if opts.timeout_ms is not None:
            constraints["timeoutMs"] = opts.timeout_ms
        if opts.retries is not None:
            constraints["retries"] = opts.retries
        if opts.idle_threshold_secs is not None:
            constraints["idleThresholdSecs"] = opts.idle_threshold_secs
        if constraints:
            agent_def["constraints"] = constraints

        self._agents.append(agent_def)
        return self

    def step(
        self,
        name: str,
        *,
        agent: str,
        task: str,
        depends_on: list[str] | None = None,
        verification: VerificationCheck | None = None,
        timeout_ms: int | None = None,
        retries: int | None = None,
    ) -> WorkflowBuilder:
        """Add a workflow step."""
        opts = StepOptions(
            agent=agent,
            task=task,
            depends_on=depends_on,
            verification=verification,
            timeout_ms=timeout_ms,
            retries=retries,
        )
        step_def: dict[str, Any] = {
            "name": name,
            "agent": opts.agent,
            "task": opts.task,
        }

        if opts.depends_on is not None:
            step_def["dependsOn"] = opts.depends_on
        if opts.verification is not None:
            step_def["verification"] = opts.verification.to_dict()
        if opts.timeout_ms is not None:
            step_def["timeoutMs"] = opts.timeout_ms
        if opts.retries is not None:
            step_def["retries"] = opts.retries

        self._steps.append(step_def)
        return self

    def on_error(
        self,
        strategy: ErrorStrategy,
        *,
        max_retries: int | None = None,
        retry_delay_ms: int | None = None,
        notify_channel: str | None = None,
    ) -> WorkflowBuilder:
        """Set global error handling strategy."""
        opts = ErrorOptions(
            max_retries=max_retries,
            retry_delay_ms=retry_delay_ms,
            notify_channel=notify_channel,
        )
        self._error_handling = {"strategy": strategy}
        if opts.max_retries is not None:
            self._error_handling["maxRetries"] = opts.max_retries
        if opts.retry_delay_ms is not None:
            self._error_handling["retryDelayMs"] = opts.retry_delay_ms
        if opts.notify_channel is not None:
            self._error_handling["notifyChannel"] = opts.notify_channel
        return self

    def to_config(self) -> dict[str, Any]:
        """Build and return the config as a dictionary (RelayYamlConfig shape)."""
        if not self._agents:
            raise ValueError("Workflow must have at least one agent")
        if not self._steps:
            raise ValueError("Workflow must have at least one step")

        swarm: dict[str, Any] = {"pattern": self._pattern}
        if self._max_concurrency is not None:
            swarm["maxConcurrency"] = self._max_concurrency
        if self._timeout_ms is not None:
            swarm["timeoutMs"] = self._timeout_ms
        if self._channel is not None:
            swarm["channel"] = self._channel
        if self._idle_nudge is not None:
            swarm["idleNudge"] = dict(self._idle_nudge)

        config: dict[str, Any] = {
            "version": "1.0",
            "name": self._name,
            "swarm": swarm,
            "agents": copy.deepcopy(self._agents),
            "workflows": [
                {
                    "name": f"{self._name}-workflow",
                    "steps": copy.deepcopy(self._steps),
                }
            ],
        }

        if self._description is not None:
            config["description"] = self._description
        if self._error_handling is not None:
            config["errorHandling"] = dict(self._error_handling)
        if self._coordination is not None:
            config["coordination"] = copy.deepcopy(self._coordination)
        if self._state is not None:
            config["state"] = dict(self._state)
        if self._trajectories is not None:
            config["trajectories"] = (
                False if self._trajectories is False else dict(self._trajectories)
            )

        return config

    def to_yaml(self) -> str:
        """Serialize the config to a YAML string."""
        return yaml.dump(self.to_config(), default_flow_style=False, sort_keys=False)

    def run(self, options: RunOptions | None = None) -> WorkflowResult:
        """Build the config and execute it via ``agent-relay run <tempfile>``."""
        opts = options or RunOptions()
        config = _apply_runtime_overrides(self.to_config(), opts)
        return _run_config(config, opts)


def workflow(name: str) -> WorkflowBuilder:
    """Create a new workflow builder."""
    return WorkflowBuilder(name)


def run_yaml(yaml_path: str, options: RunOptions | None = None) -> WorkflowResult:
    """Run an existing relay YAML workflow file."""
    opts = options or RunOptions()

    if opts.trajectories is None and not opts.vars:
        return _run_yaml_path(yaml_path, opts)

    parsed = yaml.safe_load(Path(yaml_path).read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"YAML config must decode to an object: {yaml_path}")
    config = _apply_runtime_overrides(parsed, opts)
    return _run_config(config, opts)


def _find_agent_relay() -> list[str] | None:
    """Find the agent-relay binary on PATH or via npx. Returns command prefix."""
    binary = shutil.which("agent-relay")
    if binary:
        return [binary]

    npx = shutil.which("npx")
    if npx:
        return [npx, "agent-relay"]

    return None


def _run_yaml_path(yaml_path: str, options: RunOptions) -> WorkflowResult:
    """Run an existing YAML path directly through the CLI."""
    cmd_prefix = _find_agent_relay()
    if cmd_prefix is None:
        raise RuntimeError(
            "agent-relay CLI not found. Install it with: npm install -g agent-relay"
        )

    cmd = [*cmd_prefix, "run", yaml_path]
    if options.workflow:
        cmd.extend(["--workflow", options.workflow])

    return _execute_cli(cmd, cwd=options.cwd, on_event=options.on_event)


def _run_config(config: dict[str, Any], options: RunOptions) -> WorkflowResult:
    """Write config to a temp YAML file and run it through the CLI."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", prefix="relay-workflow-", delete=False
    ) as file:
        yaml.dump(config, file, default_flow_style=False, sort_keys=False)
        yaml_path = file.name

    try:
        return _run_yaml_path(yaml_path, options)
    finally:
        Path(yaml_path).unlink(missing_ok=True)


def _execute_cli(
    cmd: list[str],
    *,
    cwd: str | None,
    on_event: WorkflowEventCallback | None,
) -> WorkflowResult:
    """Execute CLI command and parse emitted workflow events."""
    process = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    lines: list[str] = []
    events: list[WorkflowEvent] = []
    steps: dict[str, StepResult] = {}
    run_id = ""

    if process.stdout is not None:
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            lines.append(line)

            event = _parse_cli_event(line, run_id=run_id)
            if event is None:
                continue

            events.append(event)
            _sync_step_result(steps, event)

            if on_event is not None:
                on_event(event)

    return_code = process.wait()
    output = "\n".join(lines).strip()

    if not steps:
        for step in _parse_step_results(output):
            steps[step.name] = step

    status = _resolve_status(return_code, events)
    error = _resolve_error(output, events, return_code)

    return WorkflowResult(
        status=status,
        run_id=run_id,
        error=error,
        steps=list(steps.values()),
        events=events,
    )


def _parse_cli_event(line: str, *, run_id: str = "") -> WorkflowEvent | None:
    """Parse a CLI log line into a typed workflow event."""
    run_match = _RUN_LINE_RE.match(line)
    if run_match:
        status = run_match.group(1)
        detail = run_match.group(2)
        if status == "started":
            return RunStartedEvent(run_id=run_id)
        if status == "completed":
            return RunCompletedEvent(run_id=run_id)
        if status == "failed":
            return RunFailedEvent(run_id=run_id, error=detail or "Workflow failed")
        if status == "cancelled":
            return RunCancelledEvent(run_id=run_id)

    step_match = _STEP_LINE_RE.match(line)
    if step_match:
        step_name = step_match.group(1)
        status = step_match.group(2)
        detail = step_match.group(3)
        if status == "started":
            return StepStartedEvent(run_id=run_id, step_name=step_name)
        if status == "completed":
            return StepCompletedEvent(run_id=run_id, step_name=step_name)
        if status == "failed":
            return StepFailedEvent(
                run_id=run_id,
                step_name=step_name,
                error=detail or "Step failed",
            )
        if status == "skipped":
            return StepSkippedEvent(run_id=run_id, step_name=step_name)
        if status == "retrying":
            return StepRetryingEvent(
                run_id=run_id,
                step_name=step_name,
                attempt=_extract_int(detail),
            )
        if status == "nudged":
            return StepNudgedEvent(
                run_id=run_id,
                step_name=step_name,
                nudge_count=_extract_int(detail),
            )
        if status == "force-released":
            return StepForceReleasedEvent(run_id=run_id, step_name=step_name)

    return None


def _sync_step_result(steps: dict[str, StepResult], event: WorkflowEvent) -> None:
    """Update step result snapshots based on parsed events."""
    if isinstance(event, StepStartedEvent):
        steps[event.step_name] = StepResult(name=event.step_name, status="running")
        return

    if isinstance(event, StepCompletedEvent):
        step = steps.get(event.step_name)
        if step is None:
            steps[event.step_name] = StepResult(
                name=event.step_name,
                status="completed",
                output=event.output,
            )
            return
        step.status = "completed"
        step.output = event.output
        step.error = None
        return

    if isinstance(event, StepFailedEvent):
        step = steps.get(event.step_name)
        if step is None:
            steps[event.step_name] = StepResult(
                name=event.step_name,
                status="failed",
                error=event.error,
            )
            return
        step.status = "failed"
        step.error = event.error
        return

    if isinstance(event, StepSkippedEvent):
        steps[event.step_name] = StepResult(name=event.step_name, status="skipped")
        return

    if isinstance(event, StepRetryingEvent):
        step = steps.get(event.step_name)
        if step is None:
            steps[event.step_name] = StepResult(name=event.step_name, status="running")
            return
        step.status = "running"


def _parse_step_results(output: str) -> list[StepResult]:
    """Fallback parser for step lines if no events were captured live."""
    lines = output.split("\n") if output else []
    steps: list[StepResult] = []
    for line in lines:
        event = _parse_cli_event(line)
        if isinstance(event, StepCompletedEvent):
            steps.append(StepResult(name=event.step_name, status="completed"))
        elif isinstance(event, StepFailedEvent):
            steps.append(
                StepResult(name=event.step_name, status="failed", error=event.error)
            )
        elif isinstance(event, StepSkippedEvent):
            steps.append(StepResult(name=event.step_name, status="skipped"))
    return steps


def _resolve_status(return_code: int, events: list[WorkflowEvent]) -> WorkflowRunStatus:
    for event in events:
        if isinstance(event, RunCancelledEvent):
            return "cancelled"
    if return_code == 0:
        return "completed"
    return "failed"


def _resolve_error(output: str, events: list[WorkflowEvent], return_code: int) -> str | None:
    if return_code == 0:
        return None

    for event in reversed(events):
        if isinstance(event, RunFailedEvent) and event.error:
            return event.error

    for line in reversed(output.splitlines()):
        text = line.strip()
        if text:
            return text

    return "Workflow failed"


def _extract_int(text: str | None) -> int | None:
    if not text:
        return None
    match = _INT_RE.search(text)
    if match is None:
        return None
    return int(match.group(0))


def _apply_runtime_overrides(config: dict[str, Any], options: RunOptions) -> dict[str, Any]:
    next_config = copy.deepcopy(config)

    if options.vars:
        next_config = _apply_template_vars(next_config, options.vars)

    if options.trajectories is not None:
        next_config["trajectories"] = _serialize_trajectory_override(options.trajectories)

    return next_config


def _apply_template_vars(value: Any, vars_map: dict[str, str | int | bool]) -> Any:
    if isinstance(value, str):

        def replace(match: re.Match[str]) -> str:
            key = match.group(1)
            if key.startswith("steps."):
                return match.group(0)
            if key in vars_map:
                return str(vars_map[key])
            return match.group(0)

        return _VAR_RE.sub(replace, value)

    if isinstance(value, list):
        return [_apply_template_vars(item, vars_map) for item in value]

    if isinstance(value, dict):
        return {key: _apply_template_vars(item, vars_map) for key, item in value.items()}

    return value


def _serialize_trajectory_override(
    value: TrajectoryConfig | dict[str, Any] | bool,
    *,
    enabled: bool | None = None,
    reflect_on_barriers: bool | None = None,
    reflect_on_converge: bool | None = None,
    auto_decisions: bool | None = None,
) -> dict[str, Any] | bool:
    if value is False:
        if (
            enabled is not None
            or reflect_on_barriers is not None
            or reflect_on_converge is not None
            or auto_decisions is not None
        ):
            raise ValueError(
                "Trajectory fields cannot be set when trajectories are disabled (False)."
            )
        return False

    if isinstance(value, TrajectoryConfig):
        config = value.to_dict()
    elif isinstance(value, dict):
        config = dict(value)
    elif value is True:
        config = {}
    else:
        raise TypeError("trajectories must be TrajectoryConfig, dict, True, or False")

    if enabled is not None:
        config["enabled"] = enabled
    if reflect_on_barriers is not None:
        config["reflectOnBarriers"] = reflect_on_barriers
    if reflect_on_converge is not None:
        config["reflectOnConverge"] = reflect_on_converge
    if auto_decisions is not None:
        config["autoDecisions"] = auto_decisions

    return config
