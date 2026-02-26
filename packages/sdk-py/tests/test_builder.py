"""Tests for the workflow builder."""

import yaml
import pytest
from agent_relay import (
    PipelineStage,
    TemplateAgent,
    TemplateStep,
    VerificationCheck,
    dag,
    fan_out,
    pipeline,
    workflow,
)
from agent_relay.builder import _parse_cli_event
from agent_relay.types import (
    RunCompletedEvent,
    RunFailedEvent,
    StepCompletedEvent,
    StepFailedEvent,
)


def test_basic_builder():
    config = (
        workflow("test-workflow")
        .pattern("dag")
        .agent("worker", cli="claude", role="Test worker")
        .step("do-work", agent="worker", task="Do the work")
        .to_config()
    )

    assert config["version"] == "1.0"
    assert config["name"] == "test-workflow"
    assert config["swarm"]["pattern"] == "dag"
    assert len(config["agents"]) == 1
    assert config["agents"][0]["name"] == "worker"
    assert config["agents"][0]["cli"] == "claude"
    assert config["agents"][0]["role"] == "Test worker"
    assert len(config["workflows"]) == 1
    assert config["workflows"][0]["name"] == "test-workflow-workflow"
    assert len(config["workflows"][0]["steps"]) == 1


def test_full_builder():
    config = (
        workflow("migration")
        .description("Full migration workflow")
        .pattern("dag")
        .max_concurrency(3)
        .timeout(5_400_000)
        .channel("migration-channel")
        .agent("backend", cli="claude", role="Backend engineer")
        .agent("tester", cli="codex", role="Test engineer", model="gpt-4")
        .step(
            "build",
            agent="backend",
            task="Build the API",
            verification=VerificationCheck(type="output_contains", value="BUILD_DONE"),
            retries=2,
        )
        .step(
            "test",
            agent="tester",
            task="Run tests",
            depends_on=["build"],
            timeout_ms=600_000,
        )
        .on_error("retry", max_retries=2, retry_delay_ms=5000)
        .to_config()
    )

    assert config["description"] == "Full migration workflow"
    assert config["swarm"]["maxConcurrency"] == 3
    assert config["swarm"]["timeoutMs"] == 5_400_000
    assert config["swarm"]["channel"] == "migration-channel"

    assert len(config["agents"]) == 2
    assert config["agents"][1]["cli"] == "codex"
    assert config["agents"][1]["constraints"]["model"] == "gpt-4"

    steps = config["workflows"][0]["steps"]
    assert steps[0]["verification"] == {"type": "output_contains", "value": "BUILD_DONE"}
    assert steps[0]["retries"] == 2
    assert steps[1]["dependsOn"] == ["build"]
    assert steps[1]["timeoutMs"] == 600_000

    assert config["errorHandling"]["strategy"] == "retry"
    assert config["errorHandling"]["maxRetries"] == 2


def test_to_yaml_roundtrip():
    builder = (
        workflow("roundtrip")
        .pattern("fan-out")
        .agent("a", cli="claude")
        .step("s1", agent="a", task="Do something")
    )

    yaml_str = builder.to_yaml()
    parsed = yaml.safe_load(yaml_str)

    assert parsed["version"] == "1.0"
    assert parsed["name"] == "roundtrip"
    assert parsed["swarm"]["pattern"] == "fan-out"
    assert parsed["agents"][0]["name"] == "a"
    assert parsed["workflows"][0]["steps"][0]["task"] == "Do something"


def test_empty_agents_raises():
    with pytest.raises(ValueError, match="at least one agent"):
        workflow("empty").pattern("dag").step("s", agent="a", task="x").to_config()


def test_empty_steps_raises():
    with pytest.raises(ValueError, match="at least one step"):
        workflow("empty").pattern("dag").agent("a", cli="claude").to_config()


def test_builder_extended_schema_options():
    config = (
        workflow("extended")
        .pattern("dag")
        .idle_nudge(nudge_after_ms=1000, escalate_after_ms=2000, max_nudges=2)
        .coordination(
            barriers=[{"name": "gate", "waitFor": ["build"]}],
            voting_threshold=0.6,
            consensus_strategy="majority",
        )
        .state("memory", ttl_ms=5000, namespace="test-ns")
        .trajectories(enabled=True, auto_decisions=True)
        .agent("worker", cli="codex", interactive=False, idle_threshold_secs=25)
        .step("build", agent="worker", task="Build")
        .to_config()
    )

    assert config["swarm"]["idleNudge"]["nudgeAfterMs"] == 1000
    assert config["swarm"]["idleNudge"]["escalateAfterMs"] == 2000
    assert config["swarm"]["idleNudge"]["maxNudges"] == 2
    assert config["coordination"]["consensusStrategy"] == "majority"
    assert config["state"]["backend"] == "memory"
    assert config["state"]["namespace"] == "test-ns"
    assert config["trajectories"]["enabled"] is True
    assert config["trajectories"]["autoDecisions"] is True
    assert config["agents"][0]["interactive"] is False
    assert config["agents"][0]["constraints"]["idleThresholdSecs"] == 25


def test_templates_fan_out_pipeline_and_dag():
    fan_out_config = fan_out(
        "fanout",
        tasks=["Task A", "Task B"],
        synthesis_task="Merge outputs",
    ).to_config()
    assert fan_out_config["swarm"]["pattern"] == "fan-out"
    assert len(fan_out_config["workflows"][0]["steps"]) == 3
    assert fan_out_config["workflows"][0]["steps"][-1]["dependsOn"] == ["task-1", "task-2"]

    pipeline_config = pipeline(
        "pipe",
        stages=[
            PipelineStage(name="stage-1", task="First"),
            PipelineStage(name="stage-2", task="Second"),
        ],
    ).to_config()
    assert pipeline_config["swarm"]["pattern"] == "pipeline"
    assert pipeline_config["workflows"][0]["steps"][1]["dependsOn"] == ["stage-1"]

    dag_config = dag(
        "dag-template",
        agents=[TemplateAgent(name="worker", cli="claude")],
        steps=[
            TemplateStep(name="s1", agent="worker", task="One"),
            TemplateStep(name="s2", agent="worker", task="Two", depends_on=["s1"]),
        ],
    ).to_config()
    assert dag_config["swarm"]["pattern"] == "dag"
    assert dag_config["workflows"][0]["steps"][1]["dependsOn"] == ["s1"]


def test_parse_cli_event_types():
    event = _parse_cli_event("[run] completed")
    assert isinstance(event, RunCompletedEvent)

    event = _parse_cli_event("[run] failed: bad things")
    assert isinstance(event, RunFailedEvent)
    assert event.error == "bad things"

    event = _parse_cli_event("[step] build completed")
    assert isinstance(event, StepCompletedEvent)
    assert event.step_name == "build"

    event = _parse_cli_event("[step] test failed: timeout")
    assert isinstance(event, StepFailedEvent)
    assert event.error == "timeout"


def test_fan_out_empty_tasks_raises():
    with pytest.raises(ValueError, match="at least one task"):
        fan_out("empty", tasks=[])


def test_pipeline_empty_stages_raises():
    with pytest.raises(ValueError, match="at least one stage"):
        pipeline("empty", stages=[])


def test_dag_empty_agents_raises():
    with pytest.raises(ValueError, match="at least one agent"):
        dag("empty", agents=[], steps=[TemplateStep(name="s", agent="a", task="t")])


def test_dag_empty_steps_raises():
    with pytest.raises(ValueError, match="at least one step"):
        dag("empty", agents=[TemplateAgent(name="a")], steps=[])
