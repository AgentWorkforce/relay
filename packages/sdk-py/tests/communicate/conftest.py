"""Shared fixtures for communicate transport tests."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict, deque
from contextlib import suppress
from itertools import count
from typing import Any

import pytest_asyncio
from aiohttp import WSMsgType, web

from agent_relay.communicate.types import RelayConfig


class MockRelayServer:
    """Minimal in-process Relaycast mock that mirrors the real API surface.

    Endpoints:
        POST   /v1/agents                          — register (workspace key auth)
        POST   /v1/agents/disconnect                — unregister (agent token auth)
        POST   /v1/agents/heartbeat                 — presence heartbeat (agent token)
        GET    /v1/agents                           — list agents (workspace key auth)
        POST   /v1/dm                               — send DM (agent token auth)
        POST   /v1/channels/{name}/messages         — channel message (agent token auth)
        POST   /v1/messages/{id}/replies            — reply (agent token auth)
        GET    /v1/inbox                            — inbox summary (agent token auth)
        GET    /v1/dm/{conv_id}/messages            — DM conversation messages (agent token)
        GET    /v1/ws                               — websocket (agent token via query param)
    """

    def __init__(self, *, api_key: str = "test-key", workspace: str = "test-workspace") -> None:
        self.api_key = api_key
        self.workspace = workspace
        self.url = ""

        self.messages: list[dict[str, Any]] = []
        self.requests: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.inboxes: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.registered_agents: dict[str, dict[str, str]] = {}
        self.extra_agents: set[str] = set()
        self.received_ws_messages: list[dict[str, Any]] = []
        self.ws_connection_counts: dict[str, int] = defaultdict(int)

        # Map agent tokens → agent IDs for auth
        self._token_to_agent_id: dict[str, str] = {}
        # DM conversations: conv_id → list of messages
        self._dm_conversations: dict[str, list[dict[str, Any]]] = defaultdict(list)

        self._active_websockets: dict[str, web.WebSocketResponse] = {}
        self._queued_errors: dict[str, deque[tuple[int, dict[str, Any]]]] = defaultdict(deque)
        self._agent_ids = count(1)
        self._message_ids = count(1)

        self._app = web.Application()
        self._app.router.add_post("/v1/agents", self._handle_register)
        self._app.router.add_get("/v1/agents", self._handle_agents)
        self._app.router.add_post("/v1/agents/disconnect", self._handle_disconnect)
        self._app.router.add_post("/v1/agents/heartbeat", self._handle_heartbeat)
        self._app.router.add_post("/v1/dm", self._handle_dm)
        self._app.router.add_get("/v1/dm/{conv_id}/messages", self._handle_dm_messages)
        self._app.router.add_post("/v1/channels/{channel}/messages", self._handle_channel)
        self._app.router.add_post("/v1/messages/{message_id}/replies", self._handle_reply)
        self._app.router.add_get("/v1/inbox", self._handle_inbox)
        self._app.router.add_get("/v1/ws", self._handle_ws)

        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None

    def make_config(self, **overrides: Any) -> RelayConfig:
        if not self.url:
            raise RuntimeError("MockRelayServer.start() must run before make_config().")

        payload: dict[str, Any] = {
            "workspace": self.workspace,
            "api_key": self.api_key,
            "base_url": self.url,
        }
        payload.update(overrides)
        return RelayConfig(**payload)

    def queue_http_error(
        self,
        operation: str,
        *,
        status: int,
        message: str,
        repeat: int = 1,
    ) -> None:
        body = {"ok": False, "error": {"code": "error", "message": message}}
        for _ in range(repeat):
            self._queued_errors[operation].append((status, body))

    def request_count(self, operation: str) -> int:
        return len(self.requests[operation])

    def add_agent(self, name: str) -> None:
        self.extra_agents.add(name)

    def find_agent_ids(self, name: str) -> list[str]:
        return [
            agent_id
            for agent_id, registration in self.registered_agents.items()
            if registration["name"] == name
        ]

    def find_agent_id(self, name: str) -> str | None:
        agent_ids = self.find_agent_ids(name)
        return agent_ids[0] if agent_ids else None

    def queue_inbox_message(
        self,
        agent_id: str,
        *,
        sender: str,
        text: str,
        channel: str | None = None,
        thread_id: str | None = None,
        message_id: str | None = None,
        timestamp: float | None = None,
    ) -> dict[str, Any]:
        msg_id = message_id or f"message-{next(self._message_ids)}"
        payload = {
            "sender": sender,
            "text": text,
            "channel": channel,
            "thread_id": thread_id,
            "message_id": msg_id,
            "timestamp": timestamp,
        }
        # Store as a DM conversation entry for inbox retrieval
        conv_id = f"dm_{agent_id}_{sender}"
        dm_msg = {
            "id": msg_id,
            "agent_name": sender,
            "text": text,
            "created_at": str(timestamp) if timestamp else None,
        }
        self._dm_conversations[conv_id].append(dm_msg)
        self.inboxes[agent_id].append({
            "conversation_id": conv_id,
            "from": sender,
            "unread_count": 1,
            "last_message": dm_msg,
        })
        return payload

    async def push_ws_message(
        self,
        agent_id: str,
        *,
        sender: str,
        text: str,
        channel: str | None = None,
        thread_id: str | None = None,
        message_id: str | None = None,
        timestamp: float | None = None,
    ) -> dict[str, Any]:
        ws = self._active_websockets.get(agent_id)
        if ws is None or ws.closed:
            raise AssertionError(f"No active websocket for agent {agent_id!r}")

        payload: dict[str, Any] = {
            "type": "dm.received" if channel is None else "message.created",
            "agent_name": sender,
            "text": text,
            "id": message_id or f"message-{next(self._message_ids)}",
        }
        if channel is not None:
            payload["channel_name"] = channel
        if thread_id is not None:
            payload["thread_id"] = thread_id
        if timestamp is not None:
            payload["created_at"] = str(timestamp)

        await ws.send_json(payload)
        return payload

    async def close_ws(self, agent_id: str) -> None:
        ws = self._active_websockets.get(agent_id)
        if ws is not None and not ws.closed:
            await ws.close()

    async def wait_for_ws_connections(
        self,
        agent_id: str,
        *,
        count: int = 1,
        timeout: float = 1.0,
    ) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if self.ws_connection_counts[agent_id] >= count:
                return
            await asyncio.sleep(0.01)

        raise AssertionError(
            f"Timed out waiting for {count} websocket connection(s) for {agent_id!r}."
        )

    def websocket_connected(self, agent_id: str) -> bool:
        ws = self._active_websockets.get(agent_id)
        return ws is not None and not ws.closed

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await self._site.start()

        server = getattr(self._site, "_server", None)
        if server is None or not server.sockets:
            raise RuntimeError("Failed to start mock Relaycast server.")

        port = server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        for agent_id, ws in list(self._active_websockets.items()):
            if not ws.closed:
                ws.force_close()
                with suppress(Exception, asyncio.TimeoutError):
                    await asyncio.wait_for(ws.close(drain=False), timeout=0.1)
            self._active_websockets.pop(agent_id, None)

        if self._runner is not None:
            await self._runner.cleanup()

    # --- Handlers ---

    async def _handle_register(self, request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        self._record_request("register_agent", request, payload)

        if error := self._pop_error("register_agent"):
            return error
        if error := self._require_workspace_auth(request):
            return error

        agent_id = f"agent-{next(self._agent_ids)}"
        token = f"token-{agent_id}"
        self.registered_agents[agent_id] = {"name": payload["name"], "token": token}
        self._token_to_agent_id[token] = agent_id
        return web.json_response({
            "ok": True,
            "data": {"id": agent_id, "name": payload["name"], "token": token, "status": "online"},
        })

    async def _handle_disconnect(self, request: web.Request) -> web.StreamResponse:
        agent_id = self._resolve_agent_from_token(request)
        self._record_request("unregister_agent", request, {"agent_id": agent_id})

        if error := self._pop_error("unregister_agent"):
            return error
        if agent_id is None:
            return web.json_response({"ok": False, "error": {"message": "Unauthorized"}}, status=401)

        self.registered_agents.pop(agent_id, None)
        self.inboxes.pop(agent_id, None)
        ws = self._active_websockets.pop(agent_id, None)
        if ws is not None and not ws.closed:
            await ws.close()
        # Remove token mapping
        token = self._extract_token(request)
        if token:
            self._token_to_agent_id.pop(token, None)
        return web.json_response({"ok": True})

    async def _handle_heartbeat(self, request: web.Request) -> web.StreamResponse:
        return web.json_response({"ok": True})

    async def _handle_dm(self, request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        agent_id = self._resolve_agent_from_token(request)
        sender_name = self.registered_agents.get(agent_id, {}).get("name", "unknown") if agent_id else "unknown"
        self._record_request("send_dm", request, payload)

        if error := self._pop_error("send_dm"):
            return error
        if agent_id is None:
            return web.json_response({"ok": False, "error": {"message": "Unauthorized"}}, status=401)

        message_id = f"message-{next(self._message_ids)}"
        conv_id = f"dm_{message_id}"
        self.messages.append({"kind": "dm", "message_id": message_id, **payload, "from": sender_name})

        # Deliver to recipient
        recipient_ids = self.find_agent_ids(payload["to"])
        dm_msg = {
            "id": message_id,
            "agent_name": sender_name,
            "text": payload["text"],
            "created_at": None,
        }
        self._dm_conversations[conv_id].append(dm_msg)
        for rid in recipient_ids:
            self.inboxes[rid].append({
                "conversation_id": conv_id,
                "from": sender_name,
                "unread_count": 1,
                "last_message": dm_msg,
            })

        await self._deliver_to_agents(
            recipient_ids,
            sender=sender_name,
            text=payload["text"],
            message_id=message_id,
        )

        return web.json_response({
            "ok": True,
            "data": {"id": message_id, "conversation_id": conv_id, "text": payload["text"]},
        }, status=201)

    async def _handle_dm_messages(self, request: web.Request) -> web.StreamResponse:
        conv_id = request.match_info["conv_id"]
        messages = list(self._dm_conversations.get(conv_id, []))
        return web.json_response({"ok": True, "data": messages})

    async def _handle_channel(self, request: web.Request) -> web.StreamResponse:
        channel = request.match_info["channel"]
        payload = await request.json()
        agent_id = self._resolve_agent_from_token(request)
        sender_name = self.registered_agents.get(agent_id, {}).get("name", "unknown") if agent_id else "unknown"
        self._record_request("post_message", request, {**payload, "channel": channel})

        if error := self._pop_error("post_message"):
            return error
        if agent_id is None:
            return web.json_response({"ok": False, "error": {"message": "Unauthorized"}}, status=401)

        message_id = f"message-{next(self._message_ids)}"
        self.messages.append({"kind": "channel", "message_id": message_id, "channel": channel, **payload, "from": sender_name})
        await self._deliver_to_agents(
            [
                aid
                for aid, registration in self.registered_agents.items()
                if aid != agent_id
            ],
            sender=sender_name,
            text=payload["text"],
            channel=channel,
            message_id=message_id,
        )
        return web.json_response({
            "ok": True,
            "data": {"id": message_id, "channel_name": channel, "text": payload["text"]},
        }, status=201)

    async def _handle_reply(self, request: web.Request) -> web.StreamResponse:
        parent_id = request.match_info["message_id"]
        payload = await request.json()
        agent_id = self._resolve_agent_from_token(request)
        sender_name = self.registered_agents.get(agent_id, {}).get("name", "unknown") if agent_id else "unknown"
        self._record_request("reply", request, {**payload, "message_id": parent_id})

        if error := self._pop_error("reply"):
            return error
        if agent_id is None:
            return web.json_response({"ok": False, "error": {"message": "Unauthorized"}}, status=401)

        reply_id = f"message-{next(self._message_ids)}"
        self.messages.append({
            "kind": "reply",
            "reply_id": reply_id,
            "thread_id": parent_id,
            "from": sender_name,
            **payload,
        })
        return web.json_response({
            "ok": True,
            "data": {"id": reply_id, "text": payload["text"]},
        }, status=201)

    async def _handle_inbox(self, request: web.Request) -> web.StreamResponse:
        agent_id = self._resolve_agent_from_token(request)
        self._record_request("check_inbox", request, {"agent_id": agent_id})

        if error := self._pop_error("check_inbox"):
            return error
        if agent_id is None:
            return web.json_response({"ok": False, "error": {"message": "Unauthorized"}}, status=401)

        unread_dms = list(self.inboxes.get(agent_id, []))
        self.inboxes[agent_id] = []
        return web.json_response({
            "ok": True,
            "data": {
                "unread_channels": [],
                "mentions": [],
                "unread_dms": unread_dms,
                "recent_reactions": [],
            },
        })

    async def _handle_agents(self, request: web.Request) -> web.StreamResponse:
        self._record_request("list_agents", request, None)

        if error := self._pop_error("list_agents"):
            return error
        if error := self._require_workspace_auth(request):
            return error

        agent_list = [
            {"name": agent["name"], "id": agent_id, "status": "online"}
            for agent_id, agent in self.registered_agents.items()
        ]
        for name in self.extra_agents:
            agent_list.append({"name": name, "id": f"extra-{name}", "status": "online"})

        return web.json_response({"ok": True, "data": agent_list})

    async def _handle_ws(self, request: web.Request) -> web.StreamResponse:
        token = request.query.get("token")
        agent_id = self._token_to_agent_id.get(token) if token else None
        if agent_id is None or agent_id not in self.registered_agents:
            raise web.HTTPUnauthorized(text="Invalid websocket token")

        ws = web.WebSocketResponse()
        await ws.prepare(request)

        self._active_websockets[agent_id] = ws
        self.ws_connection_counts[agent_id] += 1

        try:
            async for message in ws:
                if message.type is WSMsgType.TEXT:
                    self.received_ws_messages.append(json.loads(message.data))
                elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                    break
        finally:
            if self._active_websockets.get(agent_id) is ws:
                self._active_websockets.pop(agent_id, None)

        return ws

    # --- Helpers ---

    def _record_request(
        self,
        operation: str,
        request: web.Request,
        payload: dict[str, Any] | None,
    ) -> None:
        self.requests[operation].append(
            {
                "headers": dict(request.headers),
                "json": payload,
                "path": request.path,
            }
        )

    def _pop_error(self, operation: str) -> web.StreamResponse | None:
        if not self._queued_errors[operation]:
            return None

        status, body = self._queued_errors[operation].popleft()
        return web.json_response(body, status=status)

    def _extract_token(self, request: web.Request) -> str | None:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:]
        return None

    def _require_workspace_auth(self, request: web.Request) -> web.StreamResponse | None:
        token = self._extract_token(request)
        if token == self.api_key:
            return None
        return web.json_response({"ok": False, "error": {"message": "Unauthorized"}}, status=401)

    def _resolve_agent_from_token(self, request: web.Request) -> str | None:
        token = self._extract_token(request)
        if token is None:
            return None
        return self._token_to_agent_id.get(token)

    async def _deliver_to_agents(
        self,
        agent_ids: list[str],
        *,
        sender: str,
        text: str,
        channel: str | None = None,
        thread_id: str | None = None,
        message_id: str | None = None,
        timestamp: float | None = None,
    ) -> None:
        if not agent_ids:
            return

        for agent_id in agent_ids:
            await self._deliver_message(agent_id, sender=sender, text=text,
                                         channel=channel, thread_id=thread_id,
                                         message_id=message_id, timestamp=timestamp)

    async def _deliver_message(
        self,
        agent_id: str,
        *,
        sender: str,
        text: str,
        channel: str | None = None,
        thread_id: str | None = None,
        message_id: str | None = None,
        timestamp: float | None = None,
    ) -> None:
        ws = self._active_websockets.get(agent_id)
        if ws is not None and not ws.closed:
            payload: dict[str, Any] = {
                "type": "dm.received" if channel is None else "message.created",
                "agent_name": sender,
                "text": text,
                "id": message_id or f"message-{next(self._message_ids)}",
            }
            if channel is not None:
                payload["channel_name"] = channel
            if thread_id is not None:
                payload["thread_id"] = thread_id
            if timestamp is not None:
                payload["created_at"] = str(timestamp)
            try:
                await ws.send_json(payload)
                return
            except Exception:
                self._active_websockets.pop(agent_id, None)

        # Fall back to inbox buffering
        conv_id = f"dm_{sender}_{agent_id}"
        dm_msg = {
            "id": message_id or f"message-{next(self._message_ids)}",
            "agent_name": sender,
            "text": text,
            "created_at": str(timestamp) if timestamp else None,
        }
        self._dm_conversations[conv_id].append(dm_msg)
        self.inboxes[agent_id].append({
            "conversation_id": conv_id,
            "from": sender,
            "unread_count": 1,
            "last_message": dm_msg,
        })


@pytest_asyncio.fixture
async def relay_server() -> MockRelayServer:
    server = MockRelayServer()
    await server.start()
    try:
        yield server
    finally:
        await server.stop()
