"""E2E test: Swarms Python adapter against live Relaycast."""

from __future__ import annotations

import asyncio
import time
import uuid
from unittest.mock import MagicMock

import pytest

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import Message, RelayConfig, RelayConnectionError


def _live_config() -> RelayConfig:
    return RelayConfig.resolve(channels=[], auto_cleanup=False)


def _unique_name(prefix: str = "e2e-swarms-py") -> str:
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"


def _make_mock_agent(name: str):
    agent = MagicMock()
    agent.name = name
    agent.tools = []
    agent.receive_message = MagicMock()
    type(agent).__module__ = "swarms"
    return agent


async def _retry_on_429(coro_fn, max_retries=5, base_delay=15.0):
    """Call an async function, retrying on 429 rate limit errors."""
    for attempt in range(max_retries):
        try:
            return await coro_fn()
        except RelayConnectionError as e:
            if e.status_code == 429 and attempt < max_retries - 1:
                delay = base_delay * (attempt + 1)
                await asyncio.sleep(delay)
                continue
            raise


async def _make_connected_relay(name: str, config: RelayConfig) -> Relay:
    """Create a Relay and connect with 429 retry."""
    relay = Relay(name, config)
    await _retry_on_429(relay.agents)
    return relay


class TestSwarmsToolInjection:
    """Verify on_relay() injects tools (no API calls needed)."""

    def test_on_relay_injects_four_tools(self):
        from agent_relay.communicate.adapters.swarms import on_relay

        mock_agent = _make_mock_agent("local-agent")
        mock_relay = MagicMock()
        mock_relay.on_message = MagicMock(return_value=lambda: None)

        wrapped = on_relay(mock_agent, mock_relay)
        assert wrapped is mock_agent
        tool_names = [t.__name__ for t in mock_agent.tools]
        assert set(tool_names) == {"relay_send", "relay_inbox", "relay_post", "relay_agents"}

    def test_on_relay_registers_callback(self):
        from agent_relay.communicate.adapters.swarms import on_relay

        mock_agent = _make_mock_agent("cb-agent")
        mock_relay = MagicMock()
        mock_relay.on_message = MagicMock(return_value=lambda: None)

        on_relay(mock_agent, mock_relay)
        assert mock_relay.on_message.called

        callback = mock_relay.on_message.call_args[0][0]
        msg = Message(sender="test-lead", text="status check")
        callback(msg)
        mock_agent.receive_message.assert_called_once_with("test-lead", "status check")


class TestSwarmsLiveAPI:
    """Live API tests — consolidated to minimize requests."""

    @pytest.mark.asyncio
    async def test_registration_and_agents_tool(self):
        """Agent registers and relay_agents tool returns its name."""
        from agent_relay.communicate.adapters.swarms import on_relay

        agent_name = _unique_name("swarms-reg")
        config = _live_config()
        relay = Relay(agent_name, config)
        mock_agent = _make_mock_agent(agent_name)

        try:
            on_relay(mock_agent, relay)
            agents = await _retry_on_429(relay.agents)
            assert agent_name in agents

            tools = {t.__name__: t for t in mock_agent.tools}
            result = await tools["relay_agents"]()
            assert isinstance(result, str)
            assert agent_name in result
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_post_tool_and_channel(self):
        """The relay_post tool posts to a channel without errors."""
        from agent_relay.communicate.adapters.swarms import on_relay

        agent_name = _unique_name("swarms-post")
        config = _live_config()
        relay = Relay(agent_name, config)
        mock_agent = _make_mock_agent(agent_name)

        try:
            on_relay(mock_agent, relay)
            await _retry_on_429(relay.agents)
            await _retry_on_429(lambda: relay.join("general"))

            tools = {t.__name__: t for t in mock_agent.tools}
            result = await tools["relay_post"]("general", f"swarms-e2e-{uuid.uuid4().hex[:8]}")
            assert result == "Message posted"
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_send_and_inbox_dm(self):
        """relay_send delivers a DM that relay_inbox retrieves."""
        from agent_relay.communicate.adapters.swarms import on_relay

        config = _live_config()
        sender_name = _unique_name("swarms-s")
        receiver_name = _unique_name("swarms-r")
        sender_relay = Relay(sender_name, config)
        receiver_relay = Relay(receiver_name, config)
        sender_agent = _make_mock_agent(sender_name)
        receiver_agent = _make_mock_agent(receiver_name)
        text = f"swarms-dm-{uuid.uuid4().hex[:8]}"

        try:
            on_relay(sender_agent, sender_relay)
            on_relay(receiver_agent, receiver_relay)

            await _retry_on_429(sender_relay.agents)
            await _retry_on_429(receiver_relay.agents)

            sender_tools = {t.__name__: t for t in sender_agent.tools}
            result = await sender_tools["relay_send"](receiver_name, text)
            assert result == "Message sent"

            deadline = asyncio.get_event_loop().time() + 20.0
            found = False
            while asyncio.get_event_loop().time() < deadline:
                try:
                    messages = await receiver_relay.inbox()
                except RelayConnectionError as e:
                    if e.status_code == 429:
                        await asyncio.sleep(15)
                        continue
                    raise
                for msg in messages:
                    if msg.sender == sender_name and msg.text == text:
                        found = True
                        break
                if found:
                    break
                await asyncio.sleep(2.0)

            assert found, f"DM from {sender_name} not received within timeout"
        finally:
            await asyncio.gather(sender_relay.close(), receiver_relay.close())

    @pytest.mark.asyncio
    async def test_callback_with_live_relay(self):
        """on_message callback routes messages to agent.receive_message with a live relay."""
        from agent_relay.communicate.adapters.swarms import on_relay

        agent_name = _unique_name("swarms-cb")
        config = _live_config()
        relay = Relay(agent_name, config)
        mock_agent = _make_mock_agent(agent_name)

        try:
            on_relay(mock_agent, relay)
            await _retry_on_429(relay.agents)

            assert len(relay._callbacks) >= 1
            callback = relay._callbacks[0]
            msg = Message(sender="test-lead", text="status check")
            callback(msg)

            mock_agent.receive_message.assert_called_once_with("test-lead", "status check")
        finally:
            await relay.close()

    @pytest.mark.asyncio
    async def test_cleanup_removes_agent(self):
        """After relay.close(), agent disappears from the agent list."""
        config = _live_config()
        agent_name = _unique_name("swarms-cl")
        relay = Relay(agent_name, config)
        probe = Relay(_unique_name("swarms-pr"), config)

        try:
            agents = await _retry_on_429(relay.agents)
            assert agent_name in agents

            await relay.close()

            # If close() silently failed to unregister (e.g. 429), retry manually
            if relay.transport.agent_id is not None:
                await asyncio.sleep(15)
                try:
                    await relay.transport.unregister_agent()
                except Exception:
                    pass

            deadline = asyncio.get_event_loop().time() + 35.0
            absent = False
            while asyncio.get_event_loop().time() < deadline:
                try:
                    current = await probe.agents()
                except RelayConnectionError as e:
                    if e.status_code == 429:
                        await asyncio.sleep(15)
                        continue
                    raise
                if agent_name not in current:
                    absent = True
                    break
                await asyncio.sleep(3.0)

            assert absent, f"Agent {agent_name} still present after close"
        finally:
            await probe.close()
