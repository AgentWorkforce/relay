"""Tests for the Agno Python adapter."""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Mock agno before it's imported in the adapter
agno_mock = MagicMock()
sys.modules["agno"] = agno_mock
sys.modules["agno.agent"] = agno_mock.agent

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.agno" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.agno"])
    return importlib.import_module("agent_relay.communicate.adapters.agno")

@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "TestAgent"
    relay.inbox = AsyncMock(return_value=[])
    relay.peek = AsyncMock(return_value=[])
    relay.send = AsyncMock()
    relay.post = AsyncMock()
    relay.agents = AsyncMock(return_value=[])
    return relay

@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.tools = []
    agent.instructions = "Agno base instructions."
    return agent

def test_on_relay_adds_tools(mock_relay, mock_agent):
    adapter = _adapter_module()
    
    adapter.on_relay(mock_agent, mock_relay)
    
    tools = {t.__name__: t for t in mock_agent.tools}
    assert "relay_send" in tools
    assert "relay_inbox" in tools
    assert "relay_post" in tools
    assert "relay_agents" in tools

@pytest.mark.asyncio
async def test_tool_execution(mock_relay, mock_agent):
    adapter = _adapter_module()
    adapter.on_relay(mock_agent, mock_relay)
    tools = {t.__name__: t for t in mock_agent.tools}
    
    # Test relay_send
    await tools["relay_send"]("Alice", "Hi")
    mock_relay.send.assert_called_with("Alice", "Hi")
    
    # Test relay_inbox
    from agent_relay.communicate.types import Message
    mock_relay.inbox.return_value = [Message(sender="Bob", text="Hey")]
    inbox_res = await tools["relay_inbox"]()
    assert "From Bob: Hey" in inbox_res
    
    # Test relay_post
    await tools["relay_post"]("general", "Update")
    mock_relay.post.assert_called_with("general", "Update")
    
    # Test relay_agents
    mock_relay.agents.return_value = ["Alice", "Bob"]
    agents_res = await tools["relay_agents"]()
    assert "Alice, Bob" in agents_res

@pytest.mark.asyncio
async def test_instructions_wrapping(mock_relay, mock_agent):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message
    
    mock_relay.peek.return_value = [
        Message(sender="Other", text="Agno message", message_id="1")
    ]

    adapter.on_relay(mock_agent, mock_relay)

    assert callable(mock_agent.instructions)

    result = await mock_agent.instructions()
    assert "Agno base instructions." in result
    assert "Other: Agno message" in result

@pytest.mark.asyncio
async def test_instructions_wrapping_callable(mock_relay, mock_agent):
    """Chaining: existing callable instructions are preserved."""
    adapter = _adapter_module()

    original_instructions = MagicMock(return_value="Dynamic context.")
    mock_agent.instructions = original_instructions

    adapter.on_relay(mock_agent, mock_relay)

    result = await mock_agent.instructions()
    assert "Dynamic context." in result
    assert original_instructions.called


@pytest.mark.asyncio
async def test_instructions_wrapping_async_callable(mock_relay, mock_agent):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    async def original_instructions():
        return "Async context."

    mock_agent.instructions = original_instructions
    mock_relay.peek.return_value = [Message(sender="Other", text="Agno message", message_id="1")]

    adapter.on_relay(mock_agent, mock_relay)

    result = await mock_agent.instructions()
    assert result.startswith("\n\nNew messages from other agents:\n  Other: Agno message\n")
    assert result.endswith("\n\nAsync context.")

@pytest.mark.asyncio
async def test_instructions_no_messages(mock_relay, mock_agent):
    """When inbox is empty, only base instructions returned."""
    adapter = _adapter_module()
    mock_relay.peek = AsyncMock(return_value=[])

    adapter.on_relay(mock_agent, mock_relay)

    result = await mock_agent.instructions()
    assert result == "Agno base instructions."

def test_on_relay_returns_agent(mock_relay, mock_agent):
    """on_relay() returns the modified agent."""
    adapter = _adapter_module()
    result = adapter.on_relay(mock_agent, mock_relay)
    assert result is mock_agent
