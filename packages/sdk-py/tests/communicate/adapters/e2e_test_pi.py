"""End-to-end tests for the Pi RPC Python adapter against live Relaycast.

Reuses a small number of Relay connections across tests to stay within
the 60 req/min rate limit of the free plan.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from unittest.mock import MagicMock, patch

import pytest

from agent_relay.communicate import Relay
from agent_relay.communicate.adapters.pi import RELAY_TOOL_PREAMBLE, PiRpcSession, on_relay
from agent_relay.communicate.types import Message, RelayConfig


def _live_config() -> RelayConfig:
    return RelayConfig.resolve(
        workspace=os.environ.get("RELAY_WORKSPACE"),
        api_key=os.environ.get("RELAY_API_KEY"),
        base_url=os.environ.get("RELAY_BASE_URL"),
        channels=[],
        auto_cleanup=False,
    )


def _unique_name(prefix: str = "e2e-pi-py") -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"


def _make_mock_proc():
    proc = MagicMock()
    proc.stdin = MagicMock()
    proc.stdout = iter([])
    proc.stderr = MagicMock()
    proc.poll = MagicMock(return_value=None)
    proc.terminate = MagicMock()
    proc.wait = MagicMock()
    return proc


@pytest.mark.asyncio
async def test_pi_adapter_e2e():
    """Comprehensive e2e test for the Pi adapter against live Relaycast.

    Uses only 2 Relay connections to minimize API calls and stay within rate limits.
    Tests cover:
    1. PiRpcSession creation via on_relay() with a real Relay
    2. RELAY_TOOL_PREAMBLE contents
    3. Relay registration against live API (unique agent name with uuid suffix)
    4. relay.agents() - live agent list
    5. relay.send() + relay.inbox() - DM round-trip
    6. relay.post() - channel posting
    7. PiRpcSession relay message callback routing
    8. Cleanup / disconnect
    """
    config = _live_config()
    sender_name = _unique_name("e2e-pi-sender")
    receiver_name = _unique_name("e2e-pi-recv")

    sender = Relay(sender_name, config)
    receiver = Relay(receiver_name, config)

    try:
        # --- 1. Registration: both agents connect and appear in agent list ---
        agents = await sender.agents()
        assert sender_name in agents, f"{sender_name} not in agents after connect"

        await asyncio.sleep(1)
        agents2 = await receiver.agents()
        assert receiver_name in agents2, f"{receiver_name} not in agents after connect"
        assert sender_name in agents2, f"{sender_name} not visible to receiver"

        # --- 2. RELAY_TOOL_PREAMBLE has expected relay tool descriptions ---
        assert "relay_send" in RELAY_TOOL_PREAMBLE
        assert "relay_inbox" in RELAY_TOOL_PREAMBLE
        assert "relay_agents" in RELAY_TOOL_PREAMBLE
        assert "relay_post" in RELAY_TOOL_PREAMBLE

        # --- 3. on_relay() creates a PiRpcSession backed by a real Relay ---
        with patch("subprocess.Popen") as mock_popen:
            proc = _make_mock_proc()
            mock_popen.return_value = proc

            session = on_relay(sender_name, relay=sender)

            assert isinstance(session, PiRpcSession)
            assert session._relay is sender
            assert session._relay.agent_name == sender_name

            # --- 4. Relay message callback routes to Pi subprocess ---
            msg = Message(sender="test-lead", text="status update request")
            callback = sender._callbacks[0]
            callback(msg)

            written = proc.stdin.write.call_args[0][0]
            parsed = json.loads(written.strip())
            assert "test-lead" in parsed["message"]
            assert "status update request" in parsed["message"]
            assert parsed["streamingBehavior"] == "followUp"

            # Clean up session (subprocess mock only)
            session.close()
            proc.terminate.assert_called_once()
            assert session._closed

        await asyncio.sleep(1)

        # --- 5. DM round-trip: send() + inbox() ---
        text = f"pi-e2e-{uuid.uuid4().hex[:8]}"
        await sender.send(receiver_name, text)

        deadline = asyncio.get_event_loop().time() + 15.0
        found = False
        while asyncio.get_event_loop().time() < deadline:
            messages = await receiver.inbox()
            for m in messages:
                if m.sender == sender_name and m.text == text:
                    found = True
                    break
            if found:
                break
            await asyncio.sleep(1.0)

        assert found, f"DM from {sender_name} not received within timeout"

        await asyncio.sleep(1)

        # --- 6. Post to channel ---
        await sender.join("general")
        await sender.post("general", f"pi-e2e-test-{uuid.uuid4().hex[:8]}")

        # --- 7. Cleanup: close both relays ---
        # Relaycast presence is eventually consistent -- agents may remain
        # "online" in list_agents for a heartbeat window after disconnect.
        # We verify that close() completes without error (same approach as
        # the existing transport e2e tests).
        await sender.close()
        assert not sender._connected, "sender._connected should be False after close"
        await receiver.close()
        assert not receiver._connected, "receiver._connected should be False after close"

    except Exception:
        # Best-effort cleanup on failure
        for r in (sender, receiver):
            try:
                await r.close()
            except Exception:
                pass
        raise
