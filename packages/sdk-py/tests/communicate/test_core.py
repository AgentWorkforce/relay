"""Wave 1.3 tests for the communicate Relay core."""

from __future__ import annotations

import asyncio
import importlib
from inspect import isawaitable

import pytest

from agent_relay.communicate.types import Message, RelayConfig


def _core_module():
    return importlib.import_module("agent_relay.communicate.core")


async def _wait_for(predicate, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Timed out waiting for async condition.")


@pytest.fixture
def core_harness(monkeypatch):
    core = _core_module()
    registered_atexit: list[object] = []

    class FakeTransport:
        instances: list["FakeTransport"] = []

        def __init__(self, agent_name: str, config: RelayConfig) -> None:
            self.agent_name = agent_name
            self.config = config
            self.connect_count = 0
            self.disconnect_count = 0
            self.send_dm_calls: list[tuple[str, str]] = []
            self.post_message_calls: list[tuple[str, str]] = []
            self.reply_calls: list[tuple[str, str]] = []
            self.list_agents_calls = 0
            self.list_agents_result = ["Review-Core", "Impl-Core"]
            self.ws_callback = None
            self.connected = False
            FakeTransport.instances.append(self)

        async def connect(self) -> None:
            self.connect_count += 1
            await asyncio.sleep(0)
            self.connected = True

        async def disconnect(self) -> None:
            self.disconnect_count += 1
            self.connected = False

        async def send_dm(self, to: str, text: str) -> str:
            self.send_dm_calls.append((to, text))
            return "message-send"

        async def post_message(self, channel: str, text: str) -> str:
            self.post_message_calls.append((channel, text))
            return "message-post"

        async def reply(self, message_id: str, text: str) -> str:
            self.reply_calls.append((message_id, text))
            return "message-reply"

        async def list_agents(self) -> list[str]:
            self.list_agents_calls += 1
            return list(self.list_agents_result)

        def on_ws_message(self, callback) -> None:
            self.ws_callback = callback

        async def emit_message(self, message: Message) -> None:
            if self.ws_callback is None:
                raise AssertionError("Relay did not register a transport WS callback.")
            result = self.ws_callback(message)
            if isawaitable(result):
                await result

    monkeypatch.setattr(core, "RelayTransport", FakeTransport)
    monkeypatch.setattr(core.atexit, "register", lambda callback: registered_atexit.append(callback))

    return core, FakeTransport, registered_atexit


def test_init_is_lazy_and_registers_atexit_cleanup(core_harness):
    core, FakeTransport, registered_atexit = core_harness

    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=True))

    assert sum(transport.connect_count for transport in FakeTransport.instances) == 0
    assert len(registered_atexit) == 1
    assert getattr(registered_atexit[0], "__self__", None) is relay
    assert getattr(registered_atexit[0], "__name__", None) == "close_sync"


def test_init_skips_atexit_cleanup_when_disabled(core_harness):
    core, _FakeTransport, registered_atexit = core_harness

    core.Relay("CoreTester", RelayConfig(auto_cleanup=False))

    assert registered_atexit == []


@pytest.mark.asyncio
async def test_send_lazy_connects_and_delegates_to_transport(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]

    result = await relay.send("Impl-Core", "hello")

    assert result is None
    assert transport.connect_count == 1
    assert transport.send_dm_calls == [("Impl-Core", "hello")]


@pytest.mark.asyncio
async def test_post_lazy_connects_and_delegates_to_transport(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]

    result = await relay.post("core-py", "status update")

    assert result is None
    assert transport.connect_count == 1
    assert transport.post_message_calls == [("core-py", "status update")]


@pytest.mark.asyncio
async def test_reply_lazy_connects_and_delegates_to_transport(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]

    result = await relay.reply("message-123", "thread response")

    assert result is None
    assert transport.connect_count == 1
    assert transport.reply_calls == [("message-123", "thread response")]


@pytest.mark.asyncio
async def test_inbox_drains_pending_buffer_and_does_not_poll_transport(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]
    relay._pending.extend(
        [
            Message(sender="Review-Core", text="one", message_id="message-1"),
            Message(sender="Impl-Core", text="two", message_id="message-2"),
        ]
    )

    first = await relay.inbox()
    second = await relay.inbox()

    assert first == [
        Message(sender="Review-Core", text="one", message_id="message-1"),
        Message(sender="Impl-Core", text="two", message_id="message-2"),
    ]
    assert second == []
    assert relay._pending == []
    assert transport.connect_count == 1


@pytest.mark.asyncio
async def test_on_message_registers_callback_and_unsubscribe_restores_buffering(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]

    received: list[Message] = []
    unsubscribe = relay.on_message(lambda message: received.append(message))

    await _wait_for(lambda: transport.connect_count == 1)

    callback_message = Message(sender="Review-Core", text="callback", message_id="message-cb")
    buffered_message = Message(sender="Impl-Core", text="buffered", message_id="message-buffer")

    await transport.emit_message(callback_message)
    unsubscribe()
    await transport.emit_message(buffered_message)
    inbox_messages = await relay.inbox()

    assert received == [callback_message]
    assert inbox_messages == [buffered_message]


@pytest.mark.asyncio
async def test_pending_buffer_caps_at_ten_thousand_and_drops_oldest_with_warning(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]

    await relay.agents()

    with pytest.warns(UserWarning, match="10,000|10000|buffer"):
        for index in range(10_001):
            await transport.emit_message(
                Message(
                    sender="Review-Core",
                    text=f"message-{index}",
                    message_id=f"message-{index}",
                )
            )

    messages = await relay.inbox()

    assert len(messages) == 10_000
    assert messages[0].message_id == "message-1"
    assert messages[-1].message_id == "message-10000"


@pytest.mark.asyncio
async def test_agents_returns_transport_agent_list(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]
    transport.list_agents_result = ["Review-Core", "Impl-Core", "CoreTester"]

    agents = await relay.agents()

    assert agents == ["Review-Core", "Impl-Core", "CoreTester"]
    assert transport.connect_count == 1
    assert transport.list_agents_calls == 1


@pytest.mark.asyncio
async def test_close_disconnects_transport(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]

    await relay.send("Impl-Core", "hello")
    await relay.close()

    assert transport.disconnect_count == 1


def test_sync_wrappers_delegate_to_async_methods(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    transport = FakeTransport.instances[0]
    relay._pending.append(Message(sender="Review-Core", text="sync inbox", message_id="message-sync"))
    transport.list_agents_result = ["Review-Core", "Impl-Core"]

    relay.send_sync("Impl-Core", "sync hello")
    relay.post_sync("core-py", "sync update")
    inbox_messages = relay.inbox_sync()
    agents = relay.agents_sync()
    relay.close_sync()

    assert transport.send_dm_calls == [("Impl-Core", "sync hello")]
    assert transport.post_message_calls == [("core-py", "sync update")]
    assert inbox_messages == [Message(sender="Review-Core", text="sync inbox", message_id="message-sync")]
    assert agents == ["Review-Core", "Impl-Core"]
    assert transport.disconnect_count == 1


@pytest.mark.asyncio
async def test_async_context_manager_closes_transport_on_exit(core_harness):
    core, FakeTransport, _registered_atexit = core_harness

    async with core.Relay("CoreTester", RelayConfig(auto_cleanup=False)) as relay:
        await relay.send("Impl-Core", "inside context")
        transport = FakeTransport.instances[0]
        assert transport.connect_count == 1

    assert transport.disconnect_count == 1


@pytest.mark.asyncio
async def test_concurrent_inbox_calls_do_not_lose_messages(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    relay = core.Relay("CoreTester", RelayConfig(auto_cleanup=False))
    relay._pending.extend(
        [
            Message(sender="one", text="first", message_id="message-1"),
            Message(sender="two", text="second", message_id="message-2"),
            Message(sender="three", text="third", message_id="message-3"),
        ]
    )

    results = await asyncio.gather(relay.inbox(), relay.inbox())

    combined = [message.message_id for batch in results for message in batch]
    assert sorted(combined) == ["message-1", "message-2", "message-3"]
    assert relay._pending == []


@pytest.mark.asyncio
async def test_multiple_relay_instances_are_independent(core_harness):
    core, FakeTransport, _registered_atexit = core_harness
    first = core.Relay("FirstRelay", RelayConfig(auto_cleanup=False))
    second = core.Relay("SecondRelay", RelayConfig(auto_cleanup=False))
    first_transport, second_transport = FakeTransport.instances

    await first.agents()
    await second.agents()

    await first_transport.emit_message(
        Message(sender="Review-Core", text="first only", message_id="message-first")
    )
    await second_transport.emit_message(
        Message(sender="Impl-Core", text="second only", message_id="message-second")
    )

    assert await first.inbox() == [
        Message(sender="Review-Core", text="first only", message_id="message-first")
    ]
    assert await second.inbox() == [
        Message(sender="Impl-Core", text="second only", message_id="message-second")
    ]
    assert first_transport is not second_transport


def test_communicate_package_reexports_public_core_symbols():
    core = _core_module()
    communicate = importlib.reload(importlib.import_module("agent_relay.communicate"))

    assert communicate.Relay is core.Relay
    assert communicate.Message is Message
    assert communicate.RelayConfig is RelayConfig
    assert hasattr(communicate, "on_relay")
