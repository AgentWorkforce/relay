"""Tests for the Google ADK Python adapter."""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Mock google.adk.agents before it's imported in the adapter
google_mock = MagicMock()
sys.modules["google"] = MagicMock()
sys.modules["google.adk"] = MagicMock()
sys.modules["google.adk.agents"] = google_mock

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.google_adk" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.google_adk"])
    return importlib.import_module("agent_relay.communicate.adapters.google_adk")

@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "TestAgent"
    relay.inbox = AsyncMock(return_value=[])
    relay.send = AsyncMock()
    relay.post = AsyncMock()
    relay.agents = AsyncMock()
    return relay

@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.tools = []
    agent.before_model_callback = None
    return agent

def test_on_relay_adds_tools(mock_relay, mock_agent):
    adapter = _adapter_module()
    
    adapter.on_relay(mock_agent, mock_relay)
    
    tool_names = [t.__name__ for t in mock_agent.tools]
    assert "relay_send" in tool_names
    assert "relay_inbox" in tool_names
    assert "relay_post" in tool_names
    assert "relay_agents" in tool_names

@pytest.mark.asyncio
async def test_before_model_callback_drains_inbox(mock_relay, mock_agent):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message
    
    mock_relay.inbox.return_value = [
        Message(sender="Other", text="Hello", message_id="1")
    ]
    
    adapter.on_relay(mock_agent, mock_relay)
    callback = mock_agent.before_model_callback
    
    assert callback is not None
    
    # Mock LLM request object
    llm_request = MagicMock()
    llm_request.contents = []
    
    # Call the callback
    await callback(llm_request)
    
    assert mock_relay.inbox.called
    assert len(llm_request.contents) > 0
    content = llm_request.contents[0]
    # Check if content has the expected parts/text (ADK specific structure)
    # The spec says "Append messages to llm_request.contents as user Content parts"
    assert "Relay message from Other" in str(content)

@pytest.mark.asyncio
async def test_before_model_callback_chains_existing(mock_relay, mock_agent):
    adapter = _adapter_module()
    
    original_callback = AsyncMock()
    mock_agent.before_model_callback = original_callback
    
    adapter.on_relay(mock_agent, mock_relay)
    
    llm_request = MagicMock()
    llm_request.contents = []
    
    await mock_agent.before_model_callback(llm_request)
    
    assert original_callback.called
