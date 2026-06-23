"""Hosted-engine transport for communicate mode.

This is a thin wrapper around the published ``relaycast-sdk`` (PyPI package
``relaycast-sdk``, import module ``relay_sdk``). The hand-rolled aiohttp HTTP/WS
client that used to live here has been replaced by calls into ``relay_sdk`` so
the SDK owns the wire protocol (envelope unwrap, 5xx retry, auth errors, the
WebSocket lifecycle). RelayTransport keeps the same public surface so callers in
``communicate.core`` and the framework adapters are unaffected.

Auth model (unchanged): the workspace API key drives admin operations
(registering/listing/deleting agents) via ``AsyncRelay``; the per-agent token
drives everything an agent does (post, reply, dm, inbox, websocket) via the
``AsyncAgentClient`` returned by ``relay.as_agent(token)``.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from inspect import isawaitable
from typing import Any
from urllib.parse import quote

try:
    from relay_sdk import AsyncRelay, RelayError, WsClient
    from relay_sdk.agent import AsyncAgentClient
except ImportError as exc:  # pragma: no cover - exercised via install matrix
    raise ImportError(
        "Communicate mode requires 'relaycast-sdk'. "
        "Install it with: pip install agent-relay-sdk[communicate]"
    ) from exc

from .types import (
    DEFAULT_RELAY_BASE_URL,
    Message,
    MessageCallback,
    RelayAuthError,
    RelayConfig,
    RelayConfigError,
    RelayConnectionError,
)

logger = logging.getLogger(__name__)

# Events emitted by the hosted gateway that carry a deliverable message.
_MESSAGE_EVENTS = ("message.created", "thread.reply", "dm.received", "group_dm.received")


def _translate_error(exc: RelayError) -> RelayConnectionError:
    """Map a relay_sdk ``RelayError`` onto the SDK's public error types."""
    status = getattr(exc, "status", 0) or 0
    message = str(exc)
    if status == 401:
        return RelayAuthError(message)
    return RelayConnectionError(status, message)


class RelayTransport:
    """Relaycast transport backed by the published ``relay_sdk`` client.

    Public surface (method signatures and the ``agent_id`` / ``token``
    attributes) is preserved so ``communicate.core`` and the framework adapters
    keep working without changes.
    """

    def __init__(self, agent_name: str, config: RelayConfig) -> None:
        self.agent_name = agent_name
        self.config = config
        self.agent_id: str | None = None
        self.token: str | None = None

        self._relay: AsyncRelay | None = None
        self._agent: AsyncAgentClient | None = None
        self._ws: WsClient | None = None
        self._ws_task: asyncio.Task[None] | None = None
        self._ws_open: asyncio.Event | None = None
        self._message_callback: MessageCallback | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closing = False
        # Strong references to fire-and-forget tasks (pong replies, async
        # message callbacks). asyncio only weakly references tasks, so without
        # this they could be garbage-collected before they run.
        self._pending_tasks: set[asyncio.Task[Any]] = set()

    def _track(self, coro: Any) -> asyncio.Task[Any]:
        """Schedule a coroutine and retain a strong reference until it finishes."""
        task = asyncio.ensure_future(coro)
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)
        return task

    # -- Lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        self._require_config(require_workspace=True)
        self._closing = False

        await self.register_agent()
        await self._connect_websocket()

    async def disconnect(self) -> None:
        self._closing = True

        ws = self._ws
        self._ws = None
        if ws is not None:
            with suppress(Exception):
                ws.disconnect()

        ws_task = self._ws_task
        self._ws_task = None
        if ws_task is not None and not ws_task.done():
            ws_task.cancel()
            with suppress(asyncio.CancelledError):
                await ws_task

        # Close the agent's HTTP client before unregister_agent() clears the
        # reference, otherwise the underlying httpx.AsyncClient is leaked. The
        # workspace relay client is kept alive because unregister_agent() still
        # needs it to issue the cleanup DELETE.
        await self._close_agent_client()

        with suppress(Exception):
            await self.unregister_agent()

        await self._close_clients()
        self._closing = False

    # -- Admin (workspace key) --------------------------------------------

    async def register_agent(self) -> str:
        self._require_config(require_workspace=True)

        if self.agent_id is not None and self.token is not None:
            return self.agent_id

        relay = self._ensure_relay()
        try:
            created = await relay.agents.register(self.agent_name, type="agent")
        except RelayError as exc:
            raise _translate_error(exc) from exc

        self.agent_id = created.id
        self.token = created.token
        self._agent = relay.as_agent(self.token)
        return self.agent_id

    async def unregister_agent(self) -> None:
        if self.agent_id is None:
            return

        relay = self._ensure_relay()
        # relay_sdk's agents namespace has no delete(); use the client escape
        # hatch to issue DELETE /v1/agents/{name}. This is a best-effort cleanup
        # path, so swallow any error (including the empty-body decode error
        # relay_sdk raises when the server replies 204 No Content).
        # Percent-encode the name so reserved characters (e.g. '/', '?', '#')
        # don't alter the route and silently leave the agent registered.
        encoded_name = quote(self.agent_name, safe="")
        try:
            await relay._client.delete(f"/v1/agents/{encoded_name}")
        except Exception as exc:  # noqa: BLE001 - best-effort cleanup
            # Log so a genuine server-side failure (e.g. the agent was not
            # actually removed) is visible, then continue: this is best-effort.
            logger.debug("Best-effort agent unregister failed for %r: %s", self.agent_name, exc)

        self.agent_id = None
        self.token = None
        self._agent = None

    async def list_agents(self) -> list[str]:
        relay = self._ensure_relay()
        try:
            agents = await relay.agents.list()
        except RelayError as exc:
            raise _translate_error(exc) from exc
        return [agent.name for agent in agents]

    # -- Agent operations (per-agent token) -------------------------------

    async def send_dm(self, recipient: str, text: str) -> str:
        agent = await self._ensure_agent()
        try:
            data = await agent.dm(recipient, text)
        except RelayError as exc:
            raise _translate_error(exc) from exc
        return self._message_id_from_dm(data)

    async def post_message(self, channel: str, text: str) -> str:
        agent = await self._ensure_agent()
        try:
            message = await agent.send(channel, text)
        except RelayError as exc:
            raise _translate_error(exc) from exc
        return message.id

    async def reply(self, message_id: str, text: str) -> str:
        agent = await self._ensure_agent()
        try:
            message = await agent.reply(message_id, text)
        except RelayError as exc:
            raise _translate_error(exc) from exc
        return message.id

    async def check_inbox(self) -> list[Message]:
        """Polling fallback for environments where the WebSocket cannot connect.

        relay_sdk's ``AgentClient.inbox()`` returns the typed ``InboxResponse``
        (unread metadata only), which intentionally drops the deliverable
        ``messages`` array some deployments include. To preserve the previous
        behaviour we read the raw ``/v1/inbox`` payload through the agent's HTTP
        client (which still performs envelope unwrap / retry / auth handling)
        and surface any deliverable messages it carries.
        """
        agent = await self._ensure_agent()
        try:
            data = await agent.client.get("/v1/inbox")
        except RelayError as exc:
            raise _translate_error(exc) from exc

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
                    sender=item.get("sender")
                    or item.get("agent_name")
                    or item.get("from")
                    or "unknown",
                    text=item.get("text") or "",
                    channel=item.get("channel"),
                    thread_id=item.get("thread_id"),
                    timestamp=item.get("timestamp"),
                    message_id=item.get("message_id") or item.get("id"),
                )
            )

        return messages

    # -- Escape hatch ------------------------------------------------------

    async def send_http(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        as_agent: bool = False,
        retry: bool = True,  # noqa: ARG002 - retry is owned by relay_sdk now
    ) -> Any:
        """Issue a raw request through relay_sdk's HTTP client.

        Kept for backwards compatibility. ``as_agent=True`` routes through the
        per-agent client; otherwise the workspace client is used. Envelope
        unwrap, 5xx retry and auth handling all happen inside relay_sdk.
        """
        if as_agent:
            agent = await self._ensure_agent()
            client = agent.client
        else:
            self._require_config()
            client = self._ensure_relay()._client

        method_upper = method.upper()
        try:
            if method_upper == "GET":
                return await client.get(path)
            if method_upper == "POST":
                return await client.post(path, payload)
            if method_upper == "PATCH":
                return await client.patch(path, payload)
            if method_upper == "DELETE":
                return await client.delete(path)
            return await client.request(method_upper, path, body=payload)
        except RelayError as exc:
            raise _translate_error(exc) from exc

    # -- WebSocket ---------------------------------------------------------

    def on_ws_message(self, callback: MessageCallback) -> None:
        self._message_callback = callback

    async def _connect_websocket(self) -> None:
        await self._ensure_registered()

        if self._ws is not None:
            return

        assert self.token is not None
        ws = WsClient(self.token, base_url=self._base_url())

        # Subscribe to declared channels so message.created events for those
        # channels are delivered to this socket.
        channels = list(self.config.channels or [])
        if channels:
            ws.subscribe(channels)

        for event in _MESSAGE_EVENTS:
            ws.on(event, self._on_ws_event)
        # The hosted mock and some deployments emit a flat {"type":"message"}
        # frame; handle it too.
        ws.on("message", self._on_ws_event)
        # relay_sdk's WsClient has no built-in pong-on-server-ping; keep a
        # minimal workaround so server keepalive pings are answered.
        ws.on("ping", self._on_ws_ping)

        loop = asyncio.get_running_loop()
        self._ws_open = asyncio.Event()
        ws.on("open", self._on_ws_open)

        self._ws = ws
        self._loop = loop
        self._ws_task = loop.create_task(self._ws_run())

        # WsClient.connect() blocks for the socket's lifetime, so we run it in
        # the background. Wait for the first "open" so callers (and tests) can
        # rely on the socket being live once connect() returns.
        #
        # Crucially we must distinguish "opened then later closed" from "never
        # opened": if the socket never opens (endpoint blocked/unavailable, or
        # connect() errors out before emitting "open"), connect() must NOT
        # report a connected state. We tear the socket down and raise so the
        # caller (Relay._ensure_connected) falls back to HTTP polling — the
        # exact no-WebSocket environment the fallback exists for. Once "open"
        # has fired, a subsequent close is normal lifecycle and handled by
        # WsClient's own reconnect logic, so we treat connect() as successful.
        open_wait = asyncio.ensure_future(self._ws_open.wait())
        ws_task = self._ws_task
        done, _pending = await asyncio.wait(
            {open_wait, ws_task},
            timeout=5,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if not self._ws_open.is_set():
            # Either the wait timed out or _ws_run() finished before the socket
            # ever opened. Cancel our wait helper, tear the socket down, and
            # signal failure so the caller can fall back to polling.
            open_wait.cancel()
            with suppress(asyncio.CancelledError):
                await open_wait
            await self._teardown_failed_websocket()
            raise RelayConnectionError(0, "WebSocket failed to open")

        if open_wait not in done:
            open_wait.cancel()
            with suppress(asyncio.CancelledError):
                await open_wait

    async def _teardown_failed_websocket(self) -> None:
        ws = self._ws
        self._ws = None
        if ws is not None:
            with suppress(Exception):
                ws.disconnect()

        ws_task = self._ws_task
        self._ws_task = None
        if ws_task is not None and not ws_task.done():
            ws_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await ws_task
        self._ws_open = None

    async def _ws_run(self) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.connect()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    def _on_ws_open(self, _payload: dict[str, Any]) -> None:
        event = self._ws_open
        if event is not None:
            event.set()

    def _on_ws_ping(self, _payload: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        # _send_json is the only send primitive WsClient exposes; schedule a
        # pong on the running loop. Retain a strong reference via _track so the
        # task isn't garbage-collected before it sends.
        with suppress(Exception):
            self._track(ws._send_json({"type": "pong"}))

    def _on_ws_event(self, payload: dict[str, Any]) -> None:
        message = self._message_from_event(payload)
        if message is None:
            return

        callback = self._message_callback
        if callback is None:
            return

        result = callback(message)
        if isawaitable(result):
            # WsClient invokes handlers synchronously; schedule the coroutine
            # and keep a strong reference (via _track) so it isn't GC'd
            # mid-flight, which would intermittently drop delivered messages.
            self._track(result)

    @staticmethod
    def _message_from_event(payload: dict[str, Any]) -> Message | None:
        """Translate a hosted WebSocket event into the SDK's flat ``Message``.

        Recognises ``message.created``, ``thread.reply``, ``dm.received`` and
        ``group_dm.received``. Falls back to the flat
        ``{type:"message", sender, text}`` shape the mock server emits.
        """
        event_type = payload.get("type")

        if event_type in _MESSAGE_EVENTS:
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

    # -- Helpers -----------------------------------------------------------

    def _ensure_relay(self) -> AsyncRelay:
        if self._relay is None:
            self._require_config()
            assert self.config.api_key is not None
            self._relay = AsyncRelay(self.config.api_key, base_url=self._base_url())
        return self._relay

    async def _ensure_registered(self) -> None:
        if self.agent_id is None or self.token is None:
            await self.register_agent()

    async def _ensure_agent(self) -> AsyncAgentClient:
        await self._ensure_registered()
        if self._agent is None:
            assert self.token is not None
            self._agent = self._ensure_relay().as_agent(self.token)
        return self._agent

    async def _close_agent_client(self) -> None:
        agent = self._agent
        self._agent = None
        if agent is not None:
            with suppress(Exception):
                await agent.client.close()

    async def _close_clients(self) -> None:
        await self._close_agent_client()

        relay = self._relay
        self._relay = None
        if relay is not None:
            with suppress(Exception):
                await relay.close()

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
        # Preserve relay's configured host (defaults to api.relaycast.dev) and
        # pass it explicitly into relay_sdk so its own default host is never used.
        return (self.config.base_url or DEFAULT_RELAY_BASE_URL).rstrip("/")

    @staticmethod
    def _message_id_from_dm(data: Any) -> str:
        """Extract the message id from a DM response payload."""
        if isinstance(data, dict):
            if "id" in data:
                return data["id"]
            inner = data.get("message")
            if isinstance(inner, dict) and "id" in inner:
                return inner["id"]
        raise RelayConnectionError(500, "DM response missing message id")


__all__ = ["RelayTransport"]
