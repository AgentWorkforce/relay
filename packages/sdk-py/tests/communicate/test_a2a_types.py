"""Tests for A2A data model types."""

from __future__ import annotations

import json

import pytest

from agent_relay.communicate.a2a_types import (
    A2AAgentCard,
    A2AConfig,
    A2AMessage,
    A2APart,
    A2ASkill,
    A2ATask,
    A2ATaskStatus,
    VALID_TASK_STATES,
    make_jsonrpc_error,
    make_jsonrpc_request,
    make_jsonrpc_response,
)


# === A2APart ===


class TestA2APart:
    def test_text_part_roundtrip(self):
        part = A2APart(text="hello")
        d = part.to_dict()
        assert d == {"text": "hello"}
        restored = A2APart.from_dict(d)
        assert restored.text == "hello"
        assert restored.file is None
        assert restored.data is None

    def test_empty_part(self):
        part = A2APart()
        d = part.to_dict()
        assert d == {}
        restored = A2APart.from_dict(d)
        assert restored.text is None

    def test_file_part(self):
        part = A2APart(file={"name": "test.txt", "bytes": "aGVsbG8="})
        d = part.to_dict()
        assert "file" in d
        assert d["file"]["name"] == "test.txt"

    def test_data_part(self):
        part = A2APart(data={"key": "value"})
        d = part.to_dict()
        assert d["data"] == {"key": "value"}

    def test_from_dict_ignores_unknown_keys(self):
        part = A2APart.from_dict({"text": "hi", "unknown": True})
        assert part.text == "hi"


# === A2AMessage ===


class TestA2AMessage:
    def test_basic_message_roundtrip(self):
        msg = A2AMessage(
            role="user",
            parts=[A2APart(text="hello world")],
            messageId="msg-1",
        )
        d = msg.to_dict()
        assert d["role"] == "user"
        assert d["parts"] == [{"text": "hello world"}]
        assert d["messageId"] == "msg-1"

        restored = A2AMessage.from_dict(d)
        assert restored.role == "user"
        assert restored.parts[0].text == "hello world"
        assert restored.messageId == "msg-1"

    def test_auto_generates_message_id(self):
        msg = A2AMessage(role="agent", parts=[A2APart(text="response")])
        assert msg.messageId is not None
        assert len(msg.messageId) > 0

    def test_get_text_concatenates_parts(self):
        msg = A2AMessage(
            role="user",
            parts=[A2APart(text="hello"), A2APart(text="world")],
        )
        assert msg.get_text() == "hello world"

    def test_get_text_skips_non_text_parts(self):
        msg = A2AMessage(
            role="user",
            parts=[A2APart(text="hello"), A2APart(data={"x": 1}), A2APart(text="world")],
        )
        assert msg.get_text() == "hello world"

    def test_context_and_task_ids(self):
        msg = A2AMessage(
            role="user",
            parts=[A2APart(text="test")],
            contextId="ctx-1",
            taskId="task-1",
        )
        d = msg.to_dict()
        assert d["contextId"] == "ctx-1"
        assert d["taskId"] == "task-1"

        restored = A2AMessage.from_dict(d)
        assert restored.contextId == "ctx-1"
        assert restored.taskId == "task-1"

    def test_optional_fields_omitted_when_none(self):
        msg = A2AMessage(role="user", parts=[], messageId="m1")
        d = msg.to_dict()
        assert "contextId" not in d
        assert "taskId" not in d

    def test_from_dict_with_empty_parts(self):
        msg = A2AMessage.from_dict({"role": "agent"})
        assert msg.parts == []


# === A2ATaskStatus ===


class TestA2ATaskStatus:
    def test_basic_roundtrip(self):
        status = A2ATaskStatus(state="completed", timestamp="2025-01-01T00:00:00Z")
        d = status.to_dict()
        assert d["state"] == "completed"
        assert d["timestamp"] == "2025-01-01T00:00:00Z"

        restored = A2ATaskStatus.from_dict(d)
        assert restored.state == "completed"

    def test_auto_generates_timestamp(self):
        status = A2ATaskStatus(state="submitted")
        assert status.timestamp is not None

    def test_with_message(self):
        msg = A2AMessage(role="agent", parts=[A2APart(text="done")], messageId="m1")
        status = A2ATaskStatus(state="completed", message=msg)
        d = status.to_dict()
        assert "message" in d
        assert d["message"]["role"] == "agent"

        restored = A2ATaskStatus.from_dict(d)
        assert restored.message is not None
        assert restored.message.role == "agent"

    def test_valid_states(self):
        assert "submitted" in VALID_TASK_STATES
        assert "working" in VALID_TASK_STATES
        assert "completed" in VALID_TASK_STATES
        assert "failed" in VALID_TASK_STATES
        assert "canceled" in VALID_TASK_STATES


# === A2ATask ===


class TestA2ATask:
    def test_basic_roundtrip(self):
        task = A2ATask(id="t1", contextId="ctx-1")
        d = task.to_dict()
        assert d["id"] == "t1"
        assert d["contextId"] == "ctx-1"
        assert d["status"]["state"] == "submitted"
        assert d["messages"] == []
        assert d["artifacts"] == []

        restored = A2ATask.from_dict(d)
        assert restored.id == "t1"
        assert restored.contextId == "ctx-1"
        assert restored.status.state == "submitted"

    def test_with_messages(self):
        msg = A2AMessage(role="user", parts=[A2APart(text="hello")], messageId="m1")
        task = A2ATask(
            id="t1",
            status=A2ATaskStatus(state="working"),
            messages=[msg],
        )
        d = task.to_dict()
        assert len(d["messages"]) == 1
        assert d["messages"][0]["parts"][0]["text"] == "hello"

        restored = A2ATask.from_dict(d)
        assert len(restored.messages) == 1
        assert restored.messages[0].get_text() == "hello"

    def test_with_artifacts(self):
        task = A2ATask(
            id="t1",
            artifacts=[{"name": "result", "parts": [{"text": "output"}]}],
        )
        d = task.to_dict()
        assert len(d["artifacts"]) == 1

    def test_default_status(self):
        task = A2ATask(id="t1")
        assert task.status.state == "submitted"

    def test_from_dict_without_status(self):
        task = A2ATask.from_dict({"id": "t1"})
        assert task.status.state == "submitted"


# === A2ASkill ===


class TestA2ASkill:
    def test_roundtrip(self):
        skill = A2ASkill(id="s1", name="Search", description="Search the web")
        d = skill.to_dict()
        assert d == {"id": "s1", "name": "Search", "description": "Search the web"}

        restored = A2ASkill.from_dict(d)
        assert restored.id == "s1"
        assert restored.name == "Search"
        assert restored.description == "Search the web"


# === A2AAgentCard ===


class TestA2AAgentCard:
    def test_basic_roundtrip(self):
        card = A2AAgentCard(
            name="test-agent",
            description="A test agent",
            url="http://localhost:5000",
        )
        d = card.to_dict()
        assert d["name"] == "test-agent"
        assert d["url"] == "http://localhost:5000"
        assert d["version"] == "1.0.0"
        assert d["capabilities"]["streaming"] is True
        assert d["defaultInputModes"] == ["text"]
        assert d["defaultOutputModes"] == ["text"]

        restored = A2AAgentCard.from_dict(d)
        assert restored.name == "test-agent"
        assert restored.url == "http://localhost:5000"

    def test_with_skills(self):
        card = A2AAgentCard(
            name="skilled-agent",
            description="Agent with skills",
            url="http://localhost:5000",
            skills=[A2ASkill(id="s1", name="Code", description="Write code")],
        )
        d = card.to_dict()
        assert len(d["skills"]) == 1
        assert d["skills"][0]["name"] == "Code"

        restored = A2AAgentCard.from_dict(d)
        assert len(restored.skills) == 1
        assert restored.skills[0].name == "Code"

    def test_from_dict_with_defaults(self):
        card = A2AAgentCard.from_dict({
            "name": "minimal",
            "description": "Minimal card",
            "url": "http://localhost:3000",
        })
        assert card.version == "1.0.0"
        assert card.capabilities == {"streaming": True, "pushNotifications": False}
        assert card.skills == []

    def test_json_serialization(self):
        card = A2AAgentCard(
            name="json-test",
            description="JSON test",
            url="http://localhost:5000",
        )
        json_str = json.dumps(card.to_dict())
        parsed = json.loads(json_str)
        restored = A2AAgentCard.from_dict(parsed)
        assert restored.name == "json-test"


# === A2AConfig ===


class TestA2AConfig:
    def test_defaults(self):
        config = A2AConfig()
        assert config.server_port == 5000
        assert config.server_host == "0.0.0.0"
        assert config.target_url is None
        assert config.registry == []
        assert config.auth_scheme is None
        assert config.auth_token is None

    def test_custom_config(self):
        config = A2AConfig(
            server_port=8080,
            target_url="http://remote-agent:5000",
            registry=["http://agent1:5000", "http://agent2:5000"],
            auth_scheme="bearer",
            auth_token="test-token",
        )
        assert config.server_port == 8080
        assert config.target_url == "http://remote-agent:5000"
        assert len(config.registry) == 2


# === JSON-RPC helpers ===


class TestJsonRpc:
    def test_make_request(self):
        req = make_jsonrpc_request("message/send", {"text": "hi"}, id="req-1")
        assert req["jsonrpc"] == "2.0"
        assert req["method"] == "message/send"
        assert req["params"] == {"text": "hi"}
        assert req["id"] == "req-1"

    def test_make_request_auto_id(self):
        req = make_jsonrpc_request("message/send", {})
        assert "id" in req
        assert len(req["id"]) > 0

    def test_make_response(self):
        resp = make_jsonrpc_response({"status": "ok"}, "req-1")
        assert resp["jsonrpc"] == "2.0"
        assert resp["result"] == {"status": "ok"}
        assert resp["id"] == "req-1"

    def test_make_error(self):
        err = make_jsonrpc_error(-32600, "Invalid request", "req-1")
        assert err["jsonrpc"] == "2.0"
        assert err["error"]["code"] == -32600
        assert err["error"]["message"] == "Invalid request"
        assert err["id"] == "req-1"

    def test_make_error_with_null_id(self):
        err = make_jsonrpc_error(-32700, "Parse error", None)
        assert err["id"] is None
