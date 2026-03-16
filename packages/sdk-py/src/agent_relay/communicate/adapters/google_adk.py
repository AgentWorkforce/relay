"""Google ADK adapter for on_relay()."""

from __future__ import annotations
import inspect
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay

def on_relay(agent: Any, relay: "Relay | None" = None) -> Any:
    """Wrap Google ADK Agent to connect it to the relay."""
    if relay is None:
        from ..core import Relay
        relay = Relay(getattr(agent, "name", "Agent"))
    
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

    async def relay_callback(llm_request: Any) -> Any:
        orig_result = None
        if orig_callback:
            orig_result = orig_callback(llm_request)
            if inspect.isawaitable(orig_result):
                orig_result = await orig_result

        # Always inject relay messages, even if the original callback returned a result
        messages = await relay.inbox()
        if messages:
            from google.genai.types import Content, Part

            if getattr(llm_request, "contents", None) is None:
                llm_request.contents = []

            for message in messages:
                llm_request.contents.append(
                    Content(
                        role="user",
                        parts=[Part(text=f"[Relay] {message.sender}: {message.text}")],
                    )
                )

        return orig_result

    agent.before_model_callback = relay_callback
    return agent
