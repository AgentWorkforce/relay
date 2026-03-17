"""E2E test: OpenAI Agents Python adapter against live Relaycast."""

from __future__ import annotations

import asyncio
import sys
import uuid
import time
from types import ModuleType
from unittest.mock import MagicMock

import pytest

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import RelayConfig


def _install_agents_module(monkeypatch):
    """Inject a fake 'agents' module so the adapter can import function_tool."""
    agents_mod = ModuleType("agents")
    agents_mod.Agent = type("Agent", (), {})
    agents_mod.function_tool = MagicMock(side_effect=lambda func: func)
    monkeypatch.setitem(sys.modules, "agents", agents_mod)
    return agents_mod


def _make_mock_agent(name: str):
    agent = MagicMock()
    agent.name = name
    agent.tools = []
    agent.instructions = "You are a helpful agent."
    type(agent).__module__ = "agents"
    return agent


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


@pytest.mark.asyncio
async def test_openai_agents_e2e(monkeypatch):
    """Full round-trip: real Relay, mock Agent, live Relaycast API."""
    agents_mod = _install_agents_module(monkeypatch)

    from agent_relay.communicate.adapters.openai_agents import on_relay

    agent_name = _unique_name("oai-py-e2e")
    config = RelayConfig.resolve(channels=["general"], auto_cleanup=False)

    relay = Relay(agent_name, config)
    mock_agent = _make_mock_agent(agent_name)

    try:
        # Step 1: wrap agent — tools should be injected
        wrapped = on_relay(mock_agent, relay)
        assert wrapped is mock_agent
        assert agents_mod.function_tool.call_count == 4
        tool_names = [c.args[0].__name__ for c in agents_mod.function_tool.call_args_list]
        assert set(tool_names) == {"relay_send", "relay_inbox", "relay_post", "relay_agents"}
        assert len(mock_agent.tools) == 4

        # Step 2: list_agents against real API
        agents_list = await relay.agents()
        assert isinstance(agents_list, list)
        assert agent_name in agents_list, f"{agent_name} not in {agents_list}"

        # Step 3: post a message to the general channel
        test_text = f"e2e-openai-py-{uuid.uuid4().hex[:8]}"
        await relay.post("general", test_text)

        # Step 4: invoke the relay_agents tool closure
        relay_agents_fn = mock_agent.tools[3]
        result = await relay_agents_fn()
        assert isinstance(result, str)
        assert agent_name in result

        # Step 5: invoke the relay_post tool closure
        relay_post_fn = mock_agent.tools[2]
        post_result = await relay_post_fn("general", f"tool-post-{uuid.uuid4().hex[:6]}")
        assert post_result == "Message posted"

        # Step 6: instructions wrapper returns base instructions when no pending msgs
        assert callable(mock_agent.instructions)
        instr = await mock_agent.instructions()
        assert "You are a helpful agent." in instr

    finally:
        await relay.close()
