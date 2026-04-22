"""Tests for _resolve_default_binary_path."""

import stat
from pathlib import Path

import pytest

import agent_relay.client as client_module
from agent_relay.client import (
    AgentRelayProcessError,
    _resolve_default_binary_path,
)


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip override env vars and PATH so tests start from a known state."""
    monkeypatch.delenv("BROKER_BINARY_PATH", raising=False)
    monkeypatch.delenv("AGENT_RELAY_BIN", raising=False)
    monkeypatch.setenv("PATH", "/nonexistent")


@pytest.fixture
def fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "agent-relay-broker"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
    return binary


@pytest.fixture
def no_embedded_binary(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Make the embedded-path lookup miss by relocating the module dir."""
    fake_module_file = tmp_path / "client.py"
    fake_module_file.write_text("")
    monkeypatch.setattr(client_module, "__file__", str(fake_module_file))


class TestResolveDefaultBinaryPath:
    def test_env_override_wins(
        self, clean_env, fake_binary, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("BROKER_BINARY_PATH", str(fake_binary))
        assert _resolve_default_binary_path() == str(fake_binary)

    def test_agent_relay_bin_alias(
        self, clean_env, fake_binary, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_RELAY_BIN", str(fake_binary))
        assert _resolve_default_binary_path() == str(fake_binary)

    def test_env_override_missing_path_raises(
        self, clean_env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("BROKER_BINARY_PATH", "/does/not/exist")
        with pytest.raises(AgentRelayProcessError, match="BROKER_BINARY_PATH"):
            _resolve_default_binary_path()

    def test_embedded_binary_found(
        self, clean_env, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        embedded = bin_dir / "agent-relay-broker"
        embedded.write_text("")
        embedded.chmod(embedded.stat().st_mode | stat.S_IXUSR)

        # Pretend the client module lives next to bin/
        fake_module_file = tmp_path / "client.py"
        fake_module_file.write_text("")
        monkeypatch.setattr(client_module, "__file__", str(fake_module_file))

        assert _resolve_default_binary_path() == str(embedded)

    def test_path_lookup_fallback(
        self,
        clean_env,
        fake_binary,
        no_embedded_binary,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Put the binary's directory on PATH so shutil.which finds it
        monkeypatch.setenv("PATH", str(fake_binary.parent))
        assert _resolve_default_binary_path() == str(fake_binary)

    def test_raises_when_nothing_resolves(
        self, clean_env, no_embedded_binary
    ) -> None:
        with pytest.raises(AgentRelayProcessError, match="not found"):
            _resolve_default_binary_path()

    def test_error_message_uses_normalized_arch(
        self, clean_env, no_embedded_binary, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(client_module.platform, "system", lambda: "Linux")
        monkeypatch.setattr(client_module.platform, "machine", lambda: "x86_64")
        with pytest.raises(AgentRelayProcessError) as excinfo:
            _resolve_default_binary_path()
        # The error must use the same identifier as the supported list (x64),
        # not the raw uname value (x86_64).
        assert "linux-x64" in str(excinfo.value)
        assert "x86_64" not in str(excinfo.value)

    def test_error_message_normalizes_aarch64(
        self, clean_env, no_embedded_binary, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(client_module.platform, "system", lambda: "Linux")
        monkeypatch.setattr(client_module.platform, "machine", lambda: "aarch64")
        with pytest.raises(AgentRelayProcessError) as excinfo:
            _resolve_default_binary_path()
        assert "linux-arm64" in str(excinfo.value)
