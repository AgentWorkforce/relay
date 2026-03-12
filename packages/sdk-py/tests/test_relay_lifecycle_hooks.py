"""Tests for spawn/release lifecycle hooks in the high-level relay facade."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from agent_relay import AgentRelay, SpawnOptions


class _FakeRelayClient:
    def __init__(self) -> None:
        self.spawn_error: Exception | None = None
        self.release_error: Exception | None = None
        self.spawn_calls: list[dict] = []
        self.release_calls: list[tuple[str, str | None]] = []

    async def spawn_provider(self, **kwargs):
        self.spawn_calls.append(kwargs)
        if self.spawn_error:
            raise self.spawn_error
        return {"name": kwargs["name"], "runtime": "pty"}

    async def release(self, name: str, reason: str | None = None):
        self.release_calls.append((name, reason))
        if self.release_error:
            raise self.release_error
        return {"name": name}


@pytest.mark.asyncio
async def test_spawn_lifecycle_hooks_success():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)

    events: list[tuple[str, dict]] = []
    options = SpawnOptions(
        channels=["general"],
        on_start=lambda ctx: events.append(("start", dict(ctx))),
        on_success=lambda ctx: events.append(("success", dict(ctx))),
        on_error=lambda ctx: events.append(("error", dict(ctx))),
    )

    agent = await relay.spawn("HookWorker", "claude", "Do the work", options)

    assert agent.name == "HookWorker"
    assert events[0] == (
        "start",
        {
            "name": "HookWorker",
            "cli": "claude",
            "channels": ["general"],
            "task": "Do the work",
        },
    )
    assert events[1] == (
        "success",
        {
            "name": "HookWorker",
            "cli": "claude",
            "channels": ["general"],
            "task": "Do the work",
            "runtime": "pty",
        },
    )
    assert len(events) == 2


@pytest.mark.asyncio
async def test_spawn_lifecycle_hooks_support_async_callbacks():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)

    start_done = False
    success_done = False

    async def on_start(_ctx):
        nonlocal start_done
        await asyncio.sleep(0)
        start_done = True

    async def on_success(_ctx):
        nonlocal success_done
        await asyncio.sleep(0)
        success_done = True

    options = SpawnOptions(
        channels=["general"],
        on_start=on_start,
        on_success=on_success,
    )

    await relay.spawn("AsyncHookWorker", "claude", "Do the work", options)

    assert start_done is True
    assert success_done is True


@pytest.mark.asyncio
async def test_spawn_lifecycle_hooks_error():
    relay = AgentRelay()
    client = _FakeRelayClient()
    client.spawn_error = RuntimeError("spawn failed")
    relay._ensure_started = AsyncMock(return_value=client)

    on_error_calls: list[dict] = []
    options = SpawnOptions(
        channels=["general"],
        on_start=lambda _: None,
        on_error=lambda ctx: on_error_calls.append(dict(ctx)),
    )

    with pytest.raises(RuntimeError, match="spawn failed"):
        await relay.spawn("HookWorkerFail", "claude", "Do the work", options)

    assert len(on_error_calls) == 1
    error_ctx = on_error_calls[0]
    assert error_ctx["name"] == "HookWorkerFail"
    assert error_ctx["cli"] == "claude"
    assert isinstance(error_ctx["error"], RuntimeError)


@pytest.mark.asyncio
async def test_shorthand_spawn_lifecycle_hooks_success():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)

    events: list[str] = []
    agent = await relay.claude.spawn(
        name="ShorthandWorker",
        channels=["general"],
        task="Run analysis",
        on_start=lambda _: events.append("start"),
        on_success=lambda _: events.append("success"),
        on_error=lambda _: events.append("error"),
    )

    assert agent.name == "ShorthandWorker"
    assert events == ["start", "success"]
    assert client.spawn_calls[-1]["transport"] == "pty"


@pytest.mark.asyncio
async def test_opencode_shorthand_spawn_success():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)

    agent = await relay.opencode.spawn(
        name="OpencodeWorker",
        channels=["general"],
    )

    assert agent.name == "OpencodeWorker"
    assert client.spawn_calls[-1]["provider"] == "opencode"
    assert client.spawn_calls[-1]["transport"] == "headless"


@pytest.mark.asyncio
async def test_shorthand_spawn_does_not_fire_start_hook_if_broker_startup_fails():
    relay = AgentRelay()
    relay._ensure_started = AsyncMock(side_effect=RuntimeError("broker startup failed"))

    start_called = False
    error_called = False

    def _mark_called(kind: str) -> None:
        nonlocal start_called, error_called
        if kind == "start":
            start_called = True
        else:
            error_called = True

    with pytest.raises(RuntimeError, match="broker startup failed"):
        await relay.claude.spawn(
            name="ShorthandWorkerStartupFail",
            channels=["general"],
            on_start=lambda _ctx: _mark_called("start"),
            on_error=lambda _ctx: _mark_called("error"),
        )

    assert start_called is False
    assert error_called is False


@pytest.mark.asyncio
async def test_release_lifecycle_hooks_success_and_error():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)

    agent = await relay.spawn("ReleaseWorker", "claude")

    success_events: list[str] = []
    await agent.release(
        "cleanup",
        on_start=lambda _: success_events.append("start"),
        on_success=lambda _: success_events.append("success"),
        on_error=lambda _: success_events.append("error"),
    )

    assert client.release_calls[-1] == ("ReleaseWorker", "cleanup")
    assert success_events == ["start", "success"]

    client.release_error = RuntimeError("release failed")
    error_calls: list[dict] = []
    with pytest.raises(RuntimeError, match="release failed"):
        await agent.release(
            "cleanup-again",
            on_error=lambda ctx: error_calls.append(dict(ctx)),
        )

    assert len(error_calls) == 1
    assert error_calls[0]["name"] == "ReleaseWorker"
    assert isinstance(error_calls[0]["error"], RuntimeError)


@pytest.mark.asyncio
async def test_release_lifecycle_hooks_support_async_callbacks():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)

    agent = await relay.spawn("ReleaseAsyncWorker", "claude")

    success_done = False

    async def on_success(_ctx):
        nonlocal success_done
        await asyncio.sleep(0)
        success_done = True

    await agent.release("cleanup", on_success=on_success)

    assert success_done is True


@pytest.mark.asyncio
async def test_release_does_not_fire_hooks_if_broker_startup_fails():
    relay = AgentRelay()
    client = _FakeRelayClient()
    relay._ensure_started = AsyncMock(return_value=client)
    agent = await relay.spawn("ReleaseStartupFailWorker", "claude")

    relay._ensure_started = AsyncMock(side_effect=RuntimeError("broker startup failed"))

    start_called = False
    error_called = False

    def mark_start(_ctx):
        nonlocal start_called
        start_called = True

    def mark_error(_ctx):
        nonlocal error_called
        error_called = True

    with pytest.raises(RuntimeError, match="broker startup failed"):
        await agent.release("cleanup", on_start=mark_start, on_error=mark_error)

    assert start_called is False
    assert error_called is False
