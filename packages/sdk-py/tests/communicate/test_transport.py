"""Wave 1.2 tests for the RelayTransport HTTP/WS client."""

from __future__ import annotations

import asyncio
import importlib

import pytest

from agent_relay.communicate.types import (
    Message,
    RelayAuthError,
    RelayConfigError,
    RelayConnectionError,
)

_ORIGINAL_ASYNCIO_SLEEP = asyncio.sleep


def _transport_module():
    return importlib.import_module("agent_relay.communicate.transport")


def _transport_class():
    return _transport_module().RelayTransport


async def _wait_for(predicate, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await _ORIGINAL_ASYNCIO_SLEEP(0.01)

    raise AssertionError("Timed out waiting for async condition.")


@pytest.mark.asyncio
async def test_register_agent_and_unregister_agent_manage_identity(relay_server):
    RelayTransport = _transport_class()
    transport = RelayTransport("TransportTester", relay_server.make_config())

    await transport.register_agent()

    assert transport.agent_id in relay_server.registered_agents
    assert transport.token == relay_server.registered_agents[transport.agent_id]["token"]
    assert relay_server.requests["register_agent"][-1]["json"] == {
        "name": "TransportTester",
        "workspace": relay_server.workspace,
    }

    agent_id = transport.agent_id
    await transport.unregister_agent()

    assert relay_server.request_count("unregister_agent") == 1
    assert agent_id not in relay_server.registered_agents


@pytest.mark.asyncio
async def test_connect_and_disconnect_manage_registration_and_websocket(relay_server):
    RelayTransport = _transport_class()
    transport = RelayTransport("TransportTester", relay_server.make_config())

    await transport.connect()

    assert relay_server.request_count("register_agent") == 1
    assert transport.agent_id is not None
    await relay_server.wait_for_ws_connections(transport.agent_id, count=1)
    assert relay_server.websocket_connected(transport.agent_id)

    agent_id = transport.agent_id
    await transport.disconnect()

    assert relay_server.request_count("unregister_agent") == 1
    assert agent_id not in relay_server.registered_agents
    assert not relay_server.websocket_connected(agent_id)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method_name", "args", "operation", "expected_payload"),
    [
        (
            "send_dm",
            ("Review-Core", "hello"),
            "send_dm",
            {"to": "Review-Core", "text": "hello", "from": "TransportTester"},
        ),
        (
            "post_message",
            ("core-py", "status update"),
            "post_message",
            {"channel": "core-py", "text": "status update", "from": "TransportTester"},
        ),
        (
            "reply",
            ("message-123", "thread reply"),
            "reply",
            {"message_id": "message-123", "text": "thread reply", "from": "TransportTester"},
        ),
    ],
)
async def test_send_methods_use_expected_http_payload(
    relay_server,
    method_name,
    args,
    operation,
    expected_payload,
):
    RelayTransport = _transport_class()
    transport = RelayTransport("TransportTester", relay_server.make_config())
    await transport.connect()

    try:
        message_id = await getattr(transport, method_name)(*args)
    finally:
        await transport.disconnect()

    assert message_id.startswith("message-")
    assert relay_server.requests[operation][-1]["json"] == expected_payload


@pytest.mark.asyncio
async def test_check_inbox_returns_message_objects_and_drains_server_inbox(relay_server):
    RelayTransport = _transport_class()
    transport = RelayTransport("TransportTester", relay_server.make_config())
    await transport.connect()

    try:
        queued = relay_server.queue_inbox_message(
            transport.agent_id,
            sender="Impl-Core",
            text="transport ready",
            channel="core-py",
            thread_id="thread-1",
            message_id="message-inbox-1",
            timestamp=1710300000.5,
        )

        messages = await transport.check_inbox()
        empty = await transport.check_inbox()
    finally:
        await transport.disconnect()

    assert messages == [
        Message(
            sender=queued["sender"],
            text=queued["text"],
            channel=queued["channel"],
            thread_id=queued["thread_id"],
            timestamp=queued["timestamp"],
            message_id=queued["message_id"],
        )
    ]
    assert empty == []


@pytest.mark.asyncio
async def test_list_agents_returns_online_agent_names(relay_server):
    RelayTransport = _transport_class()
    relay_server.add_agent("Review-Core")
    transport = RelayTransport("TransportTester", relay_server.make_config())
    await transport.connect()

    try:
        agents = await transport.list_agents()
    finally:
        await transport.disconnect()

    assert set(agents) == {"Review-Core", "TransportTester"}


@pytest.mark.asyncio
async def test_websocket_messages_are_decoded_and_delivered_to_callback(relay_server):
    RelayTransport = _transport_class()
    transport = RelayTransport("TransportTester", relay_server.make_config())

    received: list[Message] = []
    delivered = asyncio.Event()

    async def on_message(message: Message) -> None:
        received.append(message)
        delivered.set()

    transport.on_ws_message(on_message)
    await transport.connect()

    try:
        await relay_server.push_ws_message(
            transport.agent_id,
            sender="Review-Core",
            text="looks good",
            channel="core-py",
            message_id="message-ws-1",
        )
        await asyncio.wait_for(delivered.wait(), timeout=1.0)
    finally:
        await transport.disconnect()

    assert received == [
        Message(
            sender="Review-Core",
            text="looks good",
            channel="core-py",
            thread_id=None,
            timestamp=None,
            message_id="message-ws-1",
        )
    ]


@pytest.mark.asyncio
async def test_transport_reconnects_after_websocket_disconnect(relay_server, monkeypatch):
    transport_module = _transport_module()
    RelayTransport = transport_module.RelayTransport
    sleep_calls: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleep_calls.append(delay)
        await _ORIGINAL_ASYNCIO_SLEEP(0)

    monkeypatch.setattr(transport_module.asyncio, "sleep", fake_sleep)

    transport = RelayTransport("TransportTester", relay_server.make_config())
    received: list[Message] = []
    delivered = asyncio.Event()

    def on_message(message: Message) -> None:
        received.append(message)
        delivered.set()

    transport.on_ws_message(on_message)
    await transport.connect()

    try:
        agent_id = transport.agent_id
        await relay_server.close_ws(agent_id)
        await relay_server.wait_for_ws_connections(agent_id, count=2)

        await relay_server.push_ws_message(
            agent_id,
            sender="Impl-Core",
            text="reconnected",
            message_id="message-reconnect-1",
        )
        await asyncio.wait_for(delivered.wait(), timeout=1.0)
    finally:
        await transport.disconnect()

    assert received[-1] == Message(
        sender="Impl-Core",
        text="reconnected",
        channel=None,
        thread_id=None,
        timestamp=None,
        message_id="message-reconnect-1",
    )
    assert [delay for delay in sleep_calls if delay >= 1][:1] == [1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("workspace", "api_key", "missing_name"),
    [
        ("test-workspace", None, "RELAY_API_KEY"),
        (None, "test-key", "RELAY_WORKSPACE"),
    ],
)
async def test_connect_requires_workspace_and_api_key(
    relay_server,
    monkeypatch,
    workspace,
    api_key,
    missing_name,
):
    RelayTransport = _transport_class()
    monkeypatch.delenv("RELAY_WORKSPACE", raising=False)
    monkeypatch.delenv("RELAY_API_KEY", raising=False)

    transport = RelayTransport(
        "TransportTester",
        relay_server.make_config(workspace=workspace, api_key=api_key),
    )

    with pytest.raises(RelayConfigError, match=missing_name):
        await transport.connect()


@pytest.mark.asyncio
async def test_register_agent_raises_relay_auth_error_on_401(relay_server):
    RelayTransport = _transport_class()
    relay_server.queue_http_error("register_agent", status=401, message="Unauthorized")
    transport = RelayTransport("TransportTester", relay_server.make_config())

    with pytest.raises(RelayAuthError, match="Unauthorized"):
        await transport.register_agent()


@pytest.mark.asyncio
async def test_send_dm_raises_connection_error_on_client_error(relay_server):
    RelayTransport = _transport_class()
    transport = RelayTransport("TransportTester", relay_server.make_config())
    await transport.connect()

    try:
        relay_server.queue_http_error("send_dm", status=404, message="Recipient not found")

        with pytest.raises(RelayConnectionError, match="Recipient not found") as exc_info:
            await transport.send_dm("Missing-Agent", "hello")
    finally:
        await transport.disconnect()

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_send_dm_retries_transient_server_errors_before_succeeding(
    relay_server,
    monkeypatch,
):
    transport_module = _transport_module()
    RelayTransport = transport_module.RelayTransport
    sleep_calls: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleep_calls.append(delay)
        await _ORIGINAL_ASYNCIO_SLEEP(0)

    monkeypatch.setattr(transport_module.asyncio, "sleep", fake_sleep)

    transport = RelayTransport("TransportTester", relay_server.make_config())
    await transport.connect()

    try:
        relay_server.queue_http_error(
            "send_dm",
            status=503,
            message="Temporary failure",
            repeat=2,
        )

        message_id = await transport.send_dm("Review-Core", "retry me")
    finally:
        await transport.disconnect()

    assert message_id.startswith("message-")
    assert relay_server.request_count("send_dm") == 3
    assert [delay for delay in sleep_calls if delay >= 1][:2] == [1, 2]


@pytest.mark.asyncio
async def test_send_dm_raises_after_exhausting_server_error_retries(
    relay_server,
    monkeypatch,
):
    transport_module = _transport_module()
    RelayTransport = transport_module.RelayTransport
    sleep_calls: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleep_calls.append(delay)
        await _ORIGINAL_ASYNCIO_SLEEP(0)

    monkeypatch.setattr(transport_module.asyncio, "sleep", fake_sleep)

    transport = RelayTransport("TransportTester", relay_server.make_config())
    await transport.connect()

    try:
        relay_server.queue_http_error(
            "send_dm",
            status=503,
            message="Still failing",
            repeat=3,
        )

        with pytest.raises(RelayConnectionError, match="Still failing") as exc_info:
            await transport.send_dm("Review-Core", "retry me")
    finally:
        await transport.disconnect()

    assert exc_info.value.status_code == 503
    assert relay_server.request_count("send_dm") == 3
    assert [delay for delay in sleep_calls if delay >= 1][:2] == [1, 2]
