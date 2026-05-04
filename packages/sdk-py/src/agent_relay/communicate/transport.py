"""HTTP and WebSocket transport for communicate mode."""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from inspect import isawaitable
from typing import Any
from urllib.parse import quote

try:
    import aiohttp
    from aiohttp import WSMsgType
except ImportError:
    raise ImportError(
        "Communicate mode requires 'aiohttp'. "
        "Install it with: pip install agent-relay-sdk[communicate]"
    )

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
    """Minimal Relaycast transport backed by aiohttp.

    Auth model: the workspace API key is used for admin operations (registering
    agents, listing agents); the per-agent token is used for everything an
    agent does (post, reply, dm, websocket).
    """

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
                try:
                    await asyncio.wait_for(ws.close(), timeout=2)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass

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
        as_agent: bool = False,
        retry: bool = True,
    ) -> Any:
        """Send a request and return the unwrapped ``data`` field on success.

        Set ``as_agent=True`` to authenticate with the per-agent token
        (required for any operation that posts as the agent). Set
        ``retry=False`` for best-effort calls (cleanup paths) where waiting
        out the exponential backoff would block shutdown.
        """
        self._require_config()
        session = await self._ensure_session()
        url = f"{self._base_url()}{path}"

        if as_agent:
            if not self.token:
                raise RelayConnectionError(401, "Agent not registered; no token available.")
            bearer = self.token
        else:
            bearer = self.config.api_key
        headers = {"Authorization": f"Bearer {bearer}"}

        max_attempts = HTTP_RETRY_ATTEMPTS if retry else 1
        for attempt in range(1, max_attempts + 1):
            try:
                async with session.request(method, url, json=payload, headers=headers) as response:
                    if response.status == 401:
                        raise RelayAuthError(await self._error_message(response))

                    if 500 <= response.status <= 599:
                        message = await self._error_message(response)
                        if attempt < max_attempts:
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
                        body = await response.json()
                        return self._unwrap(body)

                    return await response.text()
            except RelayAuthError:
                raise
            except RelayConnectionError:
                raise
            except aiohttp.ClientError as exc:
                if attempt < max_attempts:
                    await asyncio.sleep(min(2 ** (attempt - 1), WS_RECONNECT_MAX_DELAY))
                    continue
                raise RelayConnectionError(0, str(exc)) from exc

        raise RelayConnectionError(500, "Unexpected transport retry failure")

    def on_ws_message(self, callback: MessageCallback) -> None:
        self._message_callback = callback

    async def register_agent(self) -> str:
        self._require_config(require_workspace=True)

        if self.agent_id is not None and self.token is not None:
            return self.agent_id

        data = await self.send_http(
            "POST",
            "/v1/agents",
            payload={"name": self.agent_name, "type": "agent"},
        )
        self.agent_id = data["id"]
        self.token = data["token"]
        return self.agent_id

    async def unregister_agent(self) -> None:
        if self.agent_id is None:
            await self._close_session_if_idle()
            return

        await self.send_http(
            "DELETE",
            f"/v1/agents/{quote(self.agent_name, safe='')}",
            retry=False,
        )
        self.agent_id = None
        self.token = None
        await self._close_session_if_idle()

    async def send_dm(self, recipient: str, text: str) -> str:
        await self._ensure_registered()
        data = await self.send_http(
            "POST",
            "/v1/dm",
            payload={"to": recipient, "text": text},
            as_agent=True,
        )
        # The hosted API returns the DM envelope; the message id is on the
        # top-level ``id`` and also on ``message.id``.
        if isinstance(data, dict):
            if "id" in data:
                return data["id"]
            inner = data.get("message")
            if isinstance(inner, dict) and "id" in inner:
                return inner["id"]
        raise RelayConnectionError(500, "DM response missing message id")

    async def post_message(self, channel: str, text: str) -> str:
        await self._ensure_registered()
        data = await self.send_http(
            "POST",
            f"/v1/channels/{quote(channel, safe='')}/messages",
            payload={"text": text},
            as_agent=True,
        )
        return data["id"]

    async def reply(self, message_id: str, text: str) -> str:
        await self._ensure_registered()
        data = await self.send_http(
            "POST",
            f"/v1/messages/{quote(message_id, safe='')}/replies",
            payload={"text": text},
            as_agent=True,
        )
        return data["id"]

    async def check_inbox(self) -> list[Message]:
        """Polling fallback for environments where the WebSocket cannot connect.

        Prefer surfacing any deliverable messages returned by ``/v1/inbox``.
        Some deployments may only expose unread metadata; in that case this
        method returns an empty list instead of raising.
        """
        await self._ensure_registered()
        data = await self.send_http("GET", "/v1/inbox", as_agent=True)

        if not isinstance(data, dict):
            return []

        raw_messages = data.get("messages")
        if not isinstance(raw_messages, list):
            return []

        messages: list[Message] = []
        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            messages.append(
                Message(
                    sender=item.get("sender") or item.get("agent_name") or item.get("from") or "unknown",
                    text=item.get("text") or "",
                    channel=item.get("channel"),
                    thread_id=item.get("thread_id"),
                    timestamp=item.get("timestamp"),
                    message_id=item.get("message_id") or item.get("id"),
                )
            )

        return messages

    async def list_agents(self) -> list[str]:
        data = await self.send_http("GET", "/v1/agents")
        if isinstance(data, list):
            return [item["name"] for item in data if isinstance(item, dict) and "name" in item]
        return []

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

    @staticmethod
    def _unwrap(body: Any) -> Any:
        """Unwrap the ``{ok, data, error}`` envelope used by the hosted API.

        Mock servers that return a plain payload pass through unchanged.
        """
        if isinstance(body, dict) and "ok" in body:
            if not body.get("ok", False):
                error = body.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                raise RelayConnectionError(400, message or "Request failed")
            return body.get("data")
        return body

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
        ws_url = f"{self._ws_base_url()}/v1/ws?token={quote(self.token, safe='')}"
        self._ws = await session.ws_connect(ws_url)

        # Subscribe to channels declared on the config so message.created
        # events for those channels are delivered to this socket.
        channels = list(self.config.channels or [])
        if channels:
            await self._ws.send_json({"type": "subscribe", "channels": channels})

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
        if not isinstance(payload, dict):
            return

        event_type = payload.get("type")
        if event_type == "ping":
            if self._ws is not None and not self._ws.closed:
                await self._ws.send_json({"type": "pong"})
            return

        message = self._message_from_event(payload)
        if message is None:
            return

        callback = self._message_callback
        if callback is None:
            return

        result = callback(message)
        if isawaitable(result):
            await result

    @staticmethod
    def _message_from_event(payload: dict[str, Any]) -> Message | None:
        """Translate a hosted WebSocket event into the SDK's flat ``Message``.

        Recognises ``message.created``, ``thread.reply``, ``dm.received``,
        and ``group_dm.received``. Falls back to the flat
        ``{type:"message", sender, text}`` shape the mock server emits.
        """
        event_type = payload.get("type")

        if event_type in {"message.created", "thread.reply", "dm.received", "group_dm.received"}:
            inner = payload.get("message")
            if not isinstance(inner, dict):
                return None
            sender = inner.get("agent_name") or inner.get("agent_id") or ""
            text = inner.get("text", "")
            channel = payload.get("channel")
            thread_id = payload.get("parent_id") or inner.get("thread_id")
            message_id = inner.get("id")
            timestamp = inner.get("created_at") or inner.get("timestamp")
            return Message(
                sender=sender,
                text=text,
                channel=channel,
                thread_id=thread_id,
                timestamp=timestamp,
                message_id=message_id,
            )

        if event_type == "message" and "sender" in payload:
            return Message(
                sender=payload["sender"],
                text=payload.get("text", ""),
                channel=payload.get("channel"),
                thread_id=payload.get("thread_id"),
                timestamp=payload.get("timestamp"),
                message_id=payload.get("message_id"),
            )

        return None

    @staticmethod
    async def _error_message(response: aiohttp.ClientResponse) -> str:
        try:
            payload = await response.json()
        except Exception:
            text = await response.text()
            return text or response.reason or "Request failed"
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if payload.get("message"):
                return str(payload["message"])
        return str(response.reason or "Request failed")


__all__ = ["RelayTransport"]
