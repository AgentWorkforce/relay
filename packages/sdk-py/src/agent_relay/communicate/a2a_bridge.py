"""Bridge that connects an external A2A agent into a Relay workspace."""

from __future__ import annotations

import uuid
from typing import Any

import aiohttp

from .a2a_types import A2AAgentCard, A2AConfig, A2AMessage, A2APart
from .core import Relay
from .types import Message, RelayConfig


class A2ABridge:
    """Bridges an external A2A agent into a Relay workspace.

    - Registers a proxy agent on the Relay workspace
    - When Relay messages arrive for the proxy, forwards them as A2A JSON-RPC
      message/send calls to the external agent
    - When A2A responses come back, forwards them as Relay DMs

    Usage:
        bridge = A2ABridge(
            relay_config=RelayConfig(workspace="myworkspace", api_key="rk_..."),
            a2a_agent_url="https://partner-billing-agent.example.com",
            proxy_name="partner-billing",
        )
        await bridge.start()
        # Now "partner-billing" appears as an agent in the Relay workspace
    """

    def __init__(
        self,
        relay_config: RelayConfig,
        a2a_agent_url: str,
        proxy_name: str,
    ) -> None:
        self.relay = Relay(proxy_name, relay_config)
        self.a2a_agent_url = a2a_agent_url.rstrip("/")
        self.proxy_name = proxy_name
        self._session: aiohttp.ClientSession | None = None
        self._agent_card: A2AAgentCard | None = None
        self._started = False

    async def start(self) -> None:
        """Register proxy on Relay, listen for messages, forward to A2A agent."""
        await self.relay.__aenter__()
        self.relay.on_message(self._handle_relay_message)
        self._started = True

    async def stop(self) -> None:
        """Disconnect from Relay and clean up."""
        self._started = False
        await self.relay.__aexit__(None, None, None)
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    async def discover_agent(self) -> A2AAgentCard:
        """Fetch the external A2A agent's Agent Card."""
        session = await self._ensure_session()
        url = f"{self.a2a_agent_url}/.well-known/agent.json"
        async with session.get(url) as resp:
            data = await resp.json()
        self._agent_card = A2AAgentCard(
            name=data.get("name", ""),
            description=data.get("description", ""),
            url=data.get("url", self.a2a_agent_url),
            version=data.get("version", "1.0.0"),
        )
        return self._agent_card

    async def send_a2a_message(self, text: str) -> str | None:
        """Send a message/send JSON-RPC call to the external A2A agent.

        Returns the response text if available.
        """
        session = await self._ensure_session()

        a2a_msg = {
            "role": "user",
            "parts": [{"text": text}],
            "messageId": str(uuid.uuid4()),
        }

        jsonrpc_request = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {"message": a2a_msg},
            "id": str(uuid.uuid4()),
        }

        target_url = self.a2a_agent_url
        if self._agent_card and self._agent_card.url:
            target_url = self._agent_card.url

        async with session.post(target_url, json=jsonrpc_request) as resp:
            data = await resp.json()

        result = data.get("result", {})
        # Extract response text from the task
        status = result.get("status", {})
        status_msg = status.get("message", {})
        parts = status_msg.get("parts", [])
        if parts:
            return parts[0].get("text")

        # Try from messages list
        messages = result.get("messages", [])
        for msg in reversed(messages):
            if msg.get("role") == "agent":
                msg_parts = msg.get("parts", [])
                if msg_parts:
                    return msg_parts[0].get("text")

        return None

    async def _handle_relay_message(self, msg: Message) -> None:
        """Forward Relay message to A2A agent, then forward response back."""
        response_text = await self.send_a2a_message(msg.text)
        if response_text:
            await self.relay.send(msg.sender, response_text)

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def __aenter__(self) -> "A2ABridge":
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.stop()


__all__ = ["A2ABridge"]
