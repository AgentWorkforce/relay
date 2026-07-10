"""Tests for the node-provider enrollment sugar."""

import json

import pytest

from agent_relay.node import NodeProvider, NodeProviderEnrollmentError

ENROLLMENT_ENV = [
    "RELAY_NODE_TOKEN",
    "RELAY_NODE_ID",
    "RELAY_NODE_NAME",
    "RELAY_BASE_URL",
    "AGENT_RELAY_HOME",
]


@pytest.fixture(autouse=True)
def clear_env(monkeypatch):
    for key in ENROLLMENT_ENV:
        monkeypatch.delenv(key, raising=False)


def test_from_enrollment_reads_the_environment(monkeypatch):
    monkeypatch.setenv("RELAY_NODE_TOKEN", "nt_live_env")
    monkeypatch.setenv("RELAY_NODE_ID", "node_env")
    monkeypatch.setenv("RELAY_NODE_NAME", "data-pipeline")
    monkeypatch.setenv("RELAY_BASE_URL", "https://engine.test")

    node = NodeProvider.from_enrollment()

    assert node._node_token == "nt_live_env"
    assert node._node_id == "node_env"
    assert node._node_name == "data-pipeline"
    assert node._http_base_url == "https://engine.test"
    # The provider name is distinct from the broker ("broker") on the node.
    assert node._provider_name == "data-pipeline-python"


def test_from_enrollment_honors_explicit_provider_name(monkeypatch):
    monkeypatch.setenv("RELAY_NODE_TOKEN", "nt_live_env")
    monkeypatch.setenv("RELAY_NODE_ID", "node_env")

    node = NodeProvider.from_enrollment(provider_name="etl")

    assert node._provider_name == "etl"
    # Absent a name, node_name falls back to the node id.
    assert node._node_name == "node_env"


def test_from_enrollment_falls_back_to_the_enrollment_store(monkeypatch, tmp_path):
    store = {
        "version": 1,
        "active": {"ws_1": "key_a"},
        "nodes": {
            "key_a": {
                "nodeId": "node_file",
                "nodeName": "app",
                "nodeToken": "nt_live_file",
                "relayWorkspaceId": "ws_1",
                "relaycastUrl": "https://cast.file",
                "websocketUrl": "wss://cast.file",
                "enrolledAt": "2026-07-09T00:00:00Z",
            }
        },
    }
    (tmp_path / "fleet-enrollments.json").write_text(json.dumps(store))
    monkeypatch.setenv("AGENT_RELAY_HOME", str(tmp_path))

    node = NodeProvider.from_enrollment()

    assert node._node_token == "nt_live_file"
    assert node._node_id == "node_file"
    assert node._node_name == "app"
    assert node._http_base_url == "https://cast.file"


def test_from_enrollment_prefers_the_environment_over_the_store(monkeypatch, tmp_path):
    store = {
        "version": 1,
        "active": {},
        "nodes": {
            "only": {
                "nodeId": "node_file",
                "nodeName": "app",
                "nodeToken": "nt_live_file",
                "relayWorkspaceId": "ws_1",
                "relaycastUrl": "https://cast.file",
                "websocketUrl": "wss://cast.file",
                "enrolledAt": "2026-07-09T00:00:00Z",
            }
        },
    }
    (tmp_path / "fleet-enrollments.json").write_text(json.dumps(store))
    monkeypatch.setenv("AGENT_RELAY_HOME", str(tmp_path))
    monkeypatch.setenv("RELAY_NODE_TOKEN", "nt_live_env")
    monkeypatch.setenv("RELAY_NODE_ID", "node_env")

    node = NodeProvider.from_enrollment()

    assert node._node_token == "nt_live_env"
    assert node._node_id == "node_env"


def test_from_enrollment_picks_the_store_record_matching_relay_base_url(monkeypatch, tmp_path):
    def record(node, url):
        return {
            "nodeId": f"node_{node}",
            "nodeName": node,
            "nodeToken": f"nt_{node}",
            "relayWorkspaceId": "ws",
            "relaycastUrl": url,
            "websocketUrl": url.replace("https", "wss"),
            "enrolledAt": "2026-07-09T00:00:00Z",
        }

    store = {
        "version": 1,
        "active": {"ws": "a"},
        "nodes": {"a": record("a", "https://a.test"), "b": record("b", "https://b.test")},
    }
    (tmp_path / "fleet-enrollments.json").write_text(json.dumps(store))
    monkeypatch.setenv("AGENT_RELAY_HOME", str(tmp_path))
    monkeypatch.setenv("RELAY_BASE_URL", "https://b.test")

    node = NodeProvider.from_enrollment()

    # Not the "active" record (a) — the one whose engine matches RELAY_BASE_URL.
    assert node._node_id == "node_b"
    assert node._node_token == "nt_b"
    assert node._http_base_url == "https://b.test"


def test_from_enrollment_raises_without_a_token(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_RELAY_HOME", str(tmp_path))

    with pytest.raises(NodeProviderEnrollmentError, match="node token"):
        NodeProvider.from_enrollment()


def test_from_enrollment_raises_without_a_node_id(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_RELAY_HOME", str(tmp_path))
    monkeypatch.setenv("RELAY_NODE_TOKEN", "nt_live_env")

    with pytest.raises(NodeProviderEnrollmentError, match="node id"):
        NodeProvider.from_enrollment()
