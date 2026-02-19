"""Tests for the workflow builder."""

import yaml
import pytest
from agent_relay import workflow, VerificationCheck


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
