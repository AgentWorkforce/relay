"""Tests for the Pi RPC Python adapter."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest


def _adapter_module():
    import importlib
    import sys

    if "agent_relay.communicate.adapters.pi" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.pi"])
    return importlib.import_module("agent_relay.communicate.adapters.pi")


@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "PiTester"
    relay.on_message = MagicMock(return_value=lambda: None)
    return relay


def _make_mock_proc():
    proc = MagicMock()
    proc.stdin = MagicMock()
    proc.stdout = iter([])
    proc.stderr = MagicMock()
    proc.poll = MagicMock(return_value=None)
    proc.terminate = MagicMock()
    proc.wait = MagicMock()
    return proc


class TestOnRelay:
    """Test the on_relay() function."""

    @patch("subprocess.Popen")
    def test_spawns_pi_in_rpc_mode(self, mock_popen, mock_relay):
        adapter = _adapter_module()
        mock_popen.return_value = _make_mock_proc()

        adapter.on_relay("PiTester", relay=mock_relay)

        mock_popen.assert_called_once()
        cmd = mock_popen.call_args[0][0]
        assert "pi" in cmd
        assert "--mode" in cmd
        assert "rpc" in cmd
        assert "--no-session" in cmd

    @patch("subprocess.Popen")
    def test_passes_model_and_provider_flags(self, mock_popen, mock_relay):
        adapter = _adapter_module()
        mock_popen.return_value = _make_mock_proc()

        adapter.on_relay(
            "PiTester",
            config={"model": "claude-sonnet", "provider": "anthropic"},
            relay=mock_relay,
        )

        cmd = mock_popen.call_args[0][0]
        assert "--model" in cmd
        assert "claude-sonnet" in cmd
        assert "--provider" in cmd
        assert "anthropic" in cmd

    @patch("subprocess.Popen")
    def test_returns_pi_rpc_session(self, mock_popen, mock_relay):
        adapter = _adapter_module()
        mock_popen.return_value = _make_mock_proc()

        session = adapter.on_relay("PiTester", relay=mock_relay)

        assert isinstance(session, adapter.PiRpcSession)

    @patch("subprocess.Popen")
    def test_registers_relay_on_message_callback(self, mock_popen, mock_relay):
        adapter = _adapter_module()
        mock_popen.return_value = _make_mock_proc()

        adapter.on_relay("PiTester", relay=mock_relay)

        assert mock_relay.on_message.called


class TestPiRpcSession:
    """Test the PiRpcSession class."""

    def test_send_command_writes_jsonl(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.send_command({"type": "prompt", "message": "Hello"})

        proc.stdin.write.assert_called_once()
        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["type"] == "prompt"
        assert parsed["message"] == "Hello"
        proc.stdin.flush.assert_called_once()

    def test_prompt_sends_prompt_command(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.prompt("Build a feature")

        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["type"] == "prompt"
        assert parsed["message"] == "Build a feature"
        assert "streamingBehavior" not in parsed

    def test_steer_sends_steer_command(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.steer("Change direction")

        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["type"] == "prompt"
        assert parsed["message"] == "Change direction"
        assert parsed["streamingBehavior"] == "steer"

    def test_follow_up_sends_follow_up_command(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.follow_up("Next task")

        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["type"] == "prompt"
        assert parsed["message"] == "Next task"
        assert parsed["streamingBehavior"] == "followUp"

    def test_abort_sends_abort_command(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.abort()

        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["type"] == "abort"

    def test_close_terminates_subprocess(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.close()

        proc.terminate.assert_called_once()
        proc.wait.assert_called_once()

    def test_close_kills_on_timeout(self, mock_relay):
        import subprocess as sp

        adapter = _adapter_module()
        proc = _make_mock_proc()
        proc.wait.side_effect = sp.TimeoutExpired(cmd="pi", timeout=5)
        session = adapter.PiRpcSession(proc, mock_relay)

        session.close()

        proc.terminate.assert_called_once()
        proc.kill.assert_called_once()

    def test_close_is_idempotent(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        session.close()
        session.close()

        proc.terminate.assert_called_once()

    def test_close_unsubscribes_relay(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        unsub = MagicMock()
        session = adapter.PiRpcSession(proc, mock_relay)
        session._unsubscribe = unsub

        session.close()

        unsub.assert_called_once()


class TestRelayMessageRouting:
    """Test that incoming relay messages are routed to Pi."""

    @patch("subprocess.Popen")
    def test_relay_message_routes_follow_up_when_idle(self, mock_popen, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        mock_popen.return_value = proc

        session = adapter.on_relay("PiTester", relay=mock_relay)
        session._is_streaming = False

        callback = mock_relay.on_message.call_args[0][0]
        from agent_relay.communicate.types import Message

        callback(Message(sender="Lead", text="Need status"))

        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["streamingBehavior"] == "followUp"
        assert "Lead" in parsed["message"]
        assert "Need status" in parsed["message"]

    @patch("subprocess.Popen")
    def test_relay_message_routes_steer_when_streaming(self, mock_popen, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        mock_popen.return_value = proc

        session = adapter.on_relay("PiTester", relay=mock_relay)
        session._is_streaming = True

        callback = mock_relay.on_message.call_args[0][0]
        from agent_relay.communicate.types import Message

        callback(Message(sender="Review", text="Waiting on Gate 2.3"))

        written = proc.stdin.write.call_args[0][0]
        parsed = json.loads(written.strip())
        assert parsed["streamingBehavior"] == "steer"
        assert "Review" in parsed["message"]
        assert "Waiting on Gate 2.3" in parsed["message"]


class TestEventHandling:
    """Test stdout event processing."""

    def test_on_event_registers_callback(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        events = []
        session.on_event(lambda e: events.append(e))

        assert len(session._event_callbacks) == 1

    def test_on_event_returns_unsubscribe(self, mock_relay):
        adapter = _adapter_module()
        proc = _make_mock_proc()
        session = adapter.PiRpcSession(proc, mock_relay)

        unsub = session.on_event(lambda e: None)
        assert len(session._event_callbacks) == 1

        unsub()
        assert len(session._event_callbacks) == 0
