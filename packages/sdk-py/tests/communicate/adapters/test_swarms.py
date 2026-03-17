"""Tests for the Swarms Python adapter."""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Mock swarms before it's imported in the adapter
swarms_mock = MagicMock()
sys.modules["swarms"] = swarms_mock

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.swarms" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.swarms"])
    return importlib.import_module("agent_relay.communicate.adapters.swarms")

@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "TestAgent"
    relay.inbox = AsyncMock(return_value=[])
    relay.send = AsyncMock()
    relay.post = AsyncMock()
    relay.agents = AsyncMock(return_value=[])
    relay.on_message = MagicMock(return_value=lambda: None)
    return relay

@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.tools = []
    agent.receive_message = MagicMock()
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
    mock_relay.send = AsyncMock()
    await tools["relay_send"]("Alice", "Hi")
    mock_relay.send.assert_called_with("Alice", "Hi")
    
    # Test relay_inbox
    from agent_relay.communicate.types import Message
    mock_relay.inbox.return_value = [Message(sender="Bob", text="Hey")]
    inbox_res = await tools["relay_inbox"]()
    assert "Bob: Hey" in inbox_res
    
    # Test relay_post
    mock_relay.post = AsyncMock()
    await tools["relay_post"]("general", "Update")
    mock_relay.post.assert_called_with("general", "Update")
    
    # Test relay_agents
    mock_relay.agents.return_value = ["Alice", "Bob"]
    agents_res = await tools["relay_agents"]()
    assert "Alice, Bob" in agents_res

def test_on_relay_registers_callback(mock_relay, mock_agent):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message
    
    adapter.on_relay(mock_agent, mock_relay)
    
    assert mock_relay.on_message.called
    callback = mock_relay.on_message.call_args[0][0]
    
    # Simulate an incoming message
    msg = Message(sender="Lead", text="Status?", channel="general")
    callback(msg)
    
    assert mock_agent.receive_message.called
    # Swarms receive_message usually takes (sender, text)
    mock_agent.receive_message.assert_called_with("Lead", "Status?")

def test_on_relay_returns_agent(mock_relay, mock_agent):
    """on_relay() returns the modified agent."""
    adapter = _adapter_module()
    result = adapter.on_relay(mock_agent, mock_relay)
    assert result is mock_agent

def test_callback_multiple_messages(mock_relay, mock_agent):
    """Multiple incoming messages each trigger receive_message."""
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    adapter.on_relay(mock_agent, mock_relay)
    callback = mock_relay.on_message.call_args[0][0]

    callback(Message(sender="A", text="first"))
    callback(Message(sender="B", text="second"))

    assert mock_agent.receive_message.call_count == 2
    mock_agent.receive_message.assert_any_call("A", "first")
    mock_agent.receive_message.assert_any_call("B", "second")
