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

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .types import (
    AgentCli,
    AgentOptions,
    ErrorOptions,
    RunOptions,
    StepOptions,
    StepResult,
    SwarmPattern,
    VerificationCheck,
    WorkflowResult,
)


class WorkflowBuilder:
    """Fluent builder that constructs a RelayYamlConfig and runs it via agent-relay CLI."""

    def __init__(self, name: str) -> None:
        self._name = name
        self._description: str | None = None
        self._pattern: SwarmPattern = "dag"
        self._max_concurrency: int | None = None
        self._timeout_ms: int | None = None
        self._channel: str | None = None
        self._agents: list[dict[str, Any]] = []
        self._steps: list[dict[str, Any]] = []
        self._error_handling: dict[str, Any] | None = None

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
        )
        agent_def: dict[str, Any] = {"name": name, "cli": opts.cli}

        if opts.role is not None:
            agent_def["role"] = opts.role
        if opts.task is not None:
            agent_def["task"] = opts.task
        if opts.channels is not None:
            agent_def["channels"] = opts.channels

        constraints: dict[str, Any] = {}
        if opts.model is not None:
            constraints["model"] = opts.model
        if opts.max_tokens is not None:
            constraints["maxTokens"] = opts.max_tokens
        if opts.timeout_ms is not None:
            constraints["timeoutMs"] = opts.timeout_ms
        if opts.retries is not None:
            constraints["retries"] = opts.retries
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
        strategy: str,
        *,
        max_retries: int | None = None,
        retry_delay_ms: int | None = None,
        notify_channel: str | None = None,
    ) -> WorkflowBuilder:
        """Set error handling strategy."""
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
        """Build and return the config as a dictionary (matches RelayYamlConfig shape)."""
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

        config: dict[str, Any] = {
            "version": "1.0",
            "name": self._name,
            "swarm": swarm,
            "agents": list(self._agents),
            "workflows": [
                {
                    "name": f"{self._name}-workflow",
                    "steps": list(self._steps),
                }
            ],
        }

        if self._description is not None:
            config["description"] = self._description
        if self._error_handling is not None:
            config["errorHandling"] = self._error_handling

        return config

    def to_yaml(self) -> str:
        """Serialize the config to a YAML string."""
        return yaml.dump(self.to_config(), default_flow_style=False, sort_keys=False)

    def run(self, options: RunOptions | None = None) -> WorkflowResult:
        """Build the config, write to a temp YAML file, and execute via agent-relay CLI.

        Requires ``agent-relay`` to be installed and available on PATH.
        """
        opts = options or RunOptions()

        binary = _find_agent_relay()
        if binary is None:
            raise RuntimeError(
                "agent-relay CLI not found. Install it with: npm install -g agent-relay"
            )

        config_yaml = self.to_yaml()

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", prefix="relay-workflow-", delete=False
        ) as f:
            f.write(config_yaml)
            yaml_path = f.name

        try:
            cmd = [binary, "run", yaml_path]
            if opts.workflow:
                cmd.extend(["--workflow", opts.workflow])

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=opts.cwd,
            )

            return _parse_cli_output(result)

        finally:
            Path(yaml_path).unlink(missing_ok=True)


def workflow(name: str) -> WorkflowBuilder:
    """Create a new workflow builder.

    Example::

        from agent_relay import workflow

        result = (
            workflow("feature-build")
            .pattern("dag")
            .agent("dev", cli="claude", role="Developer")
            .step("implement", agent="dev", task="Build the feature")
            .run()
        )
    """
    return WorkflowBuilder(name)


def run_yaml(yaml_path: str, options: RunOptions | None = None) -> WorkflowResult:
    """Run an existing relay.yaml workflow file.

    Example::

        from agent_relay import run_yaml

        result = run_yaml("workflows/daytona-migration.yaml")
    """
    opts = options or RunOptions()

    binary = _find_agent_relay()
    if binary is None:
        raise RuntimeError(
            "agent-relay CLI not found. Install it with: npm install -g agent-relay"
        )

    cmd = [binary, "run", yaml_path]
    if opts.workflow:
        cmd.extend(["--workflow", opts.workflow])

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=opts.cwd,
    )

    return _parse_cli_output(result)


# ── Internal helpers ─────────────────────────────────────────────────────────


def _find_agent_relay() -> str | None:
    """Find the agent-relay binary on PATH or via npx."""
    path = shutil.which("agent-relay")
    if path:
        return path

    # Check if npx is available as fallback
    npx = shutil.which("npx")
    if npx:
        return npx  # caller will prepend args

    return None


def _parse_cli_output(result: subprocess.CompletedProcess[str]) -> WorkflowResult:
    """Parse agent-relay CLI output into a WorkflowResult."""
    output = result.stdout.strip()
    lines = output.split("\n") if output else []

    steps: list[StepResult] = []
    for line in lines:
        if line.startswith("[step]"):
            parts = line.removeprefix("[step]").strip().split(" ", 1)
            if len(parts) >= 2:
                step_name = parts[0]
                rest = parts[1]
                if "completed" in rest:
                    steps.append(StepResult(name=step_name, status="completed"))
                elif "failed" in rest:
                    error = rest.split(":", 1)[1].strip() if ":" in rest else None
                    steps.append(StepResult(name=step_name, status="failed", error=error))
                elif "skipped" in rest:
                    steps.append(StepResult(name=step_name, status="skipped"))

    if result.returncode == 0:
        return WorkflowResult(
            status="completed",
            run_id="",  # CLI doesn't expose run ID yet
            steps=steps,
        )

    error = result.stderr.strip() or result.stdout.strip()
    return WorkflowResult(
        status="failed",
        run_id="",
        error=error,
        steps=steps,
    )
