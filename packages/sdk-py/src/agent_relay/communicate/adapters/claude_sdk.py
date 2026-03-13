"""Claude Agent SDK adapter for on_relay()."""

from __future__ import annotations
import inspect
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..core import Relay


def on_relay(name: str, options: Any, relay: "Relay | None" = None) -> Any:
    """Wrap Claude Agent SDK query options to connect them to the relay."""
    try:
        from claude_agent_sdk.types import HookResult
    except ImportError as exc:
        raise ImportError(
            "on_relay() for Claude Agent SDK requires the 'claude-agent-sdk' package. "
            "Install it with: pip install claude-agent-sdk"
        ) from exc

    if relay is None:
        from ..core import Relay
        relay = Relay(name)

    if getattr(options, "hooks", None) is None:
        options.hooks = SimpleNamespace(post_tool_use=None, stop=None)

    # 1. Inject Relaycast MCP server
    mcp_config = {"name": "relaycast", "command": "agent-relay", "args": ["mcp"]}
    if hasattr(options, "mcp_servers"):
        options.mcp_servers.append(mcp_config)
    else:
        options.mcp_servers = [mcp_config]

    # 2. Helper to format inbox messages
    async def _drain_to_system_message() -> str | None:
        messages = await relay.inbox()
        if not messages: return None
        content = "\n\nNew messages from other agents:\n"
        for m in messages:
            content += f"  Relay message from {m.sender}: {m.text}\n"
        return content

    # 3. Hook wrappers
    orig_post = options.hooks.post_tool_use if hasattr(options.hooks, "post_tool_use") else None
    orig_stop = options.hooks.stop if hasattr(options.hooks, "stop") else None

    async def post_tool_use_hook(*args, **kwargs):
        res = None
        if orig_post:
            res = orig_post(*args, **kwargs)
            if inspect.isawaitable(res):
                res = await res
        msg = await _drain_to_system_message()
        if not msg:
            return res
        combined = (res.system_message + msg) if (res and res.system_message) else msg
        return HookResult(system_message=combined)

    async def stop_hook(*args, **kwargs):
        res = None
        if orig_stop:
            res = orig_stop(*args, **kwargs)
            if inspect.isawaitable(res):
                res = await res
        msg = await _drain_to_system_message()
        if not msg:
            return res
        combined = (res.system_message + msg) if (res and res.system_message) else msg
        return HookResult(system_message=combined, should_continue=True)

    options.hooks.post_tool_use = post_tool_use_hook
    options.hooks.stop = stop_hook
    return options
