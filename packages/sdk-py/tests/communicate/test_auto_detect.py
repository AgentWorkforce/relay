"""Tests for top-level communicate auto-detection."""

from __future__ import annotations

import sys
from types import ModuleType

import pytest


def _make_agent(module_name: str):
    agent_cls = type("MockAgent", (), {})
    agent_cls.__module__ = module_name
    return agent_cls()


def _install_adapter_stub(monkeypatch, module_name: str, sentinel: object):
    adapter_module = ModuleType(module_name)
    calls: list[tuple[object, object]] = []

    def fake_on_relay(agent, relay):
        calls.append((agent, relay))
        return sentinel

    adapter_module.on_relay = fake_on_relay
    monkeypatch.setitem(sys.modules, module_name, adapter_module)
    return calls


def test_on_relay_is_exported_from_top_level_package():
    from agent_relay import on_relay as top_level_on_relay
    from agent_relay.communicate.core import on_relay as communicate_on_relay

    assert top_level_on_relay is communicate_on_relay


@pytest.mark.parametrize(
    ("agent_module", "adapter_module"),
    [
        ("agents.runtime", "agent_relay.communicate.adapters.openai_agents"),
        ("google.adk.agents", "agent_relay.communicate.adapters.google_adk"),
        ("agno.agent", "agent_relay.communicate.adapters.agno"),
        ("swarms.agent", "agent_relay.communicate.adapters.swarms"),
        ("crewai.agent", "agent_relay.communicate.adapters.crewai"),
    ],
)
def test_on_relay_auto_detects_adapter(monkeypatch, agent_module: str, adapter_module: str):
    from agent_relay import on_relay

    relay = object()
    sentinel = object()
    calls = _install_adapter_stub(monkeypatch, adapter_module, sentinel)
    agent = _make_agent(agent_module)

    result = on_relay(agent, relay=relay)

    assert result is sentinel
    assert calls == [(agent, relay)]


def test_on_relay_rejects_unsupported_agent_types():
    from agent_relay import on_relay

    agent = _make_agent("custom.framework")

    with pytest.raises(TypeError, match="Supported frameworks"):
        on_relay(agent, relay=object())
