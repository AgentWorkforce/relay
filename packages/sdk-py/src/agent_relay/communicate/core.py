"""High-level Relay facade for communicate mode."""

from __future__ import annotations

import atexit
import asyncio
import threading
import warnings
from inspect import isawaitable
from typing import Any

from .transport import RelayTransport
from .types import Message, MessageCallback, RelayConfig

MAX_PENDING_MESSAGES = 10_000


class Relay:
    """Relay client with buffered inbox access and callback subscriptions."""

    def __init__(self, agent_name: str, config: RelayConfig | None = None) -> None:
        self.agent_name = agent_name
        self.config = config if config is not None else RelayConfig.resolve()
        self.transport = RelayTransport(agent_name, self.config)

        self._pending: list[Message] = []
        self._callbacks: list[MessageCallback] = []
        self._state_lock = threading.Lock()
        self._connect_task: asyncio.Task[None] | None = None
        self._connected = False

        self.transport.on_ws_message(self._handle_transport_message)

        if self.config.auto_cleanup:
            atexit.register(self.close_sync)

    async def send(self, to: str, text: str) -> None:
        await self._ensure_connected()
        await self.transport.send_dm(to, text)

    async def post(self, channel: str, text: str) -> None:
        await self._ensure_connected()
        await self.transport.post_message(channel, text)

    async def reply(self, message_id: str, text: str) -> None:
        await self._ensure_connected()
        await self.transport.reply(message_id, text)

    async def inbox(self) -> list[Message]:
        await self._ensure_connected()
        with self._state_lock:
            messages = list(self._pending)
            self._pending.clear()
        return messages

    def on_message(self, callback: MessageCallback) -> callable:
        with self._state_lock:
            self._callbacks.append(callback)

        self._schedule_connect()

        def unsubscribe() -> None:
            with self._state_lock:
                try:
                    self._callbacks.remove(callback)
                except ValueError:
                    pass

        return unsubscribe

    async def agents(self) -> list[str]:
        await self._ensure_connected()
        return await self.transport.list_agents()

    async def close(self) -> None:
        connect_task = self._connect_task
        self._connect_task = None

        if connect_task is not None and not connect_task.done():
            connect_task.cancel()
            try:
                await connect_task
            except asyncio.CancelledError:
                pass

        await self.transport.disconnect()
        self._connected = False

    def send_sync(self, to: str, text: str) -> None:
        return self._run_sync(self.send(to, text))

    def post_sync(self, channel: str, text: str) -> None:
        return self._run_sync(self.post(channel, text))

    def inbox_sync(self) -> list[Message]:
        return self._run_sync(self.inbox())

    def agents_sync(self) -> list[str]:
        return self._run_sync(self.agents())

    def close_sync(self) -> None:
        return self._run_sync(self.close())

    async def __aenter__(self) -> "Relay":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def _ensure_connected(self) -> None:
        if self._connected:
            return

        current_task = asyncio.current_task()
        connect_task = self._connect_task
        if connect_task is not None and connect_task is not current_task and not connect_task.done():
            await connect_task
            return

        await self.transport.connect()
        self._connected = True

    def _schedule_connect(self) -> None:
        if self._connected:
            return

        if self._connect_task is not None and not self._connect_task.done():
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._run_sync(self._ensure_connected())
            return

        task = loop.create_task(self._ensure_connected())
        self._connect_task = task
        task.add_done_callback(self._clear_connect_task)

    def _clear_connect_task(self, task: asyncio.Task[None]) -> None:
        if self._connect_task is task:
            self._connect_task = None

    async def _handle_transport_message(self, message: Message) -> None:
        with self._state_lock:
            callbacks = list(self._callbacks)
            if not callbacks:
                if len(self._pending) >= MAX_PENDING_MESSAGES:
                    self._pending.pop(0)
                    warnings.warn(
                        "Relay pending buffer exceeded 10,000 messages; dropping oldest message.",
                        UserWarning,
                        stacklevel=2,
                    )
                self._pending.append(message)
                return

        for callback in callbacks:
            result = callback(message)
            if isawaitable(result):
                await result

    @staticmethod
    def _run_sync(awaitable: Any) -> Any:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(awaitable)
        raise RuntimeError("Sync Relay methods cannot run from an active event loop.")


def on_relay(agent: Any, relay: Relay | None = None) -> Any:
    """Auto-detect and apply the correct relay adapter for the given agent."""
    if relay is None:
        # Resolve a default relay if none provided
        relay = Relay(getattr(agent, "name", "Agent"))

    cls_module = type(agent).__module__
    if cls_module.startswith("agents"):
        from .adapters.openai_agents import on_relay as _adapt
        return _adapt(agent, relay)
    if cls_module.startswith("google.adk"):
        from .adapters.google_adk import on_relay as _adapt
        return _adapt(agent, relay)
    if cls_module.startswith("agno"):
        from .adapters.agno import on_relay as _adapt
        return _adapt(agent, relay)
    if cls_module.startswith("swarms"):
        from .adapters.swarms import on_relay as _adapt
        return _adapt(agent, relay)
    if cls_module.startswith("crewai"):
        from .adapters.crewai import on_relay as _adapt
        return _adapt(agent, relay)

    raise TypeError(
        f"on_relay() doesn't recognize {type(agent).__name__} from {cls_module}. "
        "Supported frameworks: OpenAI Agents, Google ADK, Agno, Swarms, CrewAI (Python). "
        "For Claude Agent SDK, import the adapter directly: "
        "from agent_relay.communicate.adapters.claude_sdk import on_relay"
    )


__all__ = ["Relay", "on_relay"]
