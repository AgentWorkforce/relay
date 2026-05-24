"""Tests for AgentRelay spawn harness configuration."""

from agent_relay import AgentRelay, HarnessDefinition


def test_relay_resolves_constructor_and_registered_harnesses():
    relay = AgentRelay(
        harnesses={
            "qwen": HarnessDefinition(
                binary="qwen",
                interactive_args=["run", "{modelArgs}", "{args}"],
                model_args=["-m", "{model}"],
            )
        }
    )

    assert relay._resolve_harness("qwen:coder") == {
        "binary": "qwen",
        "interactiveArgs": ["run", "{modelArgs}", "{args}"],
        "modelArgs": ["-m", "{model}"],
    }

    relay.register_harness("local", {"binary": "local-agent", "bypassFlag": "--yes"})

    assert relay._resolve_harness("local") == {
        "binary": "local-agent",
        "bypassFlag": "--yes",
    }
