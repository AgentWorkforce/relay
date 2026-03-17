"""E2E test: Agno Python adapter against live Relaycast."""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from types import ModuleType
from unittest.mock import MagicMock

import pytest

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import RelayConfig


def _live_config() -> RelayConfig:
    return RelayConfig.resolve(
        workspace=os.environ.get("RELAY_WORKSPACE"),
        api_key=os.environ.get("RELAY_API_KEY"),
        base_url=os.environ.get("RELAY_BASE_URL"),
        channels=["general"],
        auto_cleanup=False,
    )


def _unique_name(prefix: str = "e2e-agno") -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


def _install_agno_module(monkeypatch):
    """Inject a fake 'agno' module tree so the adapter resolves correctly."""
    agno_mod = ModuleType("agno")
    agno_agent_mod = ModuleType("agno.agent")
    agno_agent_mod.Agent = type("Agent", (), {})
    agno_mod.agent = agno_agent_mod
    monkeypatch.setitem(sys.modules, "agno", agno_mod)
    monkeypatch.setitem(sys.modules, "agno.agent", agno_agent_mod)
    return agno_agent_mod


def _make_mock_agent(name: str, AgentCls):
    agent = MagicMock(spec=AgentCls)
    agent.name = name
    agent.tools = []
    agent.instructions = "You are a helpful Agno agent."
    type(agent).__module__ = "agno.agent"
    return agent


@pytest.mark.asyncio
async def test_agno_e2e(monkeypatch):
    """Full round-trip: real Relay, mock Agno Agent, live Relaycast API."""
    agno_agent_mod = _install_agno_module(monkeypatch)
    from agent_relay.communicate.adapters.agno import on_relay

    sender_name = _unique_name("e2e-agno-s")
    receiver_name = _unique_name("e2e-agno-r")
    config = _live_config()

    sender_relay = Relay(sender_name, config)
    receiver_relay = Relay(receiver_name, config)

    sender_agent = _make_mock_agent(sender_name, agno_agent_mod.Agent)
    receiver_agent = _make_mock_agent(receiver_name, agno_agent_mod.Agent)

    try:
        # Step 1: on_relay injects 4 tools
        wrapped_s = on_relay(sender_agent, sender_relay)
        wrapped_r = on_relay(receiver_agent, receiver_relay)
        assert wrapped_s is sender_agent
        assert wrapped_r is receiver_agent
        assert len(sender_agent.tools) == 4
        tool_names = {fn.__name__ for fn in sender_agent.tools}
        assert tool_names == {"relay_send", "relay_inbox", "relay_post", "relay_agents"}

        # Step 2: relay_agents tool lists the registered agent
        agents_fn = next(f for f in sender_agent.tools if f.__name__ == "relay_agents")
        result = await agents_fn()
        assert isinstance(result, str)
        assert sender_name in result

        # Step 3: relay_post tool posts to a channel
        post_fn = next(f for f in sender_agent.tools if f.__name__ == "relay_post")
        post_result = await post_fn("general", f"agno-e2e-{uuid.uuid4().hex[:8]}")
        assert post_result == "Message posted"

        # Step 4: relay_send + relay_inbox across two agents
        send_fn = next(f for f in sender_agent.tools if f.__name__ == "relay_send")
        inbox_fn = next(f for f in receiver_agent.tools if f.__name__ == "relay_inbox")

        # Ensure receiver is connected first
        await receiver_relay.agents()

        dm_text = f"agno-dm-{uuid.uuid4().hex[:8]}"
        await send_fn(receiver_name, dm_text)

        deadline = asyncio.get_event_loop().time() + 15.0
        found = False
        while asyncio.get_event_loop().time() < deadline:
            result = await inbox_fn()
            if sender_name in result and dm_text in result:
                found = True
                break
            await asyncio.sleep(0.5)
        assert found, f"DM from {sender_name} not received within timeout"

        # Step 5: instructions wrapper returns base instructions when no pending msgs
        assert callable(receiver_agent.instructions)
        instr = await receiver_agent.instructions()
        assert "You are a helpful Agno agent." in instr

        # Step 6: instructions wrapper prepends messages when present
        instr_text = f"instr-msg-{uuid.uuid4().hex[:8]}"
        await sender_relay.send(receiver_name, instr_text)

        deadline = asyncio.get_event_loop().time() + 15.0
        found_instr = False
        while asyncio.get_event_loop().time() < deadline:
            msgs = await receiver_relay.peek()
            if any(m.text == instr_text for m in msgs):
                found_instr = True
                break
            await asyncio.sleep(0.5)
        assert found_instr, "Instruction message did not arrive in receiver buffer"

        instr_with_msgs = await receiver_agent.instructions()
        assert sender_name in instr_with_msgs
        assert instr_text in instr_with_msgs
        assert "You are a helpful Agno agent." in instr_with_msgs

    finally:
        await asyncio.gather(sender_relay.close(), receiver_relay.close())


@pytest.mark.asyncio
async def test_agno_cleanup(monkeypatch):
    """relay.close() disconnects the transport cleanly."""
    agno_agent_mod = _install_agno_module(monkeypatch)
    from agent_relay.communicate.adapters.agno import on_relay

    agent_name = _unique_name("e2e-agno-cleanup")
    config = _live_config()
    relay = Relay(agent_name, config)
    mock_agent = _make_mock_agent(agent_name, agno_agent_mod.Agent)

    on_relay(mock_agent, relay)
    agents = await relay.agents()
    assert agent_name in agents

    await relay.close()
    assert not relay._connected
