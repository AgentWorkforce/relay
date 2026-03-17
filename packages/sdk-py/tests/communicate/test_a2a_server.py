"""Tests for A2AServer — JSON-RPC dispatch, Agent Card serving, task lifecycle."""

from __future__ import annotations

import asyncio
import uuid

import aiohttp
import pytest
import pytest_asyncio

from agent_relay.communicate.a2a_server import A2AServer
from agent_relay.communicate.a2a_types import (
    A2AMessage,
    A2APart,
    A2ASkill,
    A2ATask,
    A2ATaskStatus,
)


@pytest_asyncio.fixture
async def a2a_server():
    """Start an A2AServer on a random port for testing."""
    server = A2AServer(agent_name="test-agent", port=0, host="127.0.0.1")
    await server.start()
    try:
        yield server
    finally:
        await server.stop()


@pytest.fixture
def server_url(a2a_server: A2AServer) -> str:
    return a2a_server.url


# --- Agent Card tests ---


class TestAgentCard:
    async def test_agent_card_served_at_well_known(self, server_url: str):
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{server_url}/.well-known/agent.json") as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data["name"] == "test-agent"
                assert "Agent Relay agent" in data["description"]
                assert data["version"] == "1.0.0"
                assert data["capabilities"]["streaming"] is True
                assert data["defaultInputModes"] == ["text"]
                assert data["defaultOutputModes"] == ["text"]

    async def test_agent_card_includes_skills(self):
        skills = [A2ASkill(id="s1", name="Skill One", description="Does thing one")]
        server = A2AServer(agent_name="skilled-agent", port=0, host="127.0.0.1", skills=skills)
        await server.start()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{server.url}/.well-known/agent.json") as resp:
                    data = await resp.json()
                    assert len(data["skills"]) == 1
                    assert data["skills"][0]["id"] == "s1"
                    assert data["skills"][0]["name"] == "Skill One"
        finally:
            await server.stop()

    async def test_get_agent_card_method(self, a2a_server: A2AServer):
        card = a2a_server.get_agent_card()
        assert card.name == "test-agent"
        assert card.url == a2a_server.url


# --- JSON-RPC dispatch tests ---


class TestJsonRpcDispatch:
    async def test_message_send_creates_task(self, server_url: str, a2a_server: A2AServer):
        payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"text": "Hello, agent!"}],
                }
            },
            "id": "req-1",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data["jsonrpc"] == "2.0"
                assert data["id"] == "req-1"
                result = data["result"]
                assert "id" in result
                assert result["status"]["state"] == "completed"
                assert len(result["messages"]) >= 1
                # Task should be stored
                assert result["id"] in a2a_server.tasks

    async def test_message_send_with_callback(self, server_url: str, a2a_server: A2AServer):
        async def echo_handler(msg: A2AMessage) -> A2AMessage:
            text = msg.parts[0].text if msg.parts else ""
            return A2AMessage(
                role="agent",
                parts=[A2APart(text=f"Echo: {text}")],
                messageId=str(uuid.uuid4()),
            )

        a2a_server.on_message(echo_handler)

        payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"text": "Hello!"}],
                }
            },
            "id": "req-2",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                data = await resp.json()
                result = data["result"]
                assert result["status"]["state"] == "completed"
                # Should have both the user message and the agent response
                assert len(result["messages"]) == 2
                agent_msg = result["messages"][1]
                assert agent_msg["role"] == "agent"
                assert "Echo: Hello!" in agent_msg["parts"][0]["text"]

    async def test_message_send_sync_callback(self, server_url: str, a2a_server: A2AServer):
        """Test that synchronous (non-async) callbacks work."""

        def sync_handler(msg: A2AMessage) -> A2AMessage:
            return A2AMessage(
                role="agent",
                parts=[A2APart(text="sync response")],
            )

        a2a_server.on_message(sync_handler)

        payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": [{"text": "test"}]}},
            "id": "req-sync",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                data = await resp.json()
                assert data["result"]["status"]["state"] == "completed"
                assert data["result"]["messages"][1]["parts"][0]["text"] == "sync response"

    async def test_tasks_get(self, server_url: str, a2a_server: A2AServer):
        # First create a task via message/send
        send_payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": [{"text": "create task"}]}},
            "id": "req-create",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=send_payload) as resp:
                created = (await resp.json())["result"]
                task_id = created["id"]

            # Now get the task
            get_payload = {
                "jsonrpc": "2.0",
                "method": "tasks/get",
                "params": {"id": task_id},
                "id": "req-get",
            }
            async with session.post(server_url, json=get_payload) as resp:
                data = await resp.json()
                assert data["id"] == "req-get"
                assert data["result"]["id"] == task_id
                assert data["result"]["status"]["state"] == "completed"

    async def test_tasks_get_not_found(self, server_url: str):
        payload = {
            "jsonrpc": "2.0",
            "method": "tasks/get",
            "params": {"id": "nonexistent-task"},
            "id": "req-404",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                assert resp.status == 404
                data = await resp.json()
                assert data["error"]["code"] == -32602

    async def test_tasks_cancel(self, server_url: str, a2a_server: A2AServer):
        # Create a task
        send_payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": [{"text": "cancel me"}]}},
            "id": "req-c1",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=send_payload) as resp:
                task_id = (await resp.json())["result"]["id"]

            # Cancel it
            cancel_payload = {
                "jsonrpc": "2.0",
                "method": "tasks/cancel",
                "params": {"id": task_id},
                "id": "req-c2",
            }
            async with session.post(server_url, json=cancel_payload) as resp:
                data = await resp.json()
                assert data["result"]["status"]["state"] == "canceled"

        # Verify stored task state
        assert a2a_server.tasks[task_id].status.state == "canceled"

    async def test_unknown_method(self, server_url: str):
        payload = {
            "jsonrpc": "2.0",
            "method": "unknown/method",
            "params": {},
            "id": "req-unknown",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                assert resp.status == 400
                data = await resp.json()
                assert data["error"]["code"] == -32601

    async def test_invalid_json(self, server_url: str):
        async with aiohttp.ClientSession() as session:
            async with session.post(
                server_url,
                data=b"not json",
                headers={"Content-Type": "application/json"},
            ) as resp:
                assert resp.status == 400
                data = await resp.json()
                assert data["error"]["code"] == -32700


# --- Task lifecycle tests ---


class TestTaskLifecycle:
    async def test_task_submitted_to_completed(self, server_url: str, a2a_server: A2AServer):
        """Task goes through working -> completed when callback responds."""

        async def delayed_handler(msg: A2AMessage) -> A2AMessage:
            return A2AMessage(role="agent", parts=[A2APart(text="done")])

        a2a_server.on_message(delayed_handler)

        payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": [{"text": "work"}]}},
            "id": "req-lc",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                data = await resp.json()
                assert data["result"]["status"]["state"] == "completed"

    async def test_task_completed_without_callback(self, server_url: str, a2a_server: A2AServer):
        """Task completes even with no callback registered."""
        payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": [{"text": "no handler"}]}},
            "id": "req-no-cb",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, json=payload) as resp:
                data = await resp.json()
                assert data["result"]["status"]["state"] == "completed"
                assert len(data["result"]["messages"]) == 1

    async def test_existing_task_updated_with_new_message(self, a2a_server: A2AServer):
        """Sending a message with an existing taskId appends to that task."""
        task_id = str(uuid.uuid4())

        # First message
        result1 = await a2a_server.handle_message_send({
            "message": {
                "role": "user",
                "parts": [{"text": "first"}],
                "taskId": task_id,
            }
        })
        assert result1["id"] == task_id
        assert len(result1["messages"]) == 1

        # Second message to same task
        result2 = await a2a_server.handle_message_send({
            "message": {
                "role": "user",
                "parts": [{"text": "second"}],
                "taskId": task_id,
            }
        })
        assert result2["id"] == task_id
        assert len(result2["messages"]) == 2

    async def test_message_preserves_context_id(self, a2a_server: A2AServer):
        ctx_id = "ctx-123"
        result = await a2a_server.handle_message_send({
            "message": {
                "role": "user",
                "parts": [{"text": "with context"}],
                "contextId": ctx_id,
            }
        })
        assert result["contextId"] == ctx_id


# --- Server start/stop ---


class TestServerLifecycle:
    async def test_start_and_stop(self):
        server = A2AServer(agent_name="lifecycle-test", port=0, host="127.0.0.1")
        await server.start()
        assert server._actual_port is not None
        assert server._actual_port > 0

        # Verify server is running
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{server.url}/.well-known/agent.json") as resp:
                assert resp.status == 200

        await server.stop()
        assert server._runner is None

    async def test_double_stop_is_safe(self):
        server = A2AServer(agent_name="double-stop", port=0, host="127.0.0.1")
        await server.start()
        await server.stop()
        await server.stop()  # Should not raise
