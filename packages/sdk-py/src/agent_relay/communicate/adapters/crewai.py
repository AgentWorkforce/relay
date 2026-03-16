"""CrewAI adapter for on_relay()."""

from __future__ import annotations
import asyncio
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay


def _message_key(message: Any) -> tuple[str | None, str, str]:
    return (getattr(message, "message_id", None), message.sender, message.text)


def _format_backstory(messages: list[Any], base_backstory: str) -> str:
    if not messages:
        return base_backstory

    content = "\n\nNew messages from other agents:\n"
    for message in messages:
        content += f"  {message.sender}: {message.text}\n"
    return f"{content}\n{base_backstory}" if base_backstory else content


class _RelayBackstory:
    def __init__(self, relay: "Relay", base_backstory: str, buffer: list[Any]) -> None:
        self._relay = relay
        self._base_backstory = base_backstory
        self._buffer = buffer

    def _drain_buffer(self) -> list[Any]:
        messages = list(self._buffer)
        self._buffer.clear()
        return messages

    def _dedupe(self, messages: list[Any]) -> list[Any]:
        seen: set[tuple[str | None, str, str]] = set()
        unique: list[Any] = []
        for message in messages:
            key = _message_key(message)
            if key in seen:
                continue
            seen.add(key)
            unique.append(message)
        return unique

    def _resolve_sync(self) -> str:
        messages = self._drain_buffer()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is None:
            messages.extend(self._relay.inbox_sync())
        else:
            # Running inside an event loop — use a thread to avoid blocking
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                polled = pool.submit(asyncio.run, self._relay.inbox()).result()
                messages.extend(polled)
        return _format_backstory(self._dedupe(messages), self._base_backstory)

    async def _resolve_async(self) -> str:
        messages = self._drain_buffer()
        messages.extend(await self._relay.inbox())
        return _format_backstory(self._dedupe(messages), self._base_backstory)

    def __call__(self) -> str:
        return self._resolve_sync()

    def __await__(self) -> Any:
        return self._resolve_async().__await__()

    def __contains__(self, item: str) -> bool:
        return item in self._resolve_sync()

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            return self._resolve_sync() == other
        return NotImplemented

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve_sync(), name)

    def __repr__(self) -> str:
        return repr(self._resolve_sync())

    def __str__(self) -> str:
        return self._resolve_sync()


def on_relay(agent: Any, relay: "Relay | None" = None) -> Any:
    """Wrap CrewAI Agent to connect it to the relay."""
    if relay is None:
        from ..core import Relay
        relay = Relay(getattr(agent, "name", "Agent"))
    try:
        from crewai.tools import tool
    except ImportError:
        raise ImportError(
            "on_relay() for CrewAI requires the 'crewai' package. "
            "Install it with: pip install crewai"
        )

    @tool
    async def relay_send(to: str, text: str) -> str:
        """Send a private message to another agent."""
        await relay.send(to, text)
        return "Message sent"

    @tool
    async def relay_inbox() -> str:
        """Check for new messages in the inbox."""
        messages = await relay.inbox()
        if not messages:
            return "No new messages"
        return "\n".join([f"From {m.sender}: {m.text}" for m in messages])

    @tool
    async def relay_post(channel: str, text: str) -> str:
        """Post a message to a shared channel."""
        await relay.post(channel, text)
        return "Message posted"

    @tool
    async def relay_agents() -> str:
        """List all agents currently on the relay."""
        agents = await relay.agents()
        return ", ".join(agents)

    agent.tools.extend([relay_send, relay_inbox, relay_post, relay_agents])

    backstory_buffer: list[Any] = []

    def _buffer_message(message: Any) -> None:
        backstory_buffer.append(message)

    unsubscribe = relay.on_message(_buffer_message)
    agent.backstory = _RelayBackstory(relay, agent.backstory or "", backstory_buffer)
    agent._relay_unsubscribe = unsubscribe  # type: ignore[attr-defined]

    return agent
