"""Tests for deterministic and worktree step support in the Python workflow builder."""

import pytest
from agent_relay import workflow, VerificationCheck


def test_deterministic_step_emits_correct_config():
    config = (
        workflow("test")
        .agent("worker", cli="claude")
        .step("read-files", type="deterministic", command="cat src/index.ts",
              verification=VerificationCheck(type="exit_code", value="0"))
        .step("build", agent="worker", task="Build the project")
        .to_config()
    )

    steps = config["workflows"][0]["steps"]
    assert len(steps) == 2

    # Deterministic step
    assert steps[0]["name"] == "read-files"
    assert steps[0]["type"] == "deterministic"
    assert steps[0]["command"] == "cat src/index.ts"
    assert "agent" not in steps[0]
    assert "task" not in steps[0]
    assert steps[0]["verification"] == {"type": "exit_code", "value": "0"}

    # Agent step
    assert steps[1]["name"] == "build"
    assert steps[1]["agent"] == "worker"
    assert steps[1]["task"] == "Build the project"
    assert "type" not in steps[1]


def test_deterministic_step_with_all_options():
    config = (
        workflow("test")
        .agent("worker", cli="claude")
        .step("run-cmd", type="deterministic", command="npm test",
              capture_output=True, fail_on_error=False,
              depends_on=["build"], timeout_ms=30000)
        .step("final", agent="worker", task="Finalize")
        .to_config()
    )

    step = config["workflows"][0]["steps"][0]
    assert step["captureOutput"] is True
    assert step["failOnError"] is False
    assert step["dependsOn"] == ["build"]
    assert step["timeoutMs"] == 30000


def test_worktree_step_emits_correct_config():
    config = (
        workflow("test")
        .agent("worker", cli="claude")
        .step("setup-worktree", type="worktree", branch="feature/new",
              base_branch="main", path=".worktrees/feature-new", create_branch=True)
        .step("work", agent="worker", task="Do work", depends_on=["setup-worktree"])
        .to_config()
    )

    step = config["workflows"][0]["steps"][0]
    assert step["type"] == "worktree"
    assert step["branch"] == "feature/new"
    assert step["baseBranch"] == "main"
    assert step["path"] == ".worktrees/feature-new"
    assert step["createBranch"] is True
    assert "agent" not in step
    assert "command" not in step


def test_deterministic_only_workflow_no_agents_required():
    config = (
        workflow("infra")
        .step("lint", type="deterministic", command="npm run lint")
        .step("test", type="deterministic", command="npm test", depends_on=["lint"])
        .to_config()
    )

    assert config["agents"] == []
    assert len(config["workflows"][0]["steps"]) == 2


def test_deterministic_step_without_command_raises():
    with pytest.raises(ValueError, match="deterministic steps must have a command"):
        workflow("test").step("bad", type="deterministic")


def test_deterministic_step_with_agent_raises():
    with pytest.raises(ValueError, match="deterministic steps must not have agent or task"):
        workflow("test").step("bad", type="deterministic", command="ls", agent="x", task="y")


def test_agent_step_without_agent_task_raises():
    with pytest.raises(ValueError, match="Agent steps must have both agent and task"):
        workflow("test").step("bad")


def test_agent_steps_without_agent_definition_raises():
    with pytest.raises(ValueError, match="Workflow must have at least one agent when using agent steps"):
        workflow("test").step("work", agent="worker", task="Do work").to_config()


def test_worktree_step_without_branch_raises():
    with pytest.raises(ValueError, match="worktree steps must have a branch"):
        workflow("test").step("bad", type="worktree")


def test_to_yaml_includes_deterministic_steps():
    yaml_str = (
        workflow("test")
        .step("check", type="deterministic", command="echo hello")
        .to_yaml()
    )

    assert "type: deterministic" in yaml_str
    assert "command: echo hello" in yaml_str
