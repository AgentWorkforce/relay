"""CrewAI adapter for on_relay()."""

from __future__ import annotations
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay


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

    orig_backstory = agent.backstory or ""
    try:
        messages = relay.inbox_sync() if hasattr(relay, "inbox_sync") else []
    except RuntimeError:
        # Can't call sync from async context — skip initial drain
        messages = []
    if messages:
        content = "\n\nNew messages from other agents:\n"
        for m in messages:
            content += f"  Relay message from {m.sender}: {m.text}\n"
        agent.backstory = orig_backstory + content

    return agent
