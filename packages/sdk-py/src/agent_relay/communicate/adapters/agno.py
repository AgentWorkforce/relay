"""Agno adapter for on_relay()."""

from __future__ import annotations
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay

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

    # 2. Wrap instructions
    orig_instructions = agent.instructions

    async def instructions_wrapper(*args: Any, **kwargs: Any) -> str:
        base = orig_instructions(*args, **kwargs) if callable(orig_instructions) else (orig_instructions or "")
        messages = await relay.inbox()
        if not messages: return base
        
        content = "\n\nNew messages from other agents:\n"
        for m in messages:
            content += f"  Relay message from {m.sender}: {m.text}\n"
        return base + content

    agent.instructions = instructions_wrapper
    return agent
