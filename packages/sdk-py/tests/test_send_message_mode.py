from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from agent_relay.client import AgentRelayClient
from agent_relay.relay import AgentRelay, HumanHandle


@pytest.mark.asyncio
async def test_client_send_message_includes_mode_in_payload():
    client = AgentRelayClient(binary_path="agent-relay-broker")
    client.start_client = AsyncMock()

    payloads: list[dict] = []

    async def fake_request_ok(type_: str, payload: dict):
        assert type_ == "send_message"
        payloads.append(payload)
        return {"event_id": "evt-1", "targets": ["Worker"]}

    client._request_ok = fake_request_ok  # type: ignore[method-assign]

    result = await client.send_message(
        to="Worker",
        text="hello",
        from_="system",
        thread_id="thread-1",
        priority=5,
        data={"k": "v"},
        mode="steer",
    )

    assert result["event_id"] == "evt-1"
    assert payloads == [
        {
            "to": "Worker",
            "text": "hello",
            "from": "system",
            "thread_id": "thread-1",
            "priority": 5,
            "data": {"k": "v"},
            "mode": "steer",
        }
    ]


@pytest.mark.asyncio
async def test_human_send_message_passes_mode_and_sets_message_mode():
    relay = AgentRelay()
    client = AsyncMock()
    client.send_message = AsyncMock(return_value={"event_id": "evt-2"})
    relay._ensure_started = AsyncMock(return_value=client)

    human = HumanHandle("system", relay)
    msg = await human.send_message(to="Worker", text="status?", mode="wait")

    assert msg.mode == "wait"
    client.send_message.assert_awaited_once_with(
        to="Worker",
        text="status?",
        from_="system",
        thread_id=None,
        priority=None,
        data=None,
        mode="wait",
    )


@pytest.mark.asyncio
async def test_agent_send_message_passes_mode_and_sets_message_mode():
    relay = AgentRelay()
    client = AsyncMock()
    client.spawn_pty = AsyncMock(return_value={"name": "Worker", "runtime": "pty"})
    client.send_message = AsyncMock(return_value={"event_id": "evt-3"})
    relay._ensure_started = AsyncMock(return_value=client)

    agent = await relay.spawn("Worker", "claude")
    msg = await agent.send_message(to="Reviewer", text="ready", mode="steer")

    assert msg.mode == "steer"
    client.send_message.assert_awaited_with(
        to="Reviewer",
        text="ready",
        from_="Worker",
        thread_id=None,
        priority=None,
        data=None,
        mode="steer",
    )
