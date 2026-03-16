"""Real end-to-end test of the CrewAI Python adapter against live Relaycast."""

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


def _unique_name(prefix: str) -> str:
    ts = int(time.time() * 1000)
    return f"{prefix}-{ts}-{uuid.uuid4().hex[:6]}"


async def test_crewai_on_relay_adds_tools():
    """on_relay() should attach four relay tools to a CrewAI Agent."""
    from crewai import Agent as CrewAgent
    from agent_relay.communicate.adapters.crewai import on_relay

    config = _e2e_config()
    agent_name = _unique_name("e2e-crewai-tools")

    relay = Relay(agent_name, config)
    try:
        crew_agent = CrewAgent(
            role="Test worker",
            goal="Verify relay tools",
            backstory="Test agent.",
            llm="gpt-4o-mini",
        )
        original_tool_count = len(crew_agent.tools)

        wrapped = on_relay(crew_agent, relay)
        assert wrapped is crew_agent

        tool_names = {t.name for t in crew_agent.tools}
        expected = {"relay_send", "relay_inbox", "relay_post", "relay_agents"}
        assert expected.issubset(tool_names), f"Missing tools: {expected - tool_names}"
        assert len(crew_agent.tools) >= original_tool_count + 4
    finally:
        await relay.close()


async def test_crewai_relay_agents_lists_live_agents():
    """relay_agents tool should list agents from the live workspace."""
    from crewai import Agent as CrewAgent
    from agent_relay.communicate.adapters.crewai import on_relay

    config = _e2e_config()
    agent_name = _unique_name("e2e-crewai-list")

    relay = Relay(agent_name, config)
    try:
        crew_agent = CrewAgent(
            role="Lister",
            goal="List agents",
            backstory="Lists agents.",
            llm="gpt-4o-mini",
        )
        on_relay(crew_agent, relay)

        tools_by_name = {t.name: t for t in crew_agent.tools}
        agents_tool = tools_by_name["relay_agents"]

        result = await agents_tool.func()
        assert isinstance(result, str)
        assert agent_name in result, f"Expected {agent_name} in agents list, got: {result}"
    finally:
        await relay.close()


async def test_crewai_relay_send_dm():
    """relay_send tool should successfully send a DM via live API."""
    from crewai import Agent as CrewAgent
    from agent_relay.communicate.adapters.crewai import on_relay

    config = _e2e_config()
    sender_name = _unique_name("e2e-crewai-sender")
    receiver_name = _unique_name("e2e-crewai-recv")

    sender_relay = Relay(sender_name, config)
    receiver_relay = Relay(receiver_name, config)
    try:
        sender_agent = CrewAgent(
            role="Sender",
            goal="Send messages",
            backstory="Sends.",
            llm="gpt-4o-mini",
        )
        on_relay(sender_agent, relay=sender_relay)

        # Connect receiver so it exists
        await receiver_relay._ensure_connected()

        tools_by_name = {t.name: t for t in sender_agent.tools}
        send_tool = tools_by_name["relay_send"]

        result = await send_tool.func(receiver_name, f"hello-{uuid.uuid4().hex[:8]}")
        assert result == "Message sent"
    finally:
        await asyncio.gather(sender_relay.close(), receiver_relay.close())


async def test_crewai_relay_post_channel():
    """relay_post tool should successfully post to a channel via live API."""
    from crewai import Agent as CrewAgent
    from agent_relay.communicate.adapters.crewai import on_relay

    config = _e2e_config()
    agent_name = _unique_name("e2e-crewai-post")

    relay = Relay(agent_name, config)
    try:
        crew_agent = CrewAgent(
            role="Poster",
            goal="Post to channel",
            backstory="Posts.",
            llm="gpt-4o-mini",
        )
        on_relay(crew_agent, relay=relay)

        # Join general before posting
        await relay.join("general")

        tools_by_name = {t.name: t for t in crew_agent.tools}
        post_tool = tools_by_name["relay_post"]

        msg_text = f"e2e-crewai-post-{uuid.uuid4().hex[:8]}"
        result = await post_tool.func("general", msg_text)
        assert result == "Message posted"
    finally:
        await relay.close()


async def test_crewai_backstory_wrapping():
    """on_relay() should wrap backstory so it includes relay messages."""
    from crewai import Agent as CrewAgent
    from agent_relay.communicate.adapters.crewai import on_relay

    config = _e2e_config()
    agent_name = _unique_name("e2e-crewai-backstory")

    relay = Relay(agent_name, config)
    try:
        original_backstory = "Expert researcher."
        crew_agent = CrewAgent(
            role="Researcher",
            goal="Research things",
            backstory=original_backstory,
            llm="gpt-4o-mini",
        )
        on_relay(crew_agent, relay=relay)

        backstory_str = str(crew_agent.backstory)
        assert "Expert researcher." in backstory_str
    finally:
        await relay.close()


async def test_crewai_full_round_trip():
    """Full round-trip: register, list agents, send DM, post to channel, close."""
    from crewai import Agent as CrewAgent
    from agent_relay.communicate.adapters.crewai import on_relay

    config = _e2e_config()
    agent_name = _unique_name("e2e-crewai-full")
    peer_name = _unique_name("e2e-crewai-peer")

    relay = Relay(agent_name, config)
    peer_relay = Relay(peer_name, config)

    try:
        crew_agent = CrewAgent(
            role="Full test",
            goal="Run full e2e",
            backstory="Full round trip.",
            llm="gpt-4o-mini",
        )
        on_relay(crew_agent, relay=relay)
        await peer_relay._ensure_connected()

        tools = {t.name: t for t in crew_agent.tools}

        # 1. list_agents
        agents_result = await tools["relay_agents"].func()
        assert agent_name in agents_result
        assert peer_name in agents_result

        # 2. send DM
        dm_text = f"e2e-roundtrip-{uuid.uuid4().hex[:8]}"
        send_result = await tools["relay_send"].func(peer_name, dm_text)
        assert send_result == "Message sent"

        # 3. post to channel
        await relay.join("general")
        post_text = f"e2e-channel-{uuid.uuid4().hex[:8]}"
        post_result = await tools["relay_post"].func("general", post_text)
        assert post_result == "Message posted"

        # 4. inbox (may or may not have messages, just verify it runs)
        inbox_result = await tools["relay_inbox"].func()
        assert isinstance(inbox_result, str)
    finally:
        await asyncio.gather(relay.close(), peer_relay.close())
