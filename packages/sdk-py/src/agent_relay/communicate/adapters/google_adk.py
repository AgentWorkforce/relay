"""Google ADK adapter for on_relay()."""

from __future__ import annotations
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay

def on_relay(agent: Any, relay: Relay) -> Any:
    """Wrap Google ADK Agent to connect it to the relay."""
    
    # 1. Add tools for sending
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

    # 2. Inject before_model_callback for receiving
    orig_callback = getattr(agent, "before_model_callback", None)

    async def relay_callback(llm_request: Any) -> None:
        if orig_callback:
            await orig_callback(llm_request)
        
        messages = await relay.inbox()
        if messages:
            content = "\n\nNew messages from other agents:\n"
            for m in messages:
                content += f"  Relay message from {m.sender}: {m.text}\n"
            
            # Assuming llm_request.contents is a list of user messages
            # and we can append a new user part/content
            llm_request.contents.append(content)

    agent.before_model_callback = relay_callback
    return agent
