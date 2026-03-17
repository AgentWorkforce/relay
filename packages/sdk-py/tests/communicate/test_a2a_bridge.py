"""Tests for A2ABridge — bidirectional message forwarding between A2A and Relay."""

from __future__ import annotations

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web

from agent_relay.communicate.a2a_bridge import A2ABridge
from agent_relay.communicate.a2a_server import A2AServer
from agent_relay.communicate.a2a_types import A2AMessage, A2APart, A2ASkill
from agent_relay.communicate.types import Message, RelayConfig


class MockA2AAgent:
    """A minimal mock A2A agent server for testing the bridge."""

    def __init__(self, name: str = "external-agent", response_text: str = "A2A response") -> None:
        self.name = name
        self.response_text = response_text
        self.received_messages: list[dict] = []

        self._app = web.Application()
        self._app.router.add_get("/.well-known/agent.json", self._handle_card)
        self._app.router.add_post("/", self._handle_jsonrpc)
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self.url = ""

    async def _handle_card(self, request: web.Request) -> web.Response:
        return web.json_response({
            "name": self.name,
            "description": f"Mock A2A agent: {self.name}",
            "url": self.url,
            "version": "1.0.0",
            "capabilities": {"streaming": False, "pushNotifications": False},
            "skills": [],
            "defaultInputModes": ["text"],
            "defaultOutputModes": ["text"],
        })

    async def _handle_jsonrpc(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.received_messages.append(body)

        method = body.get("method", "")
        rpc_id = body.get("id")

        if method == "message/send":
            task_id = str(uuid.uuid4())
            response_msg = {
                "role": "agent",
                "parts": [{"text": self.response_text}],
                "messageId": str(uuid.uuid4()),
            }
            result = {
                "id": task_id,
                "contextId": str(uuid.uuid4()),
                "status": {"state": "completed", "message": response_msg},
                "messages": [
                    body.get("params", {}).get("message", {}),
                    response_msg,
                ],
                "artifacts": [],
            }
            return web.json_response({"jsonrpc": "2.0", "result": result, "id": rpc_id})

        return web.json_response(
            {"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method not found"}, "id": rpc_id}
        )

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await self._site.start()
        server = getattr(self._site, "_server", None)
        if server and server.sockets:
            port = server.sockets[0].getsockname()[1]
            self.url = f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()


class MockA2AAgentEmpty:
    """A mock A2A agent that returns no response text."""

    def __init__(self) -> None:
        self._app = web.Application()
        self._app.router.add_post("/", self._handle_jsonrpc)
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self.url = ""

    async def _handle_jsonrpc(self, request: web.Request) -> web.Response:
        body = await request.json()
        rpc_id = body.get("id")
        result = {
            "id": str(uuid.uuid4()),
            "status": {"state": "completed"},
            "messages": [],
            "artifacts": [],
        }
        return web.json_response({"jsonrpc": "2.0", "result": result, "id": rpc_id})

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await self._site.start()
        server = getattr(self._site, "_server", None)
        if server and server.sockets:
            port = server.sockets[0].getsockname()[1]
            self.url = f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()


@pytest_asyncio.fixture
async def mock_a2a_agent():
    agent = MockA2AAgent(response_text="Hello from external A2A!")
    await agent.start()
    try:
        yield agent
    finally:
        await agent.stop()


# --- Unit tests with mocked Relay ---


class TestA2ABridgeConstruction:
    def test_bridge_creation(self):
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url="http://localhost:8000",
            proxy_name="proxy-agent",
        )
        assert bridge.proxy_name == "proxy-agent"
        assert bridge.a2a_agent_url == "http://localhost:8000"
        assert bridge.relay.agent_name == "proxy-agent"
        assert bridge._started is False

    def test_url_trailing_slash_stripped(self):
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url="http://localhost:8000/",
            proxy_name="proxy",
        )
        assert bridge.a2a_agent_url == "http://localhost:8000"


class TestA2ABridgeDiscovery:
    async def test_discover_agent(self, mock_a2a_agent: MockA2AAgent):
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url=mock_a2a_agent.url,
            proxy_name="proxy",
        )
        try:
            card = await bridge.discover_agent()
            assert card.name == "external-agent"
            assert card.url == mock_a2a_agent.url
            assert card.version == "1.0.0"
        finally:
            if bridge._session and not bridge._session.closed:
                await bridge._session.close()


class TestA2ABridgeSendMessage:
    async def test_send_a2a_message(self, mock_a2a_agent: MockA2AAgent):
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url=mock_a2a_agent.url,
            proxy_name="proxy",
        )
        try:
            response_text = await bridge.send_a2a_message("Hello, A2A agent!")
            assert response_text == "Hello from external A2A!"

            # Verify the mock received the JSON-RPC request
            assert len(mock_a2a_agent.received_messages) == 1
            req = mock_a2a_agent.received_messages[0]
            assert req["method"] == "message/send"
            assert req["params"]["message"]["role"] == "user"
            assert req["params"]["message"]["parts"][0]["text"] == "Hello, A2A agent!"
        finally:
            if bridge._session and not bridge._session.closed:
                await bridge._session.close()

    async def test_send_uses_discovered_card_url(self, mock_a2a_agent: MockA2AAgent):
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url=mock_a2a_agent.url,
            proxy_name="proxy",
        )
        try:
            # Discover first, then send
            await bridge.discover_agent()
            response = await bridge.send_a2a_message("After discovery")
            assert response == "Hello from external A2A!"
        finally:
            if bridge._session and not bridge._session.closed:
                await bridge._session.close()


class TestA2ABridgeRelayForwarding:
    async def test_handle_relay_message_forwards_to_a2a(self, mock_a2a_agent: MockA2AAgent):
        """Test that _handle_relay_message forwards to A2A and sends response back."""
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url=mock_a2a_agent.url,
            proxy_name="proxy",
        )

        # Mock relay.send so we can verify it's called with the A2A response
        bridge.relay.send = AsyncMock()
        bridge.relay._connected = True

        try:
            relay_msg = Message(sender="alice", text="Please process this")
            await bridge._handle_relay_message(relay_msg)

            # Verify A2A agent received the message
            assert len(mock_a2a_agent.received_messages) == 1
            assert mock_a2a_agent.received_messages[0]["params"]["message"]["parts"][0]["text"] == "Please process this"

            # Verify bridge forwarded response back via Relay
            bridge.relay.send.assert_called_once_with("alice", "Hello from external A2A!")
        finally:
            if bridge._session and not bridge._session.closed:
                await bridge._session.close()

    async def test_handle_relay_message_no_response(self):
        """Test behavior when A2A agent returns no text in response."""
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")

        # Create a mock A2A agent that returns empty response (no parts)
        empty_agent = MockA2AAgentEmpty()
        await empty_agent.start()
        bridge = None
        try:
            bridge = A2ABridge(
                relay_config=config,
                a2a_agent_url=empty_agent.url,
                proxy_name="proxy",
            )
            bridge.relay.send = AsyncMock()
            bridge.relay._connected = True

            relay_msg = Message(sender="bob", text="Hello")
            await bridge._handle_relay_message(relay_msg)

            # Should not call relay.send when no response text
            bridge.relay.send.assert_not_called()
        finally:
            await empty_agent.stop()
            if bridge and bridge._session and not bridge._session.closed:
                await bridge._session.close()


class TestA2ABridgeContextManager:
    async def test_context_manager(self):
        config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
        bridge = A2ABridge(
            relay_config=config,
            a2a_agent_url="http://localhost:8000",
            proxy_name="proxy",
        )

        # Mock the relay to avoid actual connections
        bridge.relay.__aenter__ = AsyncMock(return_value=bridge.relay)
        bridge.relay.__aexit__ = AsyncMock(return_value=None)
        bridge.relay.on_message = MagicMock()

        async with bridge:
            assert bridge._started is True

        assert bridge._started is False


# --- Integration: A2AServer <-> A2ABridge ---


class TestA2AServerBridgeIntegration:
    async def test_bridge_sends_to_a2a_server(self):
        """A2ABridge can send messages to an A2AServer."""
        # Set up an A2A server with an echo handler
        server = A2AServer(agent_name="echo-server", port=0, host="127.0.0.1")

        async def echo(msg: A2AMessage) -> A2AMessage:
            text = msg.parts[0].text if msg.parts else ""
            return A2AMessage(role="agent", parts=[A2APart(text=f"echo: {text}")])

        server.on_message(echo)
        await server.start()

        try:
            config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
            bridge = A2ABridge(
                relay_config=config,
                a2a_agent_url=server.url,
                proxy_name="proxy",
            )
            try:
                # Discover and send
                card = await bridge.discover_agent()
                assert card.name == "echo-server"

                response = await bridge.send_a2a_message("Hello server!")
                assert response == "echo: Hello server!"
            finally:
                if bridge._session and not bridge._session.closed:
                    await bridge._session.close()
        finally:
            await server.stop()

    async def test_bridge_full_relay_forwarding_to_a2a_server(self):
        """Full integration: Relay message -> Bridge -> A2AServer -> response back."""
        server = A2AServer(agent_name="responder", port=0, host="127.0.0.1")

        async def respond(msg: A2AMessage) -> A2AMessage:
            return A2AMessage(role="agent", parts=[A2APart(text="processed")])

        server.on_message(respond)
        await server.start()

        try:
            config = RelayConfig(workspace="test-ws", api_key="test-key", base_url="http://localhost:9999")
            bridge = A2ABridge(
                relay_config=config,
                a2a_agent_url=server.url,
                proxy_name="proxy",
            )
            bridge.relay.send = AsyncMock()
            bridge.relay._connected = True

            try:
                relay_msg = Message(sender="user-1", text="do something")
                await bridge._handle_relay_message(relay_msg)

                bridge.relay.send.assert_called_once_with("user-1", "processed")
            finally:
                if bridge._session and not bridge._session.closed:
                    await bridge._session.close()
        finally:
            await server.stop()
