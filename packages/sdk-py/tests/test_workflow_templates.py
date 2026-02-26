"""Tests for workflow templates including review-loop pattern.

These tests verify that workflow configurations are properly structured
and can be serialized to valid YAML for the relay runtime.
"""

import yaml
import pytest
from agent_relay import (
    workflow,
    dag,
    fan_out,
    pipeline,
    PipelineStage,
    TemplateAgent,
    TemplateStep,
    VerificationCheck,
)


class TestReviewLoopPattern:
    """Tests for the review-loop workflow pattern."""

    def test_basic_review_loop_structure(self):
        """Test basic review-loop workflow with implementer and reviewers."""
        config = (
            workflow("review-loop-test")
            .description("Test review loop workflow")
            .pattern("review-loop")
            .agent("implementer", cli="claude", role="Senior developer implementing the task")
            .agent("reviewer-diff", cli="codex", role="Code quality reviewer", interactive=False)
            .agent("reviewer-arch", cli="claude", role="Architecture reviewer", interactive=False)
            .agent("reviewer-security", cli="codex", role="Security reviewer", interactive=False)
            .step("implement", agent="implementer", task="Implement the feature")
            .step("review-diff", agent="reviewer-diff", task="Review code quality", depends_on=["implement"])
            .step("review-arch", agent="reviewer-arch", task="Review architecture", depends_on=["implement"])
            .step("review-security", agent="reviewer-security", task="Security review", depends_on=["implement"])
            .step(
                "consolidate",
                agent="implementer",
                task="Consolidate review feedback",
                depends_on=["review-diff", "review-arch", "review-security"],
            )
            .step("address-feedback", agent="implementer", task="Address issues", depends_on=["consolidate"])
            .to_config()
        )

        assert config["swarm"]["pattern"] == "review-loop"
        assert len(config["agents"]) == 4
        assert len(config["workflows"][0]["steps"]) == 6

        # Check implementer is interactive, reviewers are not
        agents = {a["name"]: a for a in config["agents"]}
        assert agents["implementer"].get("interactive", True) is True
        assert agents["reviewer-diff"]["interactive"] is False
        assert agents["reviewer-arch"]["interactive"] is False
        assert agents["reviewer-security"]["interactive"] is False

    def test_review_loop_with_verification(self):
        """Test review-loop with verification checks."""
        config = (
            workflow("review-loop-verified")
            .pattern("review-loop")
            .agent("implementer", cli="claude")
            .agent("reviewer", cli="codex", interactive=False)
            .step(
                "implement",
                agent="implementer",
                task="Implement feature",
                verification=VerificationCheck(type="output_contains", value="IMPLEMENTATION COMPLETE"),
            )
            .step(
                "review",
                agent="reviewer",
                task="Review implementation",
                depends_on=["implement"],
                verification=VerificationCheck(type="output_contains", value="REVIEW:"),
            )
            .step(
                "address",
                agent="implementer",
                task="Address feedback",
                depends_on=["review"],
                verification=VerificationCheck(type="output_contains", value="ADDRESSED"),
            )
            .to_config()
        )

        steps = config["workflows"][0]["steps"]
        assert steps[0]["verification"]["value"] == "IMPLEMENTATION COMPLETE"
        assert steps[1]["verification"]["value"] == "REVIEW:"
        assert steps[2]["verification"]["value"] == "ADDRESSED"

    def test_review_loop_with_coordination(self):
        """Test review-loop with barriers for synchronization."""
        config = (
            workflow("review-loop-coordinated")
            .pattern("review-loop")
            .coordination(
                barriers=[{"name": "reviews-complete", "waitFor": ["review-1", "review-2"]}],
                consensus_strategy="majority",
            )
            .agent("implementer", cli="claude")
            .agent("reviewer-1", cli="codex", interactive=False)
            .agent("reviewer-2", cli="claude", interactive=False)
            .step("implement", agent="implementer", task="Do work")
            .step("review-1", agent="reviewer-1", task="Review 1", depends_on=["implement"])
            .step("review-2", agent="reviewer-2", task="Review 2", depends_on=["implement"])
            .step("consolidate", agent="implementer", task="Merge", depends_on=["review-1", "review-2"])
            .to_config()
        )

        assert config["coordination"]["consensusStrategy"] == "majority"
        assert len(config["coordination"]["barriers"]) == 1
        assert config["coordination"]["barriers"][0]["waitFor"] == ["review-1", "review-2"]

    def test_review_loop_yaml_roundtrip(self):
        """Test that review-loop config survives YAML roundtrip."""
        builder = (
            workflow("review-loop-yaml")
            .pattern("review-loop")
            .agent("impl", cli="claude")
            .agent("rev", cli="codex", interactive=False)
            .step("do", agent="impl", task="Do it")
            .step("check", agent="rev", task="Check it", depends_on=["do"])
        )

        yaml_str = builder.to_yaml()
        parsed = yaml.safe_load(yaml_str)

        assert parsed["swarm"]["pattern"] == "review-loop"
        assert len(parsed["agents"]) == 2
        assert parsed["agents"][1]["interactive"] is False


class TestHubSpokePattern:
    """Tests for hub-spoke workflow pattern."""

    def test_basic_hub_spoke(self):
        """Test basic hub-spoke with lead and workers."""
        config = (
            workflow("hub-spoke-test")
            .pattern("hub-spoke")
            .agent("lead", cli="claude", role="lead")
            .agent("worker-1", cli="codex")
            .agent("worker-2", cli="codex")
            .agent("worker-3", cli="codex")
            .step("plan", agent="lead", task="Create plan")
            .step("work-1", agent="worker-1", task="Task 1", depends_on=["plan"])
            .step("work-2", agent="worker-2", task="Task 2", depends_on=["plan"])
            .step("work-3", agent="worker-3", task="Task 3", depends_on=["plan"])
            .step("consolidate", agent="lead", task="Merge work", depends_on=["work-1", "work-2", "work-3"])
            .to_config()
        )

        assert config["swarm"]["pattern"] == "hub-spoke"
        assert len(config["agents"]) == 4
        assert config["agents"][0]["role"] == "lead"


class TestPipelinePattern:
    """Tests for pipeline workflow pattern."""

    def test_pipeline_with_stages(self):
        """Test pipeline with multiple stages."""
        config = pipeline(
            "pipeline-test",
            stages=[
                PipelineStage(name="stage-1", task="First stage"),
                PipelineStage(name="stage-2", task="Second stage"),
                PipelineStage(name="stage-3", task="Third stage"),
            ],
        ).to_config()

        assert config["swarm"]["pattern"] == "pipeline"
        steps = config["workflows"][0]["steps"]
        assert len(steps) == 3
        assert steps[1]["dependsOn"] == ["stage-1"]
        assert steps[2]["dependsOn"] == ["stage-2"]


class TestDAGPattern:
    """Tests for DAG workflow pattern."""

    def test_dag_with_dependencies(self):
        """Test DAG with complex dependencies."""
        config = dag(
            "dag-test",
            agents=[
                TemplateAgent(name="frontend", cli="claude"),
                TemplateAgent(name="backend", cli="codex"),
                TemplateAgent(name="tester", cli="claude"),
            ],
            steps=[
                TemplateStep(name="design", agent="frontend", task="Design UI"),
                TemplateStep(name="api", agent="backend", task="Build API"),
                TemplateStep(name="integrate", agent="frontend", task="Integrate", depends_on=["design", "api"]),
                TemplateStep(name="test", agent="tester", task="Test all", depends_on=["integrate"]),
            ],
        ).to_config()

        assert config["swarm"]["pattern"] == "dag"
        steps = config["workflows"][0]["steps"]
        assert steps[2]["dependsOn"] == ["design", "api"]
        assert steps[3]["dependsOn"] == ["integrate"]


class TestFanOutPattern:
    """Tests for fan-out workflow pattern."""

    def test_fan_out_with_synthesis(self):
        """Test fan-out with parallel tasks and synthesis."""
        config = fan_out(
            "fan-out-test",
            tasks=["Analyze module A", "Analyze module B", "Analyze module C"],
            synthesis_task="Combine all analyses into report",
        ).to_config()

        assert config["swarm"]["pattern"] == "fan-out"
        steps = config["workflows"][0]["steps"]
        assert len(steps) == 4  # 3 tasks + 1 synthesis
        # Synthesis depends on all tasks
        assert steps[3]["dependsOn"] == ["task-1", "task-2", "task-3"]


class TestMultiCLIWorkflows:
    """Tests for workflows with multiple CLI types."""

    def test_mixed_cli_workflow(self):
        """Test workflow with Claude, Codex, and other CLIs."""
        config = (
            workflow("multi-cli")
            .pattern("dag")
            .agent("planner", cli="claude", role="Planning and coordination")
            .agent("coder", cli="codex", role="Implementation")
            .agent("reviewer", cli="gemini", role="Code review")
            .agent("tester", cli="aider", role="Test writing")
            .step("plan", agent="planner", task="Create implementation plan")
            .step("code", agent="coder", task="Implement feature", depends_on=["plan"])
            .step("review", agent="reviewer", task="Review code", depends_on=["code"])
            .step("test", agent="tester", task="Write tests", depends_on=["code"])
            .step("finalize", agent="planner", task="Final review", depends_on=["review", "test"])
            .to_config()
        )

        clis = [a["cli"] for a in config["agents"]]
        assert "claude" in clis
        assert "codex" in clis
        assert "gemini" in clis
        assert "aider" in clis


class TestWorkflowValidation:
    """Tests for workflow validation."""

    def test_dependency_cycle_detection(self):
        """Test that circular dependencies are detected (runtime validation)."""
        # Note: Current builder doesn't validate cycles at build time,
        # but this documents expected behavior
        config = (
            workflow("cycle-test")
            .pattern("dag")
            .agent("a", cli="claude")
            .step("s1", agent="a", task="First", depends_on=["s2"])
            .step("s2", agent="a", task="Second", depends_on=["s1"])
            .to_config()
        )

        # Config builds but would fail at runtime
        # This test documents the current behavior
        steps = config["workflows"][0]["steps"]
        assert steps[0]["dependsOn"] == ["s2"]
        assert steps[1]["dependsOn"] == ["s1"]

    def test_unique_agent_names(self):
        """Test that duplicate agent names are handled."""
        # Builder allows duplicates (latest wins or both appear)
        # This documents expected behavior
        config = (
            workflow("dup-test")
            .pattern("dag")
            .agent("worker", cli="claude")
            .agent("worker", cli="codex")  # Same name, different CLI
            .step("s1", agent="worker", task="Do work")
            .to_config()
        )

        # Current behavior: both agents appear
        assert len(config["agents"]) == 2

    def test_step_references_existing_agent(self):
        """Test step references an agent that exists."""
        config = (
            workflow("ref-test")
            .pattern("dag")
            .agent("worker", cli="claude")
            .step("s1", agent="worker", task="Valid reference")
            .to_config()
        )

        # Step agent matches defined agent
        assert config["workflows"][0]["steps"][0]["agent"] == "worker"
        assert config["agents"][0]["name"] == "worker"


class TestWorkflowConfiguration:
    """Tests for advanced workflow configuration."""

    def test_error_handling_config(self):
        """Test error handling configuration."""
        config = (
            workflow("error-test")
            .pattern("dag")
            .on_error("retry", max_retries=3, retry_delay_ms=5000, notify_channel="errors")
            .agent("a", cli="claude")
            .step("s1", agent="a", task="May fail")
            .to_config()
        )

        assert config["errorHandling"]["strategy"] == "retry"
        assert config["errorHandling"]["maxRetries"] == 3
        assert config["errorHandling"]["retryDelayMs"] == 5000
        assert config["errorHandling"]["notifyChannel"] == "errors"

    def test_idle_nudge_config(self):
        """Test idle agent detection configuration."""
        config = (
            workflow("idle-test")
            .pattern("dag")
            .idle_nudge(nudge_after_ms=60000, escalate_after_ms=120000, max_nudges=2)
            .agent("a", cli="claude")
            .step("s1", agent="a", task="Long running task")
            .to_config()
        )

        nudge = config["swarm"]["idleNudge"]
        assert nudge["nudgeAfterMs"] == 60000
        assert nudge["escalateAfterMs"] == 120000
        assert nudge["maxNudges"] == 2

    def test_state_config(self):
        """Test state management configuration."""
        config = (
            workflow("state-test")
            .pattern("dag")
            .state("redis", ttl_ms=3600000, namespace="myapp")
            .agent("a", cli="claude")
            .step("s1", agent="a", task="Stateful task")
            .to_config()
        )

        assert config["state"]["backend"] == "redis"
        assert config["state"]["ttlMs"] == 3600000
        assert config["state"]["namespace"] == "myapp"

    def test_trajectory_config(self):
        """Test trajectory recording configuration."""
        config = (
            workflow("trajectory-test")
            .pattern("dag")
            .trajectories(enabled=True, reflect_on_barriers=True, auto_decisions=True)
            .agent("a", cli="claude")
            .step("s1", agent="a", task="Tracked task")
            .to_config()
        )

        traj = config["trajectories"]
        assert traj["enabled"] is True
        assert traj["reflectOnBarriers"] is True
        assert traj["autoDecisions"] is True

    def test_agent_constraints(self):
        """Test agent resource constraints."""
        config = (
            workflow("constraints-test")
            .pattern("dag")
            .agent(
                "constrained",
                cli="claude",
                model="claude-opus",
                max_tokens=8000,
                timeout_ms=300000,
                retries=2,
                idle_threshold_secs=30,
            )
            .step("s1", agent="constrained", task="Constrained task")
            .to_config()
        )

        constraints = config["agents"][0]["constraints"]
        assert constraints["model"] == "claude-opus"
        assert constraints["maxTokens"] == 8000
        assert constraints["timeoutMs"] == 300000
        assert constraints["retries"] == 2
        assert constraints["idleThresholdSecs"] == 30


class TestYAMLGeneration:
    """Tests for YAML output generation."""

    def test_yaml_output_is_valid(self):
        """Test that generated YAML is parseable."""
        builder = (
            workflow("yaml-valid")
            .pattern("dag")
            .agent("a", cli="claude")
            .step("s1", agent="a", task="Test task")
        )

        yaml_str = builder.to_yaml()

        # Should parse without error
        parsed = yaml.safe_load(yaml_str)
        assert parsed is not None
        assert isinstance(parsed, dict)

    def test_yaml_preserves_multiline_tasks(self):
        """Test that multiline tasks are preserved in YAML."""
        multiline_task = """Do the following:
1. First step
2. Second step
3. Third step"""

        builder = (
            workflow("multiline")
            .pattern("dag")
            .agent("a", cli="claude")
            .step("s1", agent="a", task=multiline_task)
        )

        yaml_str = builder.to_yaml()
        parsed = yaml.safe_load(yaml_str)

        assert "1. First step" in parsed["workflows"][0]["steps"][0]["task"]
        assert "3. Third step" in parsed["workflows"][0]["steps"][0]["task"]

    def test_yaml_special_characters(self):
        """Test that special characters are properly escaped."""
        config = (
            workflow("special-chars")
            .description("Test: 'quotes' and \"double quotes\"")
            .pattern("dag")
            .agent("a", cli="claude")
            .step("s1", agent="a", task="Use {{variable}} syntax")
            .to_config()
        )

        # Should handle special characters
        assert "quotes" in config["description"]
        assert "{{variable}}" in config["workflows"][0]["steps"][0]["task"]
