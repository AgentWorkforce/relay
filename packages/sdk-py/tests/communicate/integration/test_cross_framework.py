"""Wave 4.1 cross-framework integration tests for communicate mode."""

from __future__ import annotations

import asyncio
import importlib
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agent_relay.communicate.core import Relay


def _reload_module(module_name: str):
    if module_name in sys.modules:
        return importlib.reload(sys.modules[module_name])
    return importlib.import_module(module_name)


def _load_openai_adapter(monkeypatch):
    agents_module = ModuleType("agents")
    agents_module.Agent = type("Agent", (), {})
    agents_module.function_tool = lambda fn: fn
    monkeypatch.setitem(sys.modules, "agents", agents_module)
    return _reload_module("agent_relay.communicate.adapters.openai_agents")


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


def _load_google_adapter(monkeypatch):
    _install_google_modules(monkeypatch)
    return _reload_module("agent_relay.communicate.adapters.google_adk")


def _load_swarms_adapter():
    return _reload_module("agent_relay.communicate.adapters.swarms")


def _load_claude_adapter(monkeypatch):
    claude_agent_sdk = ModuleType("claude_agent_sdk")
    claude_types = ModuleType("claude_agent_sdk.types")

    class HookResult:
        def __init__(self, system_message=None, should_continue=False):
            self.system_message = system_message
            self.should_continue = should_continue

    claude_types.HookResult = HookResult
    claude_agent_sdk.types = claude_types

    monkeypatch.setitem(sys.modules, "claude_agent_sdk", claude_agent_sdk)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk.types", claude_types)
    return _reload_module("agent_relay.communicate.adapters.claude_sdk")


def _tool(agent, name: str):
    for candidate in agent.tools:
        tool_name = getattr(candidate, "__name__", None) or getattr(candidate, "name", None)
        if tool_name == name:
            return candidate
    raise AssertionError(f"Tool {name!r} was not registered.")


async def _wait_for_google_message(callback, text: str, *, timeout: float = 1.0) -> list[object]:
    deadline = asyncio.get_running_loop().time() + timeout
    last_contents: list[object] = []

    while asyncio.get_running_loop().time() < deadline:
        request = SimpleNamespace(contents=[])
        await callback(request)
        last_contents = list(request.contents)
        if any(text in str(part) for part in request.contents):
            return request.contents
        await asyncio.sleep(0.01)

    raise AssertionError(
        f"Timed out waiting for Google ADK callback delivery of {text!r}. Last contents: {last_contents!r}"
    )


async def _wait_for_claude_system_message(hook, expected: list[str], *, timeout: float = 1.0) -> str:
    deadline = asyncio.get_running_loop().time() + timeout
    last_system_message = None

    while asyncio.get_running_loop().time() < deadline:
        result = await hook()
        last_system_message = getattr(result, "system_message", None)
        if last_system_message and all(fragment in last_system_message for fragment in expected):
            return last_system_message
        await asyncio.sleep(0.01)

    raise AssertionError(
        "Timed out waiting for Claude SDK hook delivery. "
        f"Expected fragments: {expected!r}. Last system_message: {last_system_message!r}"
    )


async def _wait_for_inbox_tool(tool, expected: list[str], *, timeout: float = 1.0) -> str:
    deadline = asyncio.get_running_loop().time() + timeout
    last_result = ""

    while asyncio.get_running_loop().time() < deadline:
        last_result = await tool()
        if all(fragment in last_result for fragment in expected):
            return last_result
        await asyncio.sleep(0.01)

    raise AssertionError(
        f"Timed out waiting for inbox delivery. Expected fragments: {expected!r}. Last result: {last_result!r}"
    )


async def _prime_google_receiver(relay_server, relay: Relay, callback) -> None:
    await callback(SimpleNamespace(contents=[]))
    assert relay.transport.agent_id is not None
    await relay_server.wait_for_ws_connections(relay.transport.agent_id, count=1)


async def _prime_claude_receiver(relay_server, relay: Relay, hook) -> None:
    await hook()
    assert relay.transport.agent_id is not None
    await relay_server.wait_for_ws_connections(relay.transport.agent_id, count=1)


async def _prime_inbox_receiver(relay_server, relay: Relay, inbox_tool) -> None:
    await inbox_tool()
    assert relay.transport.agent_id is not None
    await relay_server.wait_for_ws_connections(relay.transport.agent_id, count=1)


async def _close_relays(*relays: Relay) -> None:
    await asyncio.gather(*(relay.close() for relay in relays), return_exceptions=True)


@pytest.mark.asyncio
async def test_openai_sender_reaches_google_adk_before_model_callback(relay_server, monkeypatch):
    openai_adapter = _load_openai_adapter(monkeypatch)
    google_adapter = _load_google_adapter(monkeypatch)

    sender_relay = Relay("OpenAISender", relay_server.make_config(auto_cleanup=False))
    receiver_relay = Relay("GoogleReceiver", relay_server.make_config(auto_cleanup=False))

    sender_agent = SimpleNamespace(tools=[], instructions="Send relay updates.")
    receiver_agent = SimpleNamespace(tools=[], before_model_callback=None)

    openai_adapter.on_relay(sender_agent, sender_relay)
    google_adapter.on_relay(receiver_agent, receiver_relay)

    try:
        await _prime_google_receiver(
            relay_server,
            receiver_relay,
            receiver_agent.before_model_callback,
        )

        await _tool(sender_agent, "relay_send")("GoogleReceiver", "handoff complete")
        contents = await _wait_for_google_message(
            receiver_agent.before_model_callback,
            "handoff complete",
        )
    finally:
        await _close_relays(sender_relay, receiver_relay)

    assert any("[Relay] OpenAISender: handoff complete" in str(part) for part in contents)
    assert any("handoff complete" in str(part) for part in contents)


@pytest.mark.asyncio
async def test_swarms_sender_reaches_claude_sdk_hook_system_message(relay_server, monkeypatch):
    swarms_adapter = _load_swarms_adapter()
    claude_adapter = _load_claude_adapter(monkeypatch)

    sender_relay = Relay("SwarmsSender", relay_server.make_config(auto_cleanup=False))
    receiver_relay = Relay("ClaudeReceiver", relay_server.make_config(auto_cleanup=False))

    sender_agent = SimpleNamespace(tools=[], receive_message=MagicMock())

    class Hooks:
        post_tool_use = None
        stop = None

    receiver_options = SimpleNamespace(mcp_servers=[], hooks=Hooks())

    swarms_adapter.on_relay(sender_agent, sender_relay)
    claude_adapter.on_relay(receiver_options, relay=receiver_relay, name="ClaudeReceiver")

    try:
        await _prime_claude_receiver(
            relay_server,
            receiver_relay,
            receiver_options.hooks.post_tool_use,
        )

        await _tool(sender_agent, "relay_send")("ClaudeReceiver", "ready for review")
        system_message = await _wait_for_claude_system_message(
            receiver_options.hooks.post_tool_use,
            ["Relay message from SwarmsSender", "ready for review"],
        )
    finally:
        await _close_relays(sender_relay, receiver_relay)

    assert "Relay message from SwarmsSender" in system_message
    assert "ready for review" in system_message


@pytest.mark.asyncio
async def test_multiple_framework_agents_post_to_the_same_channel(relay_server, monkeypatch):
    openai_adapter = _load_openai_adapter(monkeypatch)
    google_adapter = _load_google_adapter(monkeypatch)
    swarms_adapter = _load_swarms_adapter()
    claude_adapter = _load_claude_adapter(monkeypatch)

    config = relay_server.make_config(auto_cleanup=False, channels=["integration-room"])

    openai_relay = Relay("OpenAIPoster", config)
    google_relay = Relay("GooglePoster", config)
    swarms_relay = Relay("SwarmsPoster", config)
    receiver_relay = Relay("ClaudeChannelReader", config)

    openai_agent = SimpleNamespace(tools=[], instructions="Post relay updates.")
    google_agent = SimpleNamespace(tools=[], before_model_callback=None)
    swarms_agent = SimpleNamespace(tools=[], receive_message=MagicMock())

    class Hooks:
        post_tool_use = None
        stop = None

    receiver_options = SimpleNamespace(mcp_servers=[], hooks=Hooks())

    openai_adapter.on_relay(openai_agent, openai_relay)
    google_adapter.on_relay(google_agent, google_relay)
    swarms_adapter.on_relay(swarms_agent, swarms_relay)
    claude_adapter.on_relay(receiver_options, relay=receiver_relay, name="ClaudeChannelReader")

    try:
        await _prime_claude_receiver(
            relay_server,
            receiver_relay,
            receiver_options.hooks.post_tool_use,
        )

        await _tool(openai_agent, "relay_post")("integration-room", "openai update")
        await _tool(google_agent, "relay_post")("integration-room", "google update")
        await _tool(swarms_agent, "relay_post")("integration-room", "swarms update")

        system_message = await _wait_for_claude_system_message(
            receiver_options.hooks.post_tool_use,
            [
                "Relay message from OpenAIPoster",
                "openai update",
                "Relay message from GooglePoster",
                "google update",
                "Relay message from SwarmsPoster",
                "swarms update",
            ],
        )
    finally:
        await _close_relays(openai_relay, google_relay, swarms_relay, receiver_relay)

    assert "Relay message from OpenAIPoster" in system_message
    assert "Relay message from GooglePoster" in system_message
    assert "Relay message from SwarmsPoster" in system_message


@pytest.mark.asyncio
async def test_cross_framework_dm_is_available_via_receiver_inbox_tool(relay_server, monkeypatch):
    google_adapter = _load_google_adapter(monkeypatch)
    openai_adapter = _load_openai_adapter(monkeypatch)

    sender_relay = Relay("GoogleSender", relay_server.make_config(auto_cleanup=False))
    receiver_relay = Relay("OpenAIReceiver", relay_server.make_config(auto_cleanup=False))

    sender_agent = SimpleNamespace(tools=[], before_model_callback=None)
    receiver_agent = SimpleNamespace(tools=[], instructions="Read relay inbox.")

    google_adapter.on_relay(sender_agent, sender_relay)
    openai_adapter.on_relay(receiver_agent, receiver_relay)

    try:
        await _prime_inbox_receiver(
            relay_server,
            receiver_relay,
            _tool(receiver_agent, "relay_inbox"),
        )

        await _tool(sender_agent, "relay_send")("OpenAIReceiver", "dm via inbox")
        inbox_result = await _wait_for_inbox_tool(
            _tool(receiver_agent, "relay_inbox"),
            ["GoogleSender", "dm via inbox"],
        )
    finally:
        await _close_relays(sender_relay, receiver_relay)

    assert "GoogleSender" in inbox_result
    assert "dm via inbox" in inbox_result
