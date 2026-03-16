"""Agno adapter for on_relay()."""

from __future__ import annotations
import inspect
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay


def _format_instructions_with_inbox(messages: list[Any], base_instructions: str) -> str:
    content = "\n\nNew messages from other agents:\n"
    for message in messages:
        content += f"  {message.sender}: {message.text}\n"
    return f"{content}\n{base_instructions}" if base_instructions else content


def on_relay(agent: Any, relay: "Relay | None" = None) -> Any:
    """Wrap Agno Agent to connect it to the relay."""
    if relay is None:
        from ..core import Relay
        relay = Relay(getattr(agent, "name", "Agent"))
    
    # 1. Add tools
    async def relay_send(to: str, text: str) -> str:
        """Send a private message to another agent."""
        await relay.send(to, text)
        return "Message sent"

    async def relay_inbox() -> str:
        """Check for new messages in the inbox."""
        messages = await relay.inbox()
        if not messages: return "No new messages"
        return "\n".join([f"From {m.sender}: {m.text}" for m in messages])

    async def relay_post(channel: str, text: str) -> str:
        """Post a message to a shared channel."""
        await relay.post(channel, text)
        return "Message posted"

    async def relay_agents() -> str:
        """List all agents currently on the relay."""
        agents = await relay.agents()
        return ", ".join(agents)

    agent.tools.extend([relay_send, relay_inbox, relay_post, relay_agents])

    # 2. Wrap instructions with a local buffer so we don't starve relay_inbox tool
    orig_instructions = agent.instructions
    pending_messages: list[Any] = []

    relay.on_message(lambda msg: pending_messages.append(msg))

    async def instructions_wrapper(*args: Any, **kwargs: Any) -> str:
        if callable(orig_instructions):
            if inspect.iscoroutinefunction(orig_instructions):
                base = await orig_instructions(*args, **kwargs)
            else:
                base = orig_instructions(*args, **kwargs)
                if inspect.isawaitable(base):
                    base = await base
        else:
            base = orig_instructions

        base = base or ""
        if not pending_messages:
            return base

        messages = list(pending_messages)
        pending_messages.clear()
        return _format_instructions_with_inbox(messages, base)

    agent.instructions = instructions_wrapper
    return agent
