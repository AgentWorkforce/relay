"""OpenAI Agents adapter for on_relay()."""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay


def _format_instructions_with_inbox(messages: list[Any], base_instructions: str) -> str:
    content = "New messages from other agents:\n"
    for message in messages:
        content += f"  {message.sender}: {message.text}\n"
    return f"{base_instructions}\n\n{content}" if base_instructions else content


def on_relay(agent: Any, relay: "Relay | None" = None) -> Any:
    """Wrap OpenAI Agent to connect it to the relay."""
    if relay is None:
        from ..core import Relay
        relay = Relay(getattr(agent, "name", "Agent"))
    try:
        from agents import function_tool
    except ImportError:
        raise ImportError(
            "on_relay() for OpenAI Agents requires the 'openai-agents' package. "
            "Install it with: pip install openai-agents"
        )

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

    agent.tools.extend([
        function_tool(relay_send),
        function_tool(relay_inbox),
        function_tool(relay_post),
        function_tool(relay_agents)
    ])

    # 2. Wrap instructions
    orig_instructions = agent.instructions

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
        messages = await relay.inbox()
        if not messages:
            return base

        return _format_instructions_with_inbox(messages, base)

    agent.instructions = instructions_wrapper
    return agent
