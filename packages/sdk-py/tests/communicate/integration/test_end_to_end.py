"""Wave 4.1 end-to-end integration tests against a real Relaycast server."""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest

from agent_relay.communicate.transport import RelayTransport
from agent_relay.communicate.types import Message, RelayConfig

pytestmark = pytest.mark.skipif(
    not os.environ.get("RELAY_E2E"),
    reason="Set RELAY_E2E=1 for e2e tests",
)


def _e2e_config() -> RelayConfig:
    config = RelayConfig.resolve(
        workspace=os.environ.get("RELAY_WORKSPACE"),
        api_key=os.environ.get("RELAY_API_KEY"),
        base_url=os.environ.get("RELAY_BASE_URL"),
        auto_cleanup=False,
    )
    if not config.workspace or not config.api_key:
        pytest.fail("RELAY_WORKSPACE and RELAY_API_KEY must be set for e2e tests.")
    return config


def _unique_name(prefix: str) -> str:
    timestamp = int(time.time() * 1000)
    return f"{prefix}-{timestamp}-{uuid.uuid4().hex[:8]}"


async def _safe_disconnect(transport: RelayTransport) -> None:
    try:
        await transport.disconnect()
    except Exception:
        pass


async def _wait_for_message(
    transport: RelayTransport,
    *,
    sender: str,
    text: str,
    timeout: float = 15.0,
) -> Message:
    deadline = asyncio.get_running_loop().time() + timeout

    while asyncio.get_running_loop().time() < deadline:
        for message in await transport.check_inbox():
            if message.sender == sender and message.text == text:
                return message
        await asyncio.sleep(0.25)

    raise AssertionError(f"Timed out waiting for DM from {sender!r}: {text!r}")


async def _wait_for_agent_absent(
    transport: RelayTransport,
    agent_name: str,
    *,
    timeout: float = 15.0,
) -> None:
    deadline = asyncio.get_running_loop().time() + timeout

    while asyncio.get_running_loop().time() < deadline:
        if agent_name not in await transport.list_agents():
            return
        await asyncio.sleep(0.25)

    raise AssertionError(f"Timed out waiting for {agent_name!r} to disappear from list_agents().")


@pytest.mark.asyncio
async def test_register_send_receive_inbox_and_unregister_round_trip():
    config = _e2e_config()
    sender = RelayTransport(_unique_name("sdk-py-e2e-sender"), config)
    receiver = RelayTransport(_unique_name("sdk-py-e2e-receiver"), config)
    probe = RelayTransport(_unique_name("sdk-py-e2e-probe"), config)
    text = f"hello-{uuid.uuid4().hex}"

    await asyncio.gather(sender.connect(), receiver.connect(), probe.connect())

    try:
        agents = await probe.list_agents()
        assert sender.agent_name in agents
        assert receiver.agent_name in agents

        await sender.send_dm(receiver.agent_name, text)
        message = await _wait_for_message(receiver, sender=sender.agent_name, text=text)
        assert message.text == text
        assert message.sender == sender.agent_name

        receiver_name = receiver.agent_name
        await receiver.disconnect()
        await _wait_for_agent_absent(probe, receiver_name)
    finally:
        await asyncio.gather(
            _safe_disconnect(sender),
            _safe_disconnect(receiver),
            _safe_disconnect(probe),
        )

    cleanup_probe = RelayTransport(_unique_name("sdk-py-e2e-cleanup"), config)
    await cleanup_probe.connect()
    try:
        agents = await cleanup_probe.list_agents()
        assert sender.agent_name not in agents
        assert receiver.agent_name not in agents
    finally:
        await _safe_disconnect(cleanup_probe)


@pytest.mark.asyncio
async def test_two_agents_can_exchange_bidirectional_messages():
    config = _e2e_config()
    alpha = RelayTransport(_unique_name("sdk-py-e2e-alpha"), config)
    beta = RelayTransport(_unique_name("sdk-py-e2e-beta"), config)

    first_text = f"alpha-to-beta-{uuid.uuid4().hex}"
    second_text = f"beta-to-alpha-{uuid.uuid4().hex}"

    await asyncio.gather(alpha.connect(), beta.connect())

    try:
        await alpha.send_dm(beta.agent_name, first_text)
        first = await _wait_for_message(beta, sender=alpha.agent_name, text=first_text)
        assert first.sender == alpha.agent_name
        assert first.text == first_text

        await beta.send_dm(alpha.agent_name, second_text)
        second = await _wait_for_message(alpha, sender=beta.agent_name, text=second_text)
        assert second.sender == beta.agent_name
        assert second.text == second_text
    finally:
        await asyncio.gather(_safe_disconnect(alpha), _safe_disconnect(beta))
