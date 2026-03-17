"""E2E test: Google ADK Python adapter against live Relaycast.

Single consolidated test to stay within the 60 req/min rate limit.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from types import ModuleType
from unittest.mock import MagicMock

import pytest

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import RelayConfig


def _install_google_modules(monkeypatch):
    """Inject fake google.adk / google.genai modules so the adapter can import."""
    google_module = ModuleType("google")
    google_adk_module = ModuleType("google.adk")
    google_adk_agents_module = ModuleType("google.adk.agents")
    google_genai_module = ModuleType("google.genai")
    google_genai_types_module = ModuleType("google.genai.types")

    class Part:
        def __init__(self, text: str):
            self.text = text

    class Content:
        def __init__(self, role: str, parts: list):
            self.role = role
            self.parts = parts

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

    return google_genai_types_module


def _live_config() -> RelayConfig:
    return RelayConfig.resolve(
        workspace=os.environ.get("RELAY_WORKSPACE"),
        api_key=os.environ.get("RELAY_API_KEY"),
        base_url=os.environ.get("RELAY_BASE_URL"),
        channels=[],
        auto_cleanup=False,
    )


def _unique_name(prefix: str = "e2e-adk-py") -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"


def _make_mock_agent(name: str):
    agent = MagicMock()
    agent.name = name
    agent.tools = []
    agent.before_model_callback = None
    type(agent).__module__ = "google.adk.agents"
    return agent


def _tool_by_name(agent, name: str):
    return next(t for t in agent.tools if t.__name__ == name)


@pytest.mark.asyncio
async def test_google_adk_e2e_full_round_trip(monkeypatch):
    """Full round-trip: real Relay, mock ADK Agent, live Relaycast API.

    Exercises on_relay tool injection, list_agents, post, send/inbox,
    before_model_callback, and cleanup -- all in one test to stay
    within rate limits.
    """
    types_mod = _install_google_modules(monkeypatch)
    from agent_relay.communicate.adapters.google_adk import on_relay

    sender_name = _unique_name("adk-sender")
    receiver_name = _unique_name("adk-recv")
    config = _live_config()

    sender_relay = Relay(sender_name, config)
    receiver_relay = Relay(receiver_name, config)
    sender_agent = _make_mock_agent(sender_name)
    receiver_agent = _make_mock_agent(receiver_name)

    try:
        # -- Step 1: on_relay injects 4 tools + before_model_callback --
        wrapped_s = on_relay(sender_agent, sender_relay)
        wrapped_r = on_relay(receiver_agent, receiver_relay)

        assert wrapped_s is sender_agent
        assert wrapped_r is receiver_agent

        expected_tools = {"relay_send", "relay_inbox", "relay_post", "relay_agents"}
        assert set(t.__name__ for t in sender_agent.tools) == expected_tools
        assert set(t.__name__ for t in receiver_agent.tools) == expected_tools
        assert receiver_agent.before_model_callback is not None

        # -- Step 2: list_agents via tool closure (live API) --
        # Ensure both agents are registered before any cross-agent calls
        agents_result = await _tool_by_name(sender_agent, "relay_agents")()
        assert isinstance(agents_result, str)
        assert sender_name in agents_result

        receiver_agents = await _tool_by_name(receiver_agent, "relay_agents")()
        assert receiver_name in receiver_agents

        # -- Step 3: post to general channel via tool closure --
        await sender_relay.join("general")
        post_result = await _tool_by_name(sender_agent, "relay_post")(
            "general", f"adk-e2e-{uuid.uuid4().hex[:8]}"
        )
        assert post_result == "Message posted"

        # -- Step 4: send DM and verify inbox round-trip --
        dm_text = f"adk-dm-{uuid.uuid4().hex[:8]}"
        send_fn = _tool_by_name(sender_agent, "relay_send")
        result = await send_fn(receiver_name, dm_text)
        assert result == "Message sent"

        inbox_fn = _tool_by_name(receiver_agent, "relay_inbox")
        deadline = asyncio.get_event_loop().time() + 15.0
        found = False
        while asyncio.get_event_loop().time() < deadline:
            inbox_result = await inbox_fn()
            if dm_text in inbox_result:
                found = True
                break
            await asyncio.sleep(0.5)
        assert found, f"DM containing '{dm_text}' not received within timeout"

        # -- Step 5: before_model_callback injects relay messages --
        cb_text = f"adk-cb-{uuid.uuid4().hex[:8]}"
        await sender_relay.send(receiver_name, cb_text)

        deadline = asyncio.get_event_loop().time() + 15.0
        while asyncio.get_event_loop().time() < deadline:
            msgs = await receiver_relay.peek()
            if any(cb_text in m.text for m in msgs):
                break
            await asyncio.sleep(0.5)

        llm_request = MagicMock()
        llm_request.contents = []
        cb_result = await receiver_agent.before_model_callback(llm_request)
        assert cb_result is None

        injected = [p.text for c in llm_request.contents for p in c.parts]
        assert any(cb_text in t for t in injected), (
            f"Expected '{cb_text}' in callback-injected contents, got: {injected}"
        )

        # -- Step 6: cleanup -- close sender, verify internal state reset --
        await sender_relay.close()
        assert not sender_relay._connected
        assert not sender_relay._ws_connected

    finally:
        try:
            await sender_relay.close()
        except Exception:
            pass
        try:
            await receiver_relay.close()
        except Exception:
            pass
