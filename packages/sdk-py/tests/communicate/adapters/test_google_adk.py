"""Tests for the Google ADK Python adapter."""

from __future__ import annotations

from types import ModuleType
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

def _adapter_module():
    import importlib
    if "agent_relay.communicate.adapters.google_adk" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.google_adk"])
    return importlib.import_module("agent_relay.communicate.adapters.google_adk")


def _install_google_modules(monkeypatch):
    google_module = ModuleType("google")
    google_adk_module = ModuleType("google.adk")
    google_adk_agents_module = ModuleType("google.adk.agents")
    google_genai_module = ModuleType("google.genai")
    google_genai_types_module = ModuleType("google.genai.types")

    class Part:
        def __init__(self, text: str):
            self.text = text

        def __repr__(self) -> str:
            return f"Part(text={self.text!r})"

    class Content:
        def __init__(self, role: str, parts: list[Part]):
            self.role = role
            self.parts = parts

        def __repr__(self) -> str:
            return f"Content(role={self.role!r}, parts={self.parts!r})"

    google_module.adk = google_adk_module
    google_module.genai = google_genai_module
    google_adk_module.agents = google_adk_agents_module
    google_genai_module.types = google_genai_types_module
    google_genai_types_module.Content = Content
    google_genai_types_module.Part = Part

    monkeypatch.setitem(sys.modules, "google", google_module)
    monkeypatch.setitem(sys.modules, "google.adk", google_adk_module)
    monkeypatch.setitem(sys.modules, "google.adk.agents", google_adk_agents_module)
    monkeypatch.setitem(sys.modules, "google.genai", google_genai_module)
    monkeypatch.setitem(sys.modules, "google.genai.types", google_genai_types_module)

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

def test_on_relay_adds_tools(monkeypatch, mock_relay, mock_agent):
    _install_google_modules(monkeypatch)
    adapter = _adapter_module()

    adapter.on_relay(mock_agent, mock_relay)

    tool_names = [t.__name__ for t in mock_agent.tools]
    assert "relay_send" in tool_names
    assert "relay_inbox" in tool_names
    assert "relay_post" in tool_names
    assert "relay_agents" in tool_names

@pytest.mark.asyncio
async def test_before_model_callback_drains_inbox(monkeypatch, mock_relay, mock_agent):
    _install_google_modules(monkeypatch)
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
    assert len(llm_request.contents) == 1
    content = llm_request.contents[0]
    assert content.role == "user"
    assert content.parts[0].text == "[Relay] Other: Hello"

@pytest.mark.asyncio
async def test_before_model_callback_chains_existing(monkeypatch, mock_relay, mock_agent):
    _install_google_modules(monkeypatch)
    adapter = _adapter_module()

    original_callback = AsyncMock()
    mock_agent.before_model_callback = original_callback

    adapter.on_relay(mock_agent, mock_relay)

    llm_request = MagicMock()
    llm_request.contents = []

    await mock_agent.before_model_callback(llm_request)

    assert original_callback.called
