"""Built-in workflow template helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from .builder import WorkflowBuilder, workflow
from .types import AgentCli, VerificationCheck


@dataclass
class TemplateAgent:
    name: str
    cli: AgentCli = "claude"
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
class TemplateStep:
    name: str
    agent: str
    task: str
    depends_on: list[str] | None = None
    verification: VerificationCheck | None = None
    timeout_ms: int | None = None
    retries: int | None = None


@dataclass
class PipelineStage:
    name: str
    task: str
    agent: str | None = None
    cli: AgentCli | None = None
    role: str | None = None
    interactive: bool | None = None
    depends_on: list[str] | None = None
    verification: VerificationCheck | None = None
    timeout_ms: int | None = None
    retries: int | None = None


def fan_out(
    name: str,
    tasks: Sequence[str],
    *,
    worker_cli: AgentCli = "claude",
    worker_role: str = "Parallel worker",
    worker_interactive: bool = False,
    synthesis_task: str | None = None,
    synthesis_agent: str = "lead",
    synthesis_cli: AgentCli = "claude",
    synthesis_role: str = "Coordinator",
) -> WorkflowBuilder:
    """Create a fan-out workflow template with one worker per task."""
    if not tasks:
        raise ValueError("fan_out template requires at least one task")

    builder = workflow(name).pattern("fan-out")
    worker_steps: list[str] = []

    for index, task in enumerate(tasks, start=1):
        agent_name = f"worker-{index}"
        step_name = f"task-{index}"
        builder.agent(
            agent_name,
            cli=worker_cli,
            role=worker_role,
            interactive=worker_interactive,
        )
        builder.step(step_name, agent=agent_name, task=task)
        worker_steps.append(step_name)

    if synthesis_task is not None:
        builder.agent(synthesis_agent, cli=synthesis_cli, role=synthesis_role)
        builder.step(
            "synthesize",
            agent=synthesis_agent,
            task=synthesis_task,
            depends_on=worker_steps,
        )

    return builder


def pipeline(
    name: str,
    stages: Sequence[PipelineStage],
    *,
    default_cli: AgentCli = "claude",
) -> WorkflowBuilder:
    """Create a sequential pipeline workflow template."""
    if not stages:
        raise ValueError("pipeline template requires at least one stage")

    builder = workflow(name).pattern("pipeline")
    defined_agents: set[str] = set()
    previous_step: str | None = None

    for index, stage in enumerate(stages, start=1):
        agent_name = stage.agent or _slug(f"{stage.name}-agent", f"stage-agent-{index}")
        if agent_name not in defined_agents:
            builder.agent(
                agent_name,
                cli=stage.cli or default_cli,
                role=stage.role,
                interactive=stage.interactive,
            )
            defined_agents.add(agent_name)

        dependencies: list[str] = []
        if previous_step is not None:
            dependencies.append(previous_step)
        if stage.depends_on:
            dependencies.extend(stage.depends_on)

        builder.step(
            stage.name,
            agent=agent_name,
            task=stage.task,
            depends_on=dependencies or None,
            verification=stage.verification,
            timeout_ms=stage.timeout_ms,
            retries=stage.retries,
        )
        previous_step = stage.name

    return builder


def dag(
    name: str,
    *,
    agents: Sequence[TemplateAgent],
    steps: Sequence[TemplateStep],
    description: str | None = None,
) -> WorkflowBuilder:
    """Create a DAG template from explicit agent and step definitions."""
    if not agents:
        raise ValueError("dag template requires at least one agent")
    if not steps:
        raise ValueError("dag template requires at least one step")

    builder = workflow(name).pattern("dag")
    if description is not None:
        builder.description(description)

    for agent in agents:
        builder.agent(
            agent.name,
            cli=agent.cli,
            role=agent.role,
            task=agent.task,
            channels=agent.channels,
            model=agent.model,
            max_tokens=agent.max_tokens,
            timeout_ms=agent.timeout_ms,
            retries=agent.retries,
            idle_threshold_secs=agent.idle_threshold_secs,
            interactive=agent.interactive,
        )

    for step in steps:
        builder.step(
            step.name,
            agent=step.agent,
            task=step.task,
            depends_on=step.depends_on,
            verification=step.verification,
            timeout_ms=step.timeout_ms,
            retries=step.retries,
        )

    return builder


class WorkflowTemplates:
    """Namespace-style access for built-in template constructors."""

    fan_out = staticmethod(fan_out)
    pipeline = staticmethod(pipeline)
    dag = staticmethod(dag)


def _slug(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-").lower()
    return normalized or fallback
