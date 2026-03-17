"""E2E test: LangGraph-style tool wrapping with core Relay against live Relaycast.

There is no dedicated LangGraph Python adapter — this test demonstrates using
the core Relay class with LangGraph-compatible tool functions (plain async
callables that can be wrapped with @tool or used directly in a ToolNode).
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import RelayConfig

pytestmark = pytest.mark.asyncio

RATE_LIMIT_PAUSE = 5  # seconds between tests to avoid 429


@pytest.fixture(autouse=True)
async def _rate_limit_pause():
    """Pause between tests to respect the 60 req/min rate limit."""
    yield
    await asyncio.sleep(RATE_LIMIT_PAUSE)


def _e2e_config() -> RelayConfig:
    config = RelayConfig.resolve(
        workspace=os.environ.get("RELAY_WORKSPACE"),
        api_key=os.environ.get("RELAY_API_KEY"),
        base_url=os.environ.get("RELAY_BASE_URL"),
        channels=[],
        auto_cleanup=False,
    )
    if not config.workspace or not config.api_key:
        pytest.fail("RELAY_WORKSPACE and RELAY_API_KEY must be set.")
    return config


def _unique_name(prefix: str = "e2e-langgraph") -> str:
    ts = int(time.time() * 1000)
    return f"{prefix}-{ts}-{uuid.uuid4().hex[:6]}"


# ---------------------------------------------------------------------------
# LangGraph-style tool factories
# These mirror what a real LangGraph ToolNode would use.
# ---------------------------------------------------------------------------

def make_relay_tools(relay: Relay) -> dict[str, object]:
    """Create LangGraph-compatible async tool functions backed by a Relay instance."""

    async def relay_send(to: str, message: str) -> str:
        """Send a DM to another agent."""
        await relay.send(to, message)
        return "Message sent"

    async def relay_inbox() -> str:
        """Check the inbox for new messages."""
        messages = await relay.inbox()
        if not messages:
            return "No new messages"
        return "\n".join(f"[{m.sender}] {m.text}" for m in messages)

    async def relay_agents() -> str:
        """List all connected agents."""
        agents = await relay.agents()
        return ", ".join(agents) if agents else "No agents online"

    async def relay_post(channel: str, message: str) -> str:
        """Post a message to a channel."""
        await relay.post(channel, message)
        return "Message posted"

    return {
        "relay_send": relay_send,
        "relay_inbox": relay_inbox,
        "relay_agents": relay_agents,
        "relay_post": relay_post,
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_langgraph_tool_creation():
    """make_relay_tools() should return four async callables."""
    config = _e2e_config()
    agent_name = _unique_name("lg-tools")

    relay = Relay(agent_name, config)
    try:
        tools = make_relay_tools(relay)
        expected = {"relay_send", "relay_inbox", "relay_agents", "relay_post"}
        assert set(tools.keys()) == expected
        for fn in tools.values():
            assert asyncio.iscoroutinefunction(fn)
    finally:
        await relay.close()


async def test_langgraph_relay_agents_live():
    """relay_agents tool should list agents from the live workspace."""
    config = _e2e_config()
    agent_name = _unique_name("lg-list")

    relay = Relay(agent_name, config)
    try:
        tools = make_relay_tools(relay)
        result = await tools["relay_agents"]()
        assert isinstance(result, str)
        assert agent_name in result, f"Expected {agent_name} in agents list, got: {result}"
    finally:
        await relay.close()


async def test_langgraph_relay_send_dm():
    """relay_send tool should successfully send a DM via live API."""
    config = _e2e_config()
    sender_name = _unique_name("lg-sender")
    receiver_name = _unique_name("lg-recv")

    sender_relay = Relay(sender_name, config)
    receiver_relay = Relay(receiver_name, config)
    try:
        await receiver_relay._ensure_connected()

        tools = make_relay_tools(sender_relay)
        result = await tools["relay_send"](receiver_name, f"hello-{uuid.uuid4().hex[:8]}")
        assert result == "Message sent"
    finally:
        await asyncio.gather(sender_relay.close(), receiver_relay.close())


async def test_langgraph_relay_post_channel():
    """relay_post tool should successfully post to a channel via live API."""
    config = _e2e_config()
    agent_name = _unique_name("lg-post")

    relay = Relay(agent_name, config)
    try:
        await relay.join("general")

        tools = make_relay_tools(relay)
        msg_text = f"e2e-lg-post-{uuid.uuid4().hex[:8]}"
        result = await tools["relay_post"]("general", msg_text)
        assert result == "Message posted"
    finally:
        await relay.close()


async def test_langgraph_inbox_round_trip():
    """Send a DM and verify it appears in the receiver's inbox."""
    config = _e2e_config()
    sender_name = _unique_name("lg-inbox-s")
    receiver_name = _unique_name("lg-inbox-r")

    sender_relay = Relay(sender_name, config)
    receiver_relay = Relay(receiver_name, config)
    try:
        sender_tools = make_relay_tools(sender_relay)
        receiver_tools = make_relay_tools(receiver_relay)

        dm_text = f"lg-dm-{uuid.uuid4().hex[:8]}"
        await sender_tools["relay_send"](receiver_name, dm_text)

        deadline = asyncio.get_event_loop().time() + 15.0
        found = False
        while asyncio.get_event_loop().time() < deadline:
            inbox_result = await receiver_tools["relay_inbox"]()
            if dm_text in inbox_result:
                found = True
                break
            await asyncio.sleep(0.5)
        assert found, f"DM containing '{dm_text}' not received within timeout"
    finally:
        await asyncio.gather(sender_relay.close(), receiver_relay.close())


async def test_langgraph_full_round_trip():
    """Full round-trip: register, list agents, send DM, post to channel, inbox, close."""
    config = _e2e_config()
    agent_name = _unique_name("lg-full")
    peer_name = _unique_name("lg-peer")

    relay = Relay(agent_name, config)
    peer_relay = Relay(peer_name, config)

    try:
        tools = make_relay_tools(relay)
        peer_tools = make_relay_tools(peer_relay)

        # Ensure peer is connected
        await peer_relay._ensure_connected()

        # 1. list_agents — both should appear
        agents_result = await tools["relay_agents"]()
        assert agent_name in agents_result
        assert peer_name in agents_result

        # 2. send DM
        dm_text = f"lg-roundtrip-{uuid.uuid4().hex[:8]}"
        send_result = await tools["relay_send"](peer_name, dm_text)
        assert send_result == "Message sent"

        # 3. post to channel
        await relay.join("general")
        post_text = f"lg-channel-{uuid.uuid4().hex[:8]}"
        post_result = await tools["relay_post"]("general", post_text)
        assert post_result == "Message posted"

        # 4. inbox on peer — verify DM arrived
        deadline = asyncio.get_event_loop().time() + 15.0
        found = False
        while asyncio.get_event_loop().time() < deadline:
            inbox_result = await peer_tools["relay_inbox"]()
            if dm_text in inbox_result:
                found = True
                break
            await asyncio.sleep(0.5)
        assert found, f"DM containing '{dm_text}' not received within timeout"

    finally:
        await asyncio.gather(relay.close(), peer_relay.close())


@pytest.mark.xfail(reason="Server TTL behavior — agent may linger after disconnect")
async def test_langgraph_disconnect_removes_agent():
    """After close(), the agent should no longer appear in the agents list."""
    config = _e2e_config()
    agent_name = _unique_name("lg-disc")
    observer_name = _unique_name("lg-obs")

    relay = Relay(agent_name, config)
    observer_relay = Relay(observer_name, config)
    try:
        await relay._ensure_connected()
        observer_tools = make_relay_tools(observer_relay)

        # Verify agent is listed
        agents_before = await observer_tools["relay_agents"]()
        assert agent_name in agents_before

        # Disconnect
        await relay.close()
        await asyncio.sleep(2)

        # Agent should be gone (xfail: server TTL may keep it)
        agents_after = await observer_tools["relay_agents"]()
        assert agent_name not in agents_after
    finally:
        try:
            await relay.close()
        except Exception:
            pass
        await observer_relay.close()
