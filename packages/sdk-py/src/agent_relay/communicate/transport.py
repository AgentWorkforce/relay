"""HTTP and WebSocket transport for communicate mode."""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from inspect import isawaitable
from typing import Any

import aiohttp
from aiohttp import WSMsgType

from .types import (
    DEFAULT_RELAY_BASE_URL,
    Message,
    MessageCallback,
    RelayAuthError,
    RelayConfig,
    RelayConfigError,
    RelayConnectionError,
)

HTTP_RETRY_ATTEMPTS = 3
WS_RECONNECT_MAX_DELAY = 30


class RelayTransport:
    """Minimal Relaycast transport backed by aiohttp."""

    def __init__(self, agent_name: str, config: RelayConfig) -> None:
        self.agent_name = agent_name
        self.config = config
        self.agent_id: str | None = None
        self.token: str | None = None

        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._ws_task: asyncio.Task[None] | None = None
        self._message_callback: MessageCallback | None = None
        self._closing = False

    async def connect(self) -> None:
        self._require_config(require_workspace=True)
        self._closing = False

        await self.register_agent()
        await self._connect_websocket()

        if self._ws_task is None or self._ws_task.done():
            self._ws_task = asyncio.create_task(self._ws_loop())

    async def disconnect(self) -> None:
        self._closing = True

        ws_task = self._ws_task
        self._ws_task = None

        ws = self._ws
        self._ws = None
        if ws is not None and not ws.closed:
            with suppress(Exception):
                await ws.close()

        if ws_task is not None and not ws_task.done():
            ws_task.cancel()
            with suppress(asyncio.CancelledError):
                await ws_task

        with suppress(Exception):
            await self.unregister_agent()

        await self._close_session()
        self._closing = False

    async def send_http(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        self._require_config()
        session = await self._ensure_session()
        url = f"{self._base_url()}{path}"
        headers = {"Authorization": f"Bearer {self.config.api_key}"}

        for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
            try:
                async with session.request(method, url, json=payload, headers=headers) as response:
                    if response.status == 401:
                        raise RelayAuthError(await self._error_message(response))

                    if 500 <= response.status <= 599:
                        message = await self._error_message(response)
                        if attempt < HTTP_RETRY_ATTEMPTS:
                            await asyncio.sleep(min(2 ** (attempt - 1), WS_RECONNECT_MAX_DELAY))
                            continue
                        raise RelayConnectionError(response.status, message)

                    if response.status >= 400:
                        raise RelayConnectionError(
                            response.status,
                            await self._error_message(response),
                        )

                    if response.status == 204:
                        return None

                    if response.content_type == "application/json":
                        return await response.json()

                    return await response.text()
            except RelayAuthError:
                raise
            except RelayConnectionError:
                raise
            except aiohttp.ClientError as exc:
                raise RelayConnectionError(0, str(exc)) from exc

        raise RelayConnectionError(500, "Unexpected transport retry failure")

    def on_ws_message(self, callback: MessageCallback) -> None:
        self._message_callback = callback

    async def register_agent(self) -> str:
        self._require_config(require_workspace=True)

        if self.agent_id is not None and self.token is not None:
            return self.agent_id

        payload = await self.send_http(
            "POST",
            "/v1/agents/register",
            payload={"name": self.agent_name, "workspace": self.config.workspace},
        )
        self.agent_id = payload["agent_id"]
        self.token = payload["token"]
        return self.agent_id

    async def unregister_agent(self) -> None:
        if self.agent_id is None:
            await self._close_session_if_idle()
            return

        agent_id = self.agent_id
        await self.send_http("DELETE", f"/v1/agents/{agent_id}")
        self.agent_id = None
        self.token = None
        await self._close_session_if_idle()

    async def send_dm(self, recipient: str, text: str) -> str:
        await self._ensure_registered()
        payload = await self.send_http(
            "POST",
            "/v1/messages/dm",
            payload={"to": recipient, "text": text, "from": self.agent_name},
        )
        return payload["message_id"]

    async def post_message(self, channel: str, text: str) -> str:
        await self._ensure_registered()
        payload = await self.send_http(
            "POST",
            "/v1/messages/channel",
            payload={"channel": channel, "text": text, "from": self.agent_name},
        )
        return payload["message_id"]

    async def reply(self, message_id: str, text: str) -> str:
        await self._ensure_registered()
        payload = await self.send_http(
            "POST",
            "/v1/messages/reply",
            payload={"message_id": message_id, "text": text, "from": self.agent_name},
        )
        return payload["message_id"]

    async def check_inbox(self) -> list[Message]:
        await self._ensure_registered()
        payload = await self.send_http("GET", f"/v1/inbox/{self.agent_id}")
        return [self._message_from_payload(item) for item in payload.get("messages", [])]

    async def list_agents(self) -> list[str]:
        payload = await self.send_http("GET", "/v1/agents")
        return list(payload.get("agents", []))

    async def _ensure_registered(self) -> None:
        if self.agent_id is None or self.token is None:
            await self.register_agent()

    def _require_config(self, *, require_workspace: bool = False) -> None:
        if not self.config.api_key:
            raise RelayConfigError(
                "Missing RELAY_API_KEY. Set the environment variable or pass api_key= to RelayConfig."
            )
        if require_workspace and not self.config.workspace:
            raise RelayConfigError(
                "Missing RELAY_WORKSPACE. Set the environment variable or pass workspace= to RelayConfig."
            )

    def _base_url(self) -> str:
        return (self.config.base_url or DEFAULT_RELAY_BASE_URL).rstrip("/")

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _close_session(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _close_session_if_idle(self) -> None:
        if self._ws_task is None and (self._ws is None or self._ws.closed):
            await self._close_session()

    async def _connect_websocket(self) -> None:
        await self._ensure_registered()

        if self._ws is not None and not self._ws.closed:
            return

        session = await self._ensure_session()
        ws_url = f"{self._ws_base_url()}/v1/ws/{self.agent_id}?token={self.token}"
        self._ws = await session.ws_connect(ws_url)

    def _ws_base_url(self) -> str:
        base_url = self._base_url()
        if base_url.startswith("https://"):
            return "wss://" + base_url[len("https://") :]
        if base_url.startswith("http://"):
            return "ws://" + base_url[len("http://") :]
        return base_url

    async def _ws_loop(self) -> None:
        delay = 1

        while not self._closing:
            try:
                if self._ws is None:
                    await self._connect_websocket()

                assert self._ws is not None
                async for raw_message in self._ws:
                    if raw_message.type is WSMsgType.TEXT:
                        await self._dispatch_ws_payload(raw_message.data)
                    elif raw_message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                        break
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            finally:
                if self._ws is not None and self._ws.closed:
                    self._ws = None

            if self._closing:
                break

            await asyncio.sleep(delay)
            delay = min(delay * 2, WS_RECONNECT_MAX_DELAY)

            try:
                await self._connect_websocket()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception:
                continue

    async def _dispatch_ws_payload(self, raw_payload: str) -> None:
        payload = json.loads(raw_payload)
        if payload.get("type") == "ping":
            if self._ws is not None and not self._ws.closed:
                await self._ws.send_json({"type": "pong"})
            return
        if payload.get("type") != "message":
            return

        callback = self._message_callback
        if callback is None:
            return

        result = callback(self._message_from_payload(payload))
        if isawaitable(result):
            await result

    @staticmethod
    def _message_from_payload(payload: dict[str, Any]) -> Message:
        return Message(
            sender=payload["sender"],
            text=payload["text"],
            channel=payload.get("channel"),
            thread_id=payload.get("thread_id"),
            timestamp=payload.get("timestamp"),
            message_id=payload.get("message_id"),
        )

    @staticmethod
    async def _error_message(response: aiohttp.ClientResponse) -> str:
        try:
            payload = await response.json()
        except Exception:
            text = await response.text()
            return text or response.reason or "Request failed"
        return str(payload.get("message") or response.reason or "Request failed")


__all__ = ["RelayTransport"]
