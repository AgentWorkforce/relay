"""Tests for the OpenAI Agents Python adapter."""

from __future__ import annotations

from types import ModuleType
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.openai_agents" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.openai_agents"])
    return importlib.import_module("agent_relay.communicate.adapters.openai_agents")


def _install_agents_module(monkeypatch):
    agents_module = ModuleType("agents")
    agents_module.Agent = type("Agent", (), {})
    agents_module.function_tool = MagicMock(side_effect=lambda func: func)
    monkeypatch.setitem(sys.modules, "agents", agents_module)
    return agents_module

@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "TestAgent"
    relay.inbox = AsyncMock(return_value=[])
    return relay

@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.tools = []
    agent.instructions = "Be helpful."
    return agent

def test_on_relay_adds_tools(monkeypatch, mock_relay, mock_agent):
    agents_module = _install_agents_module(monkeypatch)
    adapter = _adapter_module()

    adapter.on_relay(mock_agent, mock_relay)

    assert agents_module.function_tool.call_count == 4
    called_args = [call.args[0].__name__ for call in agents_module.function_tool.call_args_list]
    assert "relay_send" in called_args

@pytest.mark.asyncio
async def test_instructions_wrapping_string(monkeypatch, mock_relay, mock_agent):
    _install_agents_module(monkeypatch)
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    mock_relay.inbox.return_value = [
        Message(sender="Other", text="Hello", message_id="1")
    ]

    adapter.on_relay(mock_agent, mock_relay)

    assert callable(mock_agent.instructions)

    result = await mock_agent.instructions()
    assert "Be helpful." in result
    assert "Other: Hello" in result

@pytest.mark.asyncio
async def test_instructions_wrapping_callable(monkeypatch, mock_relay, mock_agent):
    _install_agents_module(monkeypatch)
    adapter = _adapter_module()

    original_instructions = MagicMock(return_value="Original context.")
    mock_agent.instructions = original_instructions

    adapter.on_relay(mock_agent, mock_relay)

    result = await mock_agent.instructions()
    assert "Original context." in result
    assert original_instructions.called


@pytest.mark.asyncio
async def test_instructions_wrapping_async_callable(monkeypatch, mock_relay, mock_agent):
    _install_agents_module(monkeypatch)
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    async def original_instructions():
        return "Async context."

    mock_agent.instructions = original_instructions
    mock_relay.inbox.return_value = [Message(sender="Other", text="Hello", message_id="1")]

    adapter.on_relay(mock_agent, mock_relay)

    result = await mock_agent.instructions()
    assert result.startswith("\n\nNew messages from other agents:\n  Other: Hello\n")
    assert result.endswith("\n\nAsync context.")
