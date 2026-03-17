"""Tests for the CrewAI Python adapter."""

from __future__ import annotations

from inspect import isawaitable
from types import ModuleType
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.crewai" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.crewai"])
    return importlib.import_module("agent_relay.communicate.adapters.crewai")


def _install_crewai_tools(monkeypatch):
    crewai_module = ModuleType("crewai")
    crewai_tools_module = ModuleType("crewai.tools")

    def mock_tool_decorator(func):
        tool = MagicMock()
        tool.__name__ = func.__name__
        tool.func = func
        return tool

    crewai_tools_module.tool = mock_tool_decorator
    crewai_module.tools = crewai_tools_module
    monkeypatch.setitem(sys.modules, "crewai", crewai_module)
    monkeypatch.setitem(sys.modules, "crewai.tools", crewai_tools_module)
    return crewai_tools_module

@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "TestAgent"
    relay.inbox = AsyncMock(return_value=[])
    relay.inbox_sync = MagicMock(return_value=[])
    relay.send = AsyncMock()
    relay.post = AsyncMock()
    relay.agents = AsyncMock(return_value=[])
    return relay

@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.tools = []
    agent.backstory = "Expert researcher."
    agent.goal = "Find answers."
    return agent

def test_on_relay_adds_tools(monkeypatch, mock_relay, mock_agent):
    _install_crewai_tools(monkeypatch)
    adapter = _adapter_module()

    adapter.on_relay(mock_agent, mock_relay)

    tools = {t.__name__: t for t in mock_agent.tools}
    assert "relay_send" in tools
    assert "relay_inbox" in tools

@pytest.mark.asyncio
async def test_tool_execution(monkeypatch, mock_relay, mock_agent):
    _install_crewai_tools(monkeypatch)
    adapter = _adapter_module()

    adapter.on_relay(mock_agent, mock_relay)
    tools = {t.__name__: t for t in mock_agent.tools}

    # Test relay_send
    mock_relay.send = AsyncMock()
    await tools["relay_send"].func("Alice", "Hi")
    mock_relay.send.assert_called_with("Alice", "Hi")

    # Test relay_inbox
    from agent_relay.communicate.types import Message
    mock_relay.inbox.return_value = [Message(sender="Bob", text="Hey")]
    inbox_res = await tools["relay_inbox"].func()
    assert "Bob: Hey" in inbox_res

    # Test relay_post
    mock_relay.post = AsyncMock()
    await tools["relay_post"].func("general", "Update")
    mock_relay.post.assert_called_with("general", "Update")

    # Test relay_agents
    mock_relay.agents.return_value = ["Alice", "Bob"]
    agents_res = await tools["relay_agents"].func()
    assert "Alice, Bob" in agents_res

@pytest.mark.asyncio
async def test_backstory_wrapping(monkeypatch, mock_relay, mock_agent):
    _install_crewai_tools(monkeypatch)
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    msg = Message(sender="Other", text="Crew message", message_id="1")
    mock_relay.inbox.return_value = [msg]
    mock_relay.inbox_sync.return_value = [msg]

    adapter.on_relay(mock_agent, mock_relay)

    backstory = mock_agent.backstory
    if isawaitable(backstory):
        backstory = await backstory
    elif callable(backstory):
        backstory = backstory()

    assert "Expert researcher." in backstory
    assert "Other: Crew message" in backstory

@pytest.mark.asyncio
async def test_backstory_wrapping_no_messages(monkeypatch, mock_relay, mock_agent):
    """When inbox is empty, backstory is just the original."""
    _install_crewai_tools(monkeypatch)
    adapter = _adapter_module()

    mock_relay.inbox_sync.return_value = []
    adapter.on_relay(mock_agent, mock_relay)

    backstory = mock_agent.backstory
    if isawaitable(backstory):
        backstory = await backstory
    elif callable(backstory):
        backstory = backstory()
    assert backstory == "Expert researcher."

def test_on_relay_returns_agent(monkeypatch, mock_relay, mock_agent):
    """on_relay() returns the modified agent."""
    _install_crewai_tools(monkeypatch)
    adapter = _adapter_module()

    result = adapter.on_relay(mock_agent, mock_relay)
    assert result is mock_agent
