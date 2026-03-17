"""Tests for the Claude Agent SDK Python adapter."""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Mock claude_agent_sdk module before it's imported in the adapter
claude_mock = MagicMock()
sys.modules["claude_agent_sdk"] = claude_mock
sys.modules["claude_agent_sdk.types"] = claude_mock.types

class MockHookResult:
    def __init__(self, system_message=None, should_continue=False):
        self.system_message = system_message
        self.should_continue = should_continue

claude_mock.types.HookResult = MockHookResult

def _adapter_module():
    import importlib
    # Ensure module is reloaded to pick up mocks if needed
    if "agent_relay.communicate.adapters.claude_sdk" in sys.modules:
        importlib.reload(sys.modules["agent_relay.communicate.adapters.claude_sdk"])
    return importlib.import_module("agent_relay.communicate.adapters.claude_sdk")

@pytest.fixture
def mock_relay():
    relay = MagicMock()
    relay.agent_name = "TestAgent"
    relay.inbox = AsyncMock(return_value=[])
    return relay

@pytest.fixture
def mock_options():
    # Mocking ClaudeAgentOptions structure
    class MockOptions:
        def __init__(self):
            self.mcp_servers = []
            self.hooks = MagicMock(spec=["post_tool_use", "stop"])
            self.hooks.post_tool_use = None
            self.hooks.stop = None
    return MockOptions()

def test_on_relay_injects_mcp_server(mock_relay, mock_options):
    adapter = _adapter_module()

    result = adapter.on_relay("TestAgent", mock_options, relay=mock_relay)

    assert result is mock_options
    assert len(mock_options.mcp_servers) == 1
    server = mock_options.mcp_servers[0]
    assert server["name"] == "relaycast"
    # It should probably have some command/args for the relaycast MCP server
    assert "command" in server

@pytest.mark.asyncio
async def test_post_tool_use_hook_drains_inbox(mock_relay, mock_options):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    mock_relay.inbox.return_value = [
        Message(sender="Other", text="Hello", message_id="1")
    ]

    adapter.on_relay("TestAgent", mock_options, relay=mock_relay)
    post_tool_use = mock_options.hooks.post_tool_use

    assert post_tool_use is not None

    # Call the hook
    hook_result = await post_tool_use()

    assert mock_relay.inbox.called
    assert hook_result is not None
    assert "Relay message from Other" in hook_result.system_message
    assert "Hello" in hook_result.system_message

@pytest.mark.asyncio
async def test_post_tool_use_hook_returns_none_if_inbox_empty(mock_relay, mock_options):
    adapter = _adapter_module()
    mock_relay.inbox.return_value = []

    adapter.on_relay("TestAgent", mock_options, relay=mock_relay)
    hook_result = await mock_options.hooks.post_tool_use()

    assert hook_result is None

@pytest.mark.asyncio
async def test_stop_hook_drains_inbox_and_continues(mock_relay, mock_options):
    adapter = _adapter_module()
    from agent_relay.communicate.types import Message

    mock_relay.inbox.return_value = [
        Message(sender="Other", text="Wait!", message_id="2")
    ]

    adapter.on_relay("TestAgent", mock_options, relay=mock_relay)
    stop_hook = mock_options.hooks.stop

    assert stop_hook is not None

    hook_result = await stop_hook()

    assert hook_result is not None
    assert "Relay message from Other" in hook_result.system_message
    assert hook_result.should_continue is True

@pytest.mark.asyncio
async def test_stop_hook_returns_none_if_inbox_empty(mock_relay, mock_options):
    adapter = _adapter_module()
    mock_relay.inbox.return_value = []

    adapter.on_relay("TestAgent", mock_options, relay=mock_relay)
    hook_result = await mock_options.hooks.stop()

    assert hook_result is None

@pytest.mark.asyncio
async def test_hooks_chaining(mock_relay, mock_options):
    adapter = _adapter_module()

    original_post_tool_use = AsyncMock(return_value=MagicMock(system_message="Original"))
    mock_options.hooks.post_tool_use = original_post_tool_use

    adapter.on_relay("TestAgent", mock_options, relay=mock_relay)

    # When inbox is empty, it should return original result
    mock_relay.inbox.return_value = []
    hook_result = await mock_options.hooks.post_tool_use()
    assert original_post_tool_use.called
    assert hook_result.system_message == "Original"

    # When inbox has messages, it should combine?
    # Or as per requirement: "returns systemMessage if non-empty, None if empty"
    # Wait, if it's chained, it should probably combine them.
    # The requirement says: "Chaining with existing hooks (existing PostToolUse/Stop preserved)"

    from agent_relay.communicate.types import Message
    mock_relay.inbox.return_value = [Message(sender="A", text="B")]

    hook_result = await mock_options.hooks.post_tool_use()
    assert "Original" in hook_result.system_message
    assert "Relay message from A" in hook_result.system_message
