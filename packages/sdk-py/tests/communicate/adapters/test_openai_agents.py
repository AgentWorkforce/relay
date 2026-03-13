"""Tests for the OpenAI Agents Python adapter."""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Mock openai_agents before it's imported in the adapter
openai_mock = MagicMock()
sys.modules["openai_agents"] = openai_mock

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.openai_agents" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.openai_agents"])
    return importlib.import_module("agent_relay.communicate.adapters.openai_agents")

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

def test_on_relay_adds_tools(mock_relay, mock_agent):
    adapter = _adapter_module()
    
    adapter.on_relay(mock_agent, mock_relay)
    
    assert openai_mock.function_tool.called
    # Check that it was called with one of our relay functions
    called_args = [call[0][0].__name__ for call in openai_mock.function_tool.call_args_list]
    assert "relay_send" in called_args

@pytest.mark.asyncio
async def test_instructions_wrapping_string(mock_relay, mock_agent):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message
    
    mock_relay.inbox.return_value = [
        Message(sender="Other", text="Hello", message_id="1")
    ]
    
    adapter.on_relay(mock_agent, mock_relay)
    
    assert callable(mock_agent.instructions)
    
    result = await mock_agent.instructions()
    assert "Be helpful." in result
    assert "Relay message from Other" in result

@pytest.mark.asyncio
async def test_instructions_wrapping_callable(mock_relay, mock_agent):
    adapter = _adapter_module()
    
    original_instructions = MagicMock(return_value="Original context.")
    mock_agent.instructions = original_instructions
    
    adapter.on_relay(mock_agent, mock_relay)
    
    result = await mock_agent.instructions()
    assert "Original context." in result
    assert original_instructions.called
