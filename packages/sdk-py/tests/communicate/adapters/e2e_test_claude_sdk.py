"""E2E test: Claude Agent SDK Python adapter against live Relaycast."""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import Message, RelayConfig


def _live_config() -> RelayConfig:
    return RelayConfig.resolve(
        workspace=os.environ.get("RELAY_WORKSPACE"),
        api_key=os.environ.get("RELAY_API_KEY"),
        base_url=os.environ.get("RELAY_BASE_URL"),
        channels=[],
        auto_cleanup=False,
    )


def _unique_name(prefix: str = "e2e-claude-py") -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"


def _install_claude_sdk_module(monkeypatch):
    """Inject a fake 'claude_agent_sdk' module so the adapter can import HookResult."""
    types_mod = ModuleType("claude_agent_sdk.types")
    types_mod.HookResult = type(
        "HookResult",
        (),
        {
            "__init__": lambda self, system_message=None, should_continue=False: (
                setattr(self, "system_message", system_message)
                or setattr(self, "should_continue", should_continue)
            ),
        },
    )
    sdk_mod = ModuleType("claude_agent_sdk")
    sdk_mod.types = types_mod
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk_mod)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk.types", types_mod)
    return types_mod


def _make_mock_options(name: str = "TestAgent") -> SimpleNamespace:
    """Create a mock Claude SDK options object."""
    return SimpleNamespace(name=name, hooks=None, mcp_servers=[])


class TestClaudeSdkAdapterE2E:
    """E2E tests for the Claude SDK adapter with a real Relay connection."""

    @pytest.mark.asyncio
    async def test_on_relay_injects_mcp_and_hooks(self, monkeypatch):
        """on_relay() injects the relaycast MCP config and wraps hooks."""
        types_mod = _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        agent_name = _unique_name()
        relay = Relay(agent_name, config)
        options = _make_mock_options(agent_name)

        try:
            result = on_relay(options, relay, name=agent_name)

            assert result is options
            mcp_names = [s["name"] for s in options.mcp_servers]
            assert "relaycast" in mcp_names
            assert callable(options.hooks.post_tool_use)
            assert callable(options.hooks.stop)
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_on_relay_preserves_existing_mcp_servers(self, monkeypatch):
        """on_relay() appends relaycast MCP without clobbering existing servers."""
        _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        agent_name = _unique_name()
        relay = Relay(agent_name, config)
        existing_mcp = {"name": "custom-tool", "command": "custom", "args": []}
        options = SimpleNamespace(
            name=agent_name,
            hooks=None,
            mcp_servers=[existing_mcp],
        )

        try:
            on_relay(options, relay, name=agent_name)

            assert len(options.mcp_servers) == 2
            names = [s["name"] for s in options.mcp_servers]
            assert "custom-tool" in names
            assert "relaycast" in names
        finally:
            await relay.close()


class TestRelayRegistrationE2E:
    """Verify Relay registration against live Relaycast via Claude adapter path."""

    @pytest.mark.asyncio
    async def test_relay_registers_agent(self):
        """Relay.agents() includes the registered agent after on_relay wrapping."""
        config = _live_config()
        agent_name = _unique_name()
        relay = Relay(agent_name, config)

        try:
            agents = await relay.agents()
            assert isinstance(agents, list)
            assert agent_name in agents
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_two_agents_register_simultaneously(self):
        """Two agents with unique names can coexist."""
        config = _live_config()
        name_a = _unique_name("e2e-claude-a")
        name_b = _unique_name("e2e-claude-b")
        relay_a = Relay(name_a, config)
        relay_b = Relay(name_b, config)

        try:
            agents_a = await relay_a.agents()
            agents_b = await relay_b.agents()
            assert name_a in agents_a
            assert name_b in agents_b
        finally:
            await asyncio.gather(relay_a.close(), relay_b.close())


class TestRelayToolFunctionsE2E:
    """Test relay operations (send, inbox, agents, post) against the real API."""

    @pytest.mark.asyncio
    async def test_send_and_inbox(self):
        """relay.send() delivers a DM that relay.inbox() can retrieve."""
        config = _live_config()
        sender_name = _unique_name("e2e-claude-sender")
        receiver_name = _unique_name("e2e-claude-recv")
        sender = Relay(sender_name, config)
        receiver = Relay(receiver_name, config)
        text = f"claude-e2e-{uuid.uuid4().hex[:8]}"

        try:
            await sender.agents()
            await receiver.agents()

            await sender.send(receiver_name, text)

            deadline = asyncio.get_event_loop().time() + 15.0
            found = False
            while asyncio.get_event_loop().time() < deadline:
                messages = await receiver.inbox()
                for msg in messages:
                    if msg.sender == sender_name and msg.text == text:
                        found = True
                        break
                if found:
                    break
                await asyncio.sleep(0.5)

            assert found, f"DM from {sender_name} not received within timeout"
        finally:
            await asyncio.gather(sender.close(), receiver.close())

    @pytest.mark.asyncio
    async def test_post_to_channel(self):
        """relay.post() succeeds when posting to a channel."""
        config = _live_config()
        agent_name = _unique_name("e2e-claude-post")
        relay = Relay(agent_name, config)

        try:
            await relay.agents()
            await relay.join("general")
            await relay.post("general", f"claude-e2e-test-{uuid.uuid4().hex[:8]}")
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_agents_list(self):
        """relay.agents() returns a list containing the registered agent."""
        config = _live_config()
        agent_name = _unique_name("e2e-claude-list")
        relay = Relay(agent_name, config)

        try:
            agents = await relay.agents()
            assert isinstance(agents, list)
            assert agent_name in agents
        finally:
            await relay.close()


class TestHooksE2E:
    """Test Claude SDK hook wrappers with a real Relay connection."""

    @pytest.mark.asyncio
    async def test_post_tool_use_hook_returns_none_when_no_messages(self, monkeypatch):
        """post_tool_use hook returns None when inbox is empty."""
        _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        agent_name = _unique_name("e2e-claude-hook")
        relay = Relay(agent_name, config)
        options = _make_mock_options(agent_name)

        try:
            on_relay(options, relay, name=agent_name)
            await relay.agents()

            # Drain any pre-existing messages
            await relay.inbox()

            result = await options.hooks.post_tool_use()
            assert result is None
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_stop_hook_returns_none_when_no_messages(self, monkeypatch):
        """stop hook returns None when inbox is empty."""
        _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        agent_name = _unique_name("e2e-claude-stop")
        relay = Relay(agent_name, config)
        options = _make_mock_options(agent_name)

        try:
            on_relay(options, relay, name=agent_name)
            await relay.agents()
            await relay.inbox()

            result = await options.hooks.stop()
            assert result is None
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_stop_hook_returns_messages_with_should_continue(self, monkeypatch):
        """stop hook returns HookResult with should_continue=True when inbox has messages."""
        types_mod = _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        sender_name = _unique_name("e2e-claude-hook-s")
        receiver_name = _unique_name("e2e-claude-hook-r")
        sender = Relay(sender_name, config)
        receiver = Relay(receiver_name, config)
        options = _make_mock_options(receiver_name)
        text = f"hook-test-{uuid.uuid4().hex[:8]}"

        try:
            on_relay(options, receiver, name=receiver_name)
            await sender.agents()
            await receiver.agents()
            # Drain any stale messages
            await receiver.inbox()

            await sender.send(receiver_name, text)

            # Wait for message to arrive
            deadline = asyncio.get_event_loop().time() + 15.0
            found = False
            while asyncio.get_event_loop().time() < deadline:
                msgs = await receiver.peek()
                for m in msgs:
                    if m.sender == sender_name and m.text == text:
                        found = True
                        break
                if found:
                    break
                await asyncio.sleep(0.5)

            assert found, f"DM from {sender_name} not received within timeout"

            result = await options.hooks.stop()
            assert result is not None
            assert result.should_continue is True
            assert sender_name in result.system_message
            assert text in result.system_message
        finally:
            await asyncio.gather(sender.close(), receiver.close())

    @pytest.mark.asyncio
    async def test_post_tool_use_hook_drains_inbox(self, monkeypatch):
        """post_tool_use hook returns HookResult with system_message containing DM text."""
        types_mod = _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        sender_name = _unique_name("e2e-claude-ptu-s")
        receiver_name = _unique_name("e2e-claude-ptu-r")
        sender = Relay(sender_name, config)
        receiver = Relay(receiver_name, config)
        options = _make_mock_options(receiver_name)
        text = f"ptu-test-{uuid.uuid4().hex[:8]}"

        try:
            on_relay(options, receiver, name=receiver_name)
            await sender.agents()
            await receiver.agents()
            await receiver.inbox()

            await sender.send(receiver_name, text)

            deadline = asyncio.get_event_loop().time() + 15.0
            found = False
            while asyncio.get_event_loop().time() < deadline:
                msgs = await receiver.peek()
                for m in msgs:
                    if m.sender == sender_name and m.text == text:
                        found = True
                        break
                if found:
                    break
                await asyncio.sleep(0.5)

            assert found, f"DM from {sender_name} not received within timeout"

            result = await options.hooks.post_tool_use()
            assert result is not None
            assert sender_name in result.system_message
            assert text in result.system_message
        finally:
            await asyncio.gather(sender.close(), receiver.close())

    @pytest.mark.asyncio
    async def test_hooks_chain_with_original_hooks(self, monkeypatch):
        """on_relay preserves and chains original hooks."""
        _install_claude_sdk_module(monkeypatch)

        from agent_relay.communicate.adapters.claude_sdk import on_relay

        config = _live_config()
        agent_name = _unique_name("e2e-claude-chain")
        relay = Relay(agent_name, config)

        orig_called = {"post": False, "stop": False}

        async def orig_post_tool(*a, **kw):
            orig_called["post"] = True
            return None

        async def orig_stop(*a, **kw):
            orig_called["stop"] = True
            return None

        options = SimpleNamespace(
            name=agent_name,
            hooks=SimpleNamespace(post_tool_use=orig_post_tool, stop=orig_stop),
            mcp_servers=[],
        )

        try:
            on_relay(options, relay, name=agent_name)
            await relay.agents()
            await relay.inbox()

            await options.hooks.post_tool_use()
            await options.hooks.stop()

            assert orig_called["post"], "Original post_tool_use was not called"
            assert orig_called["stop"], "Original stop was not called"
        finally:
            await relay.close()


class TestCleanupE2E:
    """Verify cleanup against live API."""

    @pytest.mark.xfail(reason="Agent removal propagation depends on server-side TTL", strict=False)
    @pytest.mark.asyncio
    async def test_relay_close_disconnects(self):
        """After relay.close(), the agent eventually disappears from the agent list."""
        config = _live_config()
        agent_name = _unique_name("e2e-claude-cleanup")
        relay = Relay(agent_name, config)
        probe = Relay(_unique_name("e2e-claude-probe"), config)

        try:
            agents = await relay.agents()
            assert agent_name in agents

            await relay.close()

            # Allow rate-limit budget to recover before polling
            await asyncio.sleep(5)

            deadline = asyncio.get_event_loop().time() + 25.0
            absent = False
            while asyncio.get_event_loop().time() < deadline:
                try:
                    current = await probe.agents()
                except Exception:
                    await asyncio.sleep(2.0)
                    continue
                if agent_name not in current:
                    absent = True
                    break
                await asyncio.sleep(2.0)

            assert absent, f"Agent {agent_name} still present after close"
        finally:
            await probe.close()
