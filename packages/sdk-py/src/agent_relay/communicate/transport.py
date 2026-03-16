"""HTTP and WebSocket transport for communicate mode."""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from inspect import isawaitable
from typing import Any

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
                if attempt < HTTP_RETRY_ATTEMPTS:
                    await asyncio.sleep(min(2 ** (attempt - 1), WS_RECONNECT_MAX_DELAY))
                    continue
                raise RelayConnectionError(0, str(exc)) from exc

        raise RelayConnectionError(500, "Unexpected transport retry failure")

    def on_ws_message(self, callback: MessageCallback) -> None:
        self._message_callback = callback

    async def register_agent(self) -> str:
        """Register agent, or rotate token if it already exists (registerOrRotate pattern)."""
        self._require_config(require_workspace=True)

        if self.agent_id is not None and self.token is not None:
            return self.agent_id

        try:
            payload = await self.send_http(
                "POST",
                "/v1/agents",
                payload={"name": self.agent_name, "type": "agent"},
            )
        except RelayConnectionError as exc:
            if exc.status_code == 409:
                # Agent already exists — get its info and rotate the token
                from urllib.parse import quote
                agent_payload = await self.send_http(
                    "GET",
                    f"/v1/agents/{quote(self.agent_name, safe='')}",
                )
                agent_data = agent_payload.get("data", agent_payload)
                self.agent_id = agent_data["id"]

                rotate_payload = await self.send_http(
                    "POST",
                    f"/v1/agents/{quote(self.agent_name, safe='')}/rotate-token",
                )
                rotate_data = rotate_payload.get("data", rotate_payload)
                self.token = rotate_data["token"]
                return self.agent_id
            raise
        # Relaycast API wraps in {ok, data: {...}}
        data = payload.get("data", payload)
        self.agent_id = data["id"]
        self.token = data["token"]
        return self.agent_id

    async def unregister_agent(self) -> None:
        if self.agent_id is None or self.token is None:
            await self._close_session_if_idle()
            return

        await self._send_http_as_agent("POST", "/v1/agents/disconnect")
        self.agent_id = None
        self.token = None
        await self._close_session_if_idle()

    async def send_dm(self, recipient: str, text: str) -> str:
        await self._ensure_registered()
        payload = await self._send_http_as_agent(
            "POST",
            "/v1/dm",
            payload={"to": recipient, "text": text},
        )
        if payload is None:
            return ""
        data = payload.get("data", payload)
        return data.get("id", data.get("message_id", ""))

    async def post_message(self, channel: str, text: str) -> str:
        await self._ensure_registered()
        from urllib.parse import quote

        payload = await self._send_http_as_agent(
            "POST",
            f"/v1/channels/{quote(channel, safe='')}/messages",
            payload={"text": text},
        )
        if payload is None:
            return ""
        data = payload.get("data", payload)
        return data.get("id", data.get("message_id", ""))

    async def reply(self, message_id: str, text: str) -> str:
        await self._ensure_registered()
        from urllib.parse import quote

        payload = await self._send_http_as_agent(
            "POST",
            f"/v1/messages/{quote(message_id, safe='')}/replies",
            payload={"text": text},
        )
        if payload is None:
            return ""
        data = payload.get("data", payload)
        return data.get("id", data.get("message_id", ""))


    async def join_channel(self, channel: str) -> None:
        await self._ensure_registered()
        from urllib.parse import quote
        await self._send_http_as_agent(
            'POST',
            f'/v1/channels/{quote(channel, safe="")}/join',
        )

    async def check_inbox(self) -> list[Message]:
        await self._ensure_registered()
        from urllib.parse import quote

        payload = await self._send_http_as_agent("GET", "/v1/inbox")
        data = payload.get("data", payload)
        messages: list[Message] = []

        # Fetch unread DM conversations
        for dm in data.get("unread_dms", []):
            conv_id = dm.get("conversation_id", "")
            sender = dm.get("from", "unknown")
            # Fetch actual messages from the conversation
            try:
                conv_payload = await self._send_http_as_agent(
                    "GET", f"/v1/dm/{quote(conv_id, safe='')}/messages"
                )
                conv_data = conv_payload.get("data", conv_payload)
                items = conv_data if isinstance(conv_data, list) else []
                for item in items:
                    messages.append(Message(
                        sender=item.get("agent_name", sender),
                        text=item.get("text", ""),
                        channel=None,
                        thread_id=conv_id,
                        timestamp=item.get("created_at"),
                        message_id=item.get("id"),
                    ))
            except Exception:
                # Fall back to the summary last_message
                last = dm.get("last_message", {})
                if last.get("text"):
                    messages.append(Message(
                        sender=sender,
                        text=last["text"],
                        channel=None,
                        thread_id=conv_id,
                        timestamp=last.get("created_at"),
                        message_id=last.get("id"),
                    ))

        # Also include unread channel mentions
        for mention in data.get("mentions", []):
            messages.append(Message(
                sender=mention.get("from", mention.get("agent_name", "unknown")),
                text=mention.get("text", ""),
                channel=mention.get("channel_name"),
                thread_id=mention.get("thread_id"),
                timestamp=mention.get("created_at"),
                message_id=mention.get("id"),
            ))

        return messages

    async def list_agents(self) -> list[str]:
        payload = await self.send_http("GET", "/v1/agents")
        data = payload.get("data", payload)
        if isinstance(data, list):
            return [a.get("name", a) if isinstance(a, dict) else a for a in data]
        return list(data.get("agents", []))

    async def _send_http_as_agent(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        """Like send_http but authenticates with the per-agent token."""
        await self._ensure_registered()
        session = await self._ensure_session()
        url = f"{self._base_url()}{path}"
        headers = {"Authorization": f"Bearer {self.token}"}

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
            except (RelayAuthError, RelayConnectionError):
                raise
            except aiohttp.ClientError as exc:
                if attempt < HTTP_RETRY_ATTEMPTS:
                    await asyncio.sleep(min(2 ** (attempt - 1), WS_RECONNECT_MAX_DELAY))
                    continue
                raise RelayConnectionError(0, str(exc)) from exc

        raise RelayConnectionError(500, "Unexpected transport retry failure")

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

        from urllib.parse import quote

        session = await self._ensure_session()
        ws_url = f"{self._ws_base_url()}/v1/ws?token={quote(self.token, safe='')}"
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
        event_type = payload.get("type", "")

        if event_type == "ping":
            if self._ws is not None and not self._ws.closed:
                await self._ws.send_json({"type": "pong"})
            return

        # Accept message.created, dm.received, direct_message.received, thread.reply, and legacy "message"
        message_events = {"message.created", "dm.received", "direct_message.received",
                          "thread.reply", "message", "group_dm.received"}
        if event_type not in message_events:
            return

        callback = self._message_callback
        if callback is None:
            return

        try:
            msg = self._message_from_payload(payload)
        except (KeyError, TypeError):
            return

        result = callback(msg)
        if isawaitable(result):
            await result

    @staticmethod
    def _message_from_payload(payload: dict[str, Any]) -> Message:
        # Support both flat and nested message structures
        m = payload.get("message") if isinstance(payload.get("message"), dict) else payload
        sender = (
            m.get("sender")
            or m.get("agent_name")
            or m.get("from")
            or m.get("agentName")
            or payload.get("agent_name")
            or payload.get("from")
            or "unknown"
        )
        text = m.get("text", "")
        channel = m.get("channel") or m.get("channel_name") or m.get("channelName") or payload.get("channel") or payload.get("channel_name")
        thread_id = m.get("thread_id") or m.get("threadId") or m.get("conversation_id") or m.get("conversationId") or payload.get("thread_id")
        timestamp = m.get("timestamp") or m.get("created_at") or m.get("createdAt") or payload.get("timestamp")
        message_id = m.get("id") or m.get("message_id") or m.get("messageId") or payload.get("message_id")

        return Message(
            sender=sender,
            text=text,
            channel=channel,
            thread_id=thread_id,
            timestamp=timestamp,
            message_id=message_id,
        )

    @staticmethod
    async def _error_message(response: aiohttp.ClientResponse) -> str:
        try:
            payload = await response.json()
        except Exception:
            text = await response.text()
            return text or response.reason or "Request failed"
        # Relaycast wraps errors as {ok: false, error: {code, message}}
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        return str(payload.get("message") or response.reason or "Request failed")


__all__ = ["RelayTransport"]
