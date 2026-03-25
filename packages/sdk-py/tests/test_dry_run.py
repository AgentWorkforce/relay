"""Tests for dry-run support in the Python workflow builder."""

import os
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from agent_relay import workflow, fan_out, pipeline, PipelineStage, run_yaml
from agent_relay.types import RunOptions


class TestDryRunOption:
    """RunOptions.dry_run field."""

    def test_default_is_none(self):
        opts = RunOptions()
        assert opts.dry_run is None

    def test_explicit_true(self):
        opts = RunOptions(dry_run=True)
        assert opts.dry_run is True

    def test_explicit_false(self):
        opts = RunOptions(dry_run=False)
        assert opts.dry_run is False


class TestDryRunEnvVar:
    """DRY_RUN environment variable auto-detection."""

    def test_env_var_enables_dry_run(self, monkeypatch):
        monkeypatch.setenv("DRY_RUN", "true")
        builder = (
            workflow("test")
            .agent("w", cli="claude")
            .step("s", agent="w", task="t")
        )
        with patch("agent_relay.builder._run_config") as mock_run:
            mock_run.return_value = MagicMock(status="completed")
            builder.run()
            # The opts passed to _run_config should have dry_run=True
            call_opts = mock_run.call_args[0][1]
            assert call_opts.dry_run is True

    def test_env_var_not_set_leaves_none(self, monkeypatch):
        monkeypatch.delenv("DRY_RUN", raising=False)
        builder = (
            workflow("test")
            .agent("w", cli="claude")
            .step("s", agent="w", task="t")
        )
        with patch("agent_relay.builder._run_config") as mock_run:
            mock_run.return_value = MagicMock(status="completed")
            builder.run()
            call_opts = mock_run.call_args[0][1]
            assert call_opts.dry_run is None

    def test_explicit_false_overrides_env(self, monkeypatch):
        monkeypatch.setenv("DRY_RUN", "true")
        builder = (
            workflow("test")
            .agent("w", cli="claude")
            .step("s", agent="w", task="t")
        )
        with patch("agent_relay.builder._run_config") as mock_run:
            mock_run.return_value = MagicMock(status="completed")
            builder.run(RunOptions(dry_run=False))
            call_opts = mock_run.call_args[0][1]
            assert call_opts.dry_run is False


class TestDryRunCLIFlag:
    """--dry-run flag is passed to the agent-relay CLI."""

    def test_dry_run_adds_flag(self):
        """When dry_run=True, the CLI command should include --dry-run."""
        from agent_relay.builder import _find_agent_relay

        cmd_prefix = _find_agent_relay()
        if cmd_prefix is None:
            pytest.skip("agent-relay CLI not installed")

        builder = (
            workflow("test-flag")
            .agent("w", cli="claude")
            .step("s", agent="w", task="t")
        )

        with patch("agent_relay.builder._execute_cli") as mock_exec:
            mock_run_result = MagicMock(status="completed")
            mock_exec.return_value = mock_run_result

            builder.run(RunOptions(dry_run=True))

            cmd = mock_exec.call_args[0][0]
            assert "--dry-run" in cmd

    def test_no_dry_run_omits_flag(self):
        """When dry_run is not set, --dry-run should not be in the command."""
        from agent_relay.builder import _find_agent_relay

        cmd_prefix = _find_agent_relay()
        if cmd_prefix is None:
            pytest.skip("agent-relay CLI not installed")

        builder = (
            workflow("test-no-flag")
            .agent("w", cli="claude")
            .step("s", agent="w", task="t")
        )

        with patch("agent_relay.builder._execute_cli") as mock_exec:
            mock_run_result = MagicMock(status="completed")
            mock_exec.return_value = mock_run_result

            builder.run()

            cmd = mock_exec.call_args[0][0]
            assert "--dry-run" not in cmd


class TestDryRunMethod:
    """.dry_run() convenience method."""

    def test_dry_run_method_sets_flag(self):
        builder = (
            workflow("test-method")
            .agent("w", cli="claude")
            .step("s", agent="w", task="t")
        )

        with patch("agent_relay.builder._run_config") as mock_run:
            mock_run.return_value = MagicMock(status="completed")
            builder.dry_run()
            call_opts = mock_run.call_args[0][1]
            assert call_opts.dry_run is True


class TestDryRunE2E:
    """End-to-end dry-run through agent-relay CLI (requires CLI installed)."""

    def test_builder_dry_run_e2e(self):
        from agent_relay.builder import _find_agent_relay

        if _find_agent_relay() is None:
            pytest.skip("agent-relay CLI not installed")

        result = (
            workflow("e2e-dry")
            .agent("w", cli="claude")
            .step("s", agent="w", task="Do something")
            .dry_run()
        )

        assert result.status == "completed"

    def test_fan_out_dry_run_e2e(self):
        from agent_relay.builder import _find_agent_relay

        if _find_agent_relay() is None:
            pytest.skip("agent-relay CLI not installed")

        result = (
            fan_out("e2e-fan", tasks=["task A", "task B"], worker_cli="claude")
            .dry_run()
        )

        assert result.status == "completed"

    def test_pipeline_dry_run_e2e(self):
        from agent_relay.builder import _find_agent_relay

        if _find_agent_relay() is None:
            pytest.skip("agent-relay CLI not installed")

        result = pipeline(
            "e2e-pipe",
            stages=[
                PipelineStage(name="s1", task="First"),
                PipelineStage(name="s2", task="Second"),
            ],
        ).dry_run()

        assert result.status == "completed"


class TestRunYamlDryRun:
    """run_yaml() respects dry_run and DRY_RUN env var."""

    def test_run_yaml_env_var(self, monkeypatch, tmp_path):
        monkeypatch.setenv("DRY_RUN", "true")

        yaml_file = tmp_path / "test.yaml"
        yaml_file.write_text("""
version: "1.0"
name: yaml-dry-test
swarm:
  pattern: dag
agents:
  - name: w
    cli: claude
workflows:
  - name: wf
    steps:
      - name: s
        agent: w
        task: do something
""")

        with patch("agent_relay.builder._run_yaml_path") as mock_run:
            mock_run.return_value = MagicMock(status="completed")
            run_yaml(str(yaml_file))
            call_opts = mock_run.call_args[0][1]
            assert call_opts.dry_run is True
