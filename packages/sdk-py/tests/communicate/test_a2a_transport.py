"""Tests for A2A transport implementation."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, TestServer, TestClient

from agent_relay.communicate.a2a_types import (
    A2AAgentCard,
    A2AConfig,
    A2AMessage,
    A2APart,
    A2ASkill,
    A2ATask,
    A2ATaskStatus,
    make_jsonrpc_request,
    make_jsonrpc_response,
)
from agent_relay.communicate.a2a_transport import A2AError, A2ATransport
from agent_relay.communicate.types import Message


# === Fixtures ===


def _make_agent_card(name: str = "remote-agent", url: str = "http://localhost:9999") -> dict:
    return A2AAgentCard(
        name=name,
        description=f"Test agent: {name}",
        url=url,
        skills=[A2ASkill(id="s1", name="Echo", description="Echo messages")],
    ).to_dict()


def _make_remote_a2a_app() -> web.Application:
    """Create a mock A2A remote agent app for testing client-side calls."""
    app = web.Application()
    # agent_card will be patched after we know the port
    app["agent_card"] = None

    async def handle_agent_card(request: web.Request) -> web.Response:
        return web.json_response(request.app["agent_card"])

    async def handle_jsonrpc(request: web.Request) -> web.Response:
        body = await request.json()
        method = body.get("method", "")
        rpc_id = body.get("id")
        params = body.get("params", {})

        if method == "message/send":
            msg = params.get("message", {})
            text = " ".join(
                p.get("text", "") for p in msg.get("parts", []) if p.get("text")
            )
            task = A2ATask(
                id="task-001",
                contextId="ctx-001",
                status=A2ATaskStatus(state="completed"),
                messages=[
                    A2AMessage.from_dict(msg),
                    A2AMessage(
                        role="agent",
                        parts=[A2APart(text=f"Echo: {text}")],
                        messageId="resp-1",
                    ),
                ],
            )
            return web.json_response(make_jsonrpc_response(task.to_dict(), rpc_id))

        return web.json_response({
            "jsonrpc": "2.0",
            "error": {"code": -32601, "message": f"Method not found: {method}"},
            "id": rpc_id,
        })

    app.router.add_get("/.well-known/agent.json", handle_agent_card)
    app.router.add_post("/", handle_jsonrpc)
    return app


@pytest.fixture
async def remote_agent():
    """Start a mock remote A2A agent server."""
    app = _make_remote_a2a_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()

    # Get the actual port and set the agent card with correct URL
    sockets = site._server.sockets
    port = sockets[0].getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    app["agent_card"] = _make_agent_card(url=base_url)

    yield base_url

    await site.stop()
    await runner.cleanup()


@pytest.fixture
def a2a_config():
    """Create a basic A2A config for testing."""
    return A2AConfig(
        server_port=0,  # Use 0 for auto-assign
        server_host="127.0.0.1",
        agent_description="Test agent",
    )


# === A2ATransport registration tests ===


class TestA2ATransportRegister:
    @pytest.mark.asyncio
    async def test_register_starts_server(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)
        try:
            result = await transport.register("test-agent")
            assert result["name"] == "test-agent"
            assert result["type"] == "a2a"
            assert transport.agent_name == "test-agent"
            assert transport.agent_card is not None
            assert transport.agent_card.name == "test-agent"
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_unregister_stops_server(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)
        await transport.register("test-agent")
        await transport.unregister()
        assert transport._site is None
        assert transport._runner is None
        assert transport._app is None


# === A2ATransport server-side tests (incoming JSON-RPC) ===


class TestA2ATransportServer:
    @pytest.mark.asyncio
    async def test_agent_card_endpoint(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)
        try:
            await transport.register("card-test-agent")

            # Get the server port
            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://127.0.0.1:{port}/.well-known/agent.json") as resp:
                    assert resp.status == 200
                    data = await resp.json()
                    assert data["name"] == "card-test-agent"
                    assert data["version"] == "1.0.0"
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_message_send_jsonrpc(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)
        received: list[Message] = []
        transport.on_message(lambda msg: received.append(msg))

        try:
            await transport.register("rpc-test-agent")

            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            rpc_request = make_jsonrpc_request(
                "message/send",
                {
                    "message": {
                        "role": "user",
                        "parts": [{"text": "hello from test"}],
                        "messageId": "msg-test-1",
                    }
                },
                id="req-1",
            )

            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"http://127.0.0.1:{port}/",
                    json=rpc_request,
                ) as resp:
                    assert resp.status == 200
                    data = await resp.json()
                    assert data["jsonrpc"] == "2.0"
                    assert data["id"] == "req-1"
                    result = data["result"]
                    assert result["status"]["state"] == "completed"
                    assert len(result["messages"]) == 1

            # Verify callback was invoked
            assert len(received) == 1
            assert received[0].text == "hello from test"
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_async_message_callback(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)
        received: list[Message] = []

        async def async_cb(msg: Message) -> None:
            received.append(msg)

        transport.on_message(async_cb)

        try:
            await transport.register("async-cb-agent")
            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            rpc_request = make_jsonrpc_request(
                "message/send",
                {"message": {"role": "user", "parts": [{"text": "async test"}], "messageId": "m1"}},
                id="r1",
            )

            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.post(f"http://127.0.0.1:{port}/", json=rpc_request) as resp:
                    assert resp.status == 200

            assert len(received) == 1
            assert received[0].text == "async test"
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_tasks_get(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)

        try:
            await transport.register("tasks-get-agent")
            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            import aiohttp
            async with aiohttp.ClientSession() as session:
                # First send a message to create a task
                send_req = make_jsonrpc_request(
                    "message/send",
                    {"message": {"role": "user", "parts": [{"text": "create task"}], "messageId": "m1"}},
                    id="r1",
                )
                async with session.post(f"http://127.0.0.1:{port}/", json=send_req) as resp:
                    send_data = await resp.json()
                    task_id = send_data["result"]["id"]

                # Then get the task
                get_req = make_jsonrpc_request("tasks/get", {"id": task_id}, id="r2")
                async with session.post(f"http://127.0.0.1:{port}/", json=get_req) as resp:
                    data = await resp.json()
                    assert data["result"]["id"] == task_id
                    assert data["result"]["status"]["state"] == "completed"
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_tasks_get_not_found(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)

        try:
            await transport.register("tasks-404-agent")
            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            import aiohttp
            async with aiohttp.ClientSession() as session:
                req = make_jsonrpc_request("tasks/get", {"id": "nonexistent"}, id="r1")
                async with session.post(f"http://127.0.0.1:{port}/", json=req) as resp:
                    data = await resp.json()
                    assert "error" in data
                    assert data["error"]["code"] == -32001

        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_tasks_cancel(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)

        try:
            await transport.register("cancel-agent")

            # Manually create a task in working state
            task = A2ATask(
                id="cancel-task-1",
                status=A2ATaskStatus(state="working"),
            )
            transport.tasks["cancel-task-1"] = task

            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            import aiohttp
            async with aiohttp.ClientSession() as session:
                req = make_jsonrpc_request("tasks/cancel", {"id": "cancel-task-1"}, id="r1")
                async with session.post(f"http://127.0.0.1:{port}/", json=req) as resp:
                    data = await resp.json()
                    assert data["result"]["status"]["state"] == "canceled"
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_method_not_found(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)

        try:
            await transport.register("method-404-agent")
            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            import aiohttp
            async with aiohttp.ClientSession() as session:
                req = make_jsonrpc_request("unknown/method", {}, id="r1")
                async with session.post(f"http://127.0.0.1:{port}/", json=req) as resp:
                    data = await resp.json()
                    assert "error" in data
                    assert data["error"]["code"] == -32601
        finally:
            await transport.unregister()

    @pytest.mark.asyncio
    async def test_parse_error(self):
        config = A2AConfig(server_port=0, server_host="127.0.0.1")
        transport = A2ATransport(config)

        try:
            await transport.register("parse-err-agent")
            sockets = transport._site._server.sockets
            port = sockets[0].getsockname()[1]

            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"http://127.0.0.1:{port}/",
                    data="not valid json",
                    headers={"Content-Type": "application/json"},
                ) as resp:
                    data = await resp.json()
                    assert "error" in data
                    assert data["error"]["code"] == -32700
        finally:
            await transport.unregister()


# === A2ATransport client-side tests ===


class TestA2ATransportClient:
    @pytest.mark.asyncio
    async def test_discover_agent(self, remote_agent):
        config = A2AConfig()
        transport = A2ATransport(config)
        try:
            card = await transport._discover_agent(remote_agent)
            assert card.name == "remote-agent"
            assert len(card.skills) == 1
            assert card.skills[0].name == "Echo"
        finally:
            await transport._close_session()

    @pytest.mark.asyncio
    async def test_discover_agent_caches(self, remote_agent):
        config = A2AConfig()
        transport = A2ATransport(config)
        try:
            card1 = await transport._discover_agent(remote_agent)
            card2 = await transport._discover_agent(remote_agent)
            assert card1 is card2  # Same object from cache
        finally:
            await transport._close_session()

    @pytest.mark.asyncio
    async def test_send_dm(self, remote_agent):
        config = A2AConfig()
        transport = A2ATransport(config)
        try:
            result = await transport.send_dm(remote_agent, "test message")
            assert result["text"] == "Echo: test message"
            assert result["task_id"] == "task-001"
            assert result["status"] == "completed"
        finally:
            await transport._close_session()

    @pytest.mark.asyncio
    async def test_list_agents(self, remote_agent):
        config = A2AConfig(registry=[remote_agent])
        transport = A2ATransport(config)
        try:
            agents = await transport.list_agents()
            assert len(agents) == 1
            assert agents[0]["name"] == "remote-agent"
            assert agents[0]["description"] == "Test agent: remote-agent"
        finally:
            await transport._close_session()

    @pytest.mark.asyncio
    async def test_list_agents_skips_unreachable(self):
        config = A2AConfig(registry=["http://127.0.0.1:1"])
        transport = A2ATransport(config)
        try:
            agents = await transport.list_agents()
            assert agents == []
        finally:
            await transport._close_session()


# === Message conversion tests ===


class TestMessageConversion:
    def test_relay_msg_to_a2a(self):
        a2a_msg = A2ATransport._relay_msg_to_a2a("hello world", "sender-1")
        assert a2a_msg.role == "user"
        assert len(a2a_msg.parts) == 1
        assert a2a_msg.parts[0].text == "hello world"

    def test_a2a_to_relay_msg(self):
        a2a_msg = A2AMessage(
            role="agent",
            parts=[A2APart(text="response text")],
            messageId="msg-1",
            contextId="ctx-1",
        )
        relay_msg = A2ATransport._a2a_to_relay_msg(a2a_msg, sender="remote-agent")
        assert relay_msg.sender == "remote-agent"
        assert relay_msg.text == "response text"
        assert relay_msg.thread_id == "ctx-1"
        assert relay_msg.message_id == "msg-1"

    def test_a2a_to_relay_msg_multi_part(self):
        a2a_msg = A2AMessage(
            role="agent",
            parts=[A2APart(text="hello"), A2APart(text="world")],
            messageId="msg-2",
        )
        relay_msg = A2ATransport._a2a_to_relay_msg(a2a_msg, sender="agent")
        assert relay_msg.text == "hello world"

    def test_roundtrip_conversion(self):
        original_text = "roundtrip test message"
        a2a_msg = A2ATransport._relay_msg_to_a2a(original_text, "sender")
        relay_msg = A2ATransport._a2a_to_relay_msg(a2a_msg, sender="sender")
        assert relay_msg.text == original_text

    def test_a2a_result_to_relay(self):
        result = {
            "id": "task-1",
            "status": {"state": "completed"},
            "messages": [
                {"role": "user", "parts": [{"text": "input"}]},
                {"role": "agent", "parts": [{"text": "output"}]},
            ],
        }
        relay_result = A2ATransport._a2a_result_to_relay(result, "remote")
        assert relay_result["sender"] == "remote"
        assert relay_result["text"] == "output"
        assert relay_result["task_id"] == "task-1"
        assert relay_result["status"] == "completed"

    def test_a2a_result_to_relay_empty_messages(self):
        result = {"id": "task-1", "status": {"state": "completed"}, "messages": []}
        relay_result = A2ATransport._a2a_result_to_relay(result, "remote")
        assert relay_result["text"] == ""


# === connect_ws is a no-op ===


class TestConnectWs:
    @pytest.mark.asyncio
    async def test_connect_ws_is_noop(self):
        config = A2AConfig()
        transport = A2ATransport(config)
        await transport.connect_ws()  # Should not raise


# === on_message ===


class TestOnMessage:
    def test_registers_callback(self):
        config = A2AConfig()
        transport = A2ATransport(config)
        cb = lambda msg: None
        transport.on_message(cb)
        assert cb in transport._message_callbacks

    def test_multiple_callbacks(self):
        config = A2AConfig()
        transport = A2ATransport(config)
        cb1 = lambda msg: None
        cb2 = lambda msg: None
        transport.on_message(cb1)
        transport.on_message(cb2)
        assert len(transport._message_callbacks) == 2


# === Auth headers ===


class TestAuthHeaders:
    def test_no_auth(self):
        config = A2AConfig()
        transport = A2ATransport(config)
        headers = transport._auth_headers()
        assert headers == {}

    def test_bearer_auth(self):
        config = A2AConfig(auth_scheme="bearer", auth_token="my-token")
        transport = A2ATransport(config)
        headers = transport._auth_headers()
        assert headers["Authorization"] == "Bearer my-token"

    def test_api_key_auth(self):
        config = A2AConfig(auth_scheme="api_key", auth_token="key-123")
        transport = A2ATransport(config)
        headers = transport._auth_headers()
        assert headers["X-API-Key"] == "key-123"

    def test_default_auth_scheme(self):
        config = A2AConfig(auth_token="fallback-token")
        transport = A2ATransport(config)
        headers = transport._auth_headers()
        assert headers["Authorization"] == "Bearer fallback-token"


# === A2AError ===


class TestA2AError:
    def test_error_attributes(self):
        err = A2AError(-32001, "Task not found")
        assert err.code == -32001
        assert err.message == "Task not found"
        assert "A2A error -32001" in str(err)
