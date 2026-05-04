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
    """Minimal in-process Relaycast mock for transport and integration tests.

    Mirrors the production REST surface that the SDK targets:
        POST   /v1/agents                              (workspace key)
        DELETE /v1/agents/{name}                       (workspace key)
        GET    /v1/agents                              (workspace key)
        POST   /v1/channels/{name}/messages            (agent token)
        POST   /v1/messages/{id}/replies               (agent token)
        POST   /v1/dm                                  (agent token)
        GET    /v1/inbox                               (agent token)
        WS     /v1/ws?token=...                        (agent token)
    """

    def __init__(self, *, api_key: str = "test-key", workspace: str = "test-workspace") -> None:
        self.api_key = api_key
        self.workspace = workspace
        self.url = ""

        self.messages: list[dict[str, Any]] = []
        self.requests: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.inboxes: dict[str, list[dict[str, Any]]] = defaultdict(list)
        # registered_agents is keyed by internal agent_id; each entry carries
        # {"name": ..., "token": ...} so tests can look up by either dimension.
        self.registered_agents: dict[str, dict[str, str]] = {}
        self.extra_agents: set[str] = set()
        self.received_ws_messages: list[dict[str, Any]] = []
        self.ws_connection_counts: dict[str, int] = defaultdict(int)

        self._active_websockets: dict[str, web.WebSocketResponse] = {}
        self._queued_errors: dict[str, deque[tuple[int, dict[str, Any]]]] = defaultdict(deque)
        self._agent_ids = count(1)
        self._message_ids = count(1)

        self._app = web.Application()
        self._app.router.add_post("/v1/agents", self._handle_register)
        self._app.router.add_delete("/v1/agents/{name}", self._handle_unregister)
        self._app.router.add_get("/v1/agents", self._handle_agents)
        self._app.router.add_post("/v1/channels/{channel}/messages", self._handle_channel)
        self._app.router.add_post("/v1/messages/{message_id}/replies", self._handle_reply)
        self._app.router.add_post("/v1/dm", self._handle_dm)
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
        body = {"ok": False, "error": {"code": "queued", "message": message}}
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
        payload = {
            "sender": sender,
            "text": text,
            "channel": channel,
            "thread_id": thread_id,
            "message_id": message_id or f"message-{next(self._message_ids)}",
            "timestamp": timestamp,
        }
        self.inboxes[agent_id].append(payload)
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

        payload = {
            "type": "message",
            "sender": sender,
            "text": text,
            "channel": channel,
            "thread_id": thread_id,
            "message_id": message_id or f"message-{next(self._message_ids)}",
            "timestamp": timestamp,
        }
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

    # -- Handlers ----------------------------------------------------------

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
        return web.json_response(
            {
                "ok": True,
                "data": {
                    "id": agent_id,
                    "name": payload["name"],
                    "token": token,
                    "type": payload.get("type", "agent"),
                    "status": "online",
                },
            },
            status=201,
        )

    async def _handle_unregister(self, request: web.Request) -> web.StreamResponse:
        name = request.match_info["name"]
        self._record_request("unregister_agent", request, {"name": name})

        if error := self._pop_error("unregister_agent"):
            return error
        if error := self._require_workspace_auth(request):
            return error

        agent_id = self.find_agent_id(name)
        if agent_id is None:
            return web.Response(status=204)

        self.registered_agents.pop(agent_id, None)
        self.inboxes.pop(agent_id, None)
        ws = self._active_websockets.pop(agent_id, None)
        if ws is not None and not ws.closed:
            await ws.close()
        return web.Response(status=204)

    async def _handle_dm(self, request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        self._record_request("send_dm", request, payload)

        if error := self._pop_error("send_dm"):
            return error
        sender = self._authenticated_agent(request)
        if isinstance(sender, web.StreamResponse):
            return sender

        message_id = f"message-{next(self._message_ids)}"
        self.messages.append({"kind": "dm", "message_id": message_id, "from": sender["name"], **payload})
        await self._deliver_to_agents(
            self.find_agent_ids(payload["to"]),
            sender=sender["name"],
            text=payload["text"],
            message_id=message_id,
        )
        return web.json_response(
            {
                "ok": True,
                "data": {
                    "id": message_id,
                    "to": payload["to"],
                    "text": payload["text"],
                    "message": {"id": message_id, "agent_name": sender["name"], "text": payload["text"]},
                },
            },
            status=201,
        )

    async def _handle_channel(self, request: web.Request) -> web.StreamResponse:
        channel = request.match_info["channel"]
        payload = await request.json()
        self._record_request("post_message", request, {"channel": channel, **payload})

        if error := self._pop_error("post_message"):
            return error
        sender = self._authenticated_agent(request)
        if isinstance(sender, web.StreamResponse):
            return sender

        message_id = f"message-{next(self._message_ids)}"
        self.messages.append(
            {"kind": "channel", "message_id": message_id, "channel": channel, "from": sender["name"], **payload}
        )
        await self._deliver_to_agents(
            [
                agent_id
                for agent_id, registration in self.registered_agents.items()
                if registration["name"] != sender["name"]
            ],
            sender=sender["name"],
            text=payload["text"],
            channel=channel,
            message_id=message_id,
        )
        return web.json_response(
            {
                "ok": True,
                "data": {
                    "id": message_id,
                    "channel": channel,
                    "agent_name": sender["name"],
                    "text": payload["text"],
                },
            },
            status=201,
        )

    async def _handle_reply(self, request: web.Request) -> web.StreamResponse:
        thread_id = request.match_info["message_id"]
        payload = await request.json()
        self._record_request("reply", request, {"message_id": thread_id, **payload})

        if error := self._pop_error("reply"):
            return error
        sender = self._authenticated_agent(request)
        if isinstance(sender, web.StreamResponse):
            return sender

        reply_id = f"message-{next(self._message_ids)}"
        self.messages.append(
            {
                "kind": "reply",
                "reply_id": reply_id,
                "thread_id": thread_id,
                "from": sender["name"],
                **payload,
            }
        )
        return web.json_response(
            {
                "ok": True,
                "data": {
                    "id": reply_id,
                    "thread_id": thread_id,
                    "agent_name": sender["name"],
                    "text": payload["text"],
                },
            },
            status=201,
        )

    async def _handle_inbox(self, request: web.Request) -> web.StreamResponse:
        self._record_request("check_inbox", request, None)

        if error := self._pop_error("check_inbox"):
            return error
        sender = self._authenticated_agent(request)
        if isinstance(sender, web.StreamResponse):
            return sender

        # Hosted API returns unread metadata, not message bodies.
        return web.json_response(
            {
                "ok": True,
                "data": {
                    "unread_channels": [],
                    "mentions": [],
                    "unread_dms": [],
                    "recent_reactions": [],
                },
            }
        )

    async def _handle_agents(self, request: web.Request) -> web.StreamResponse:
        self._record_request("list_agents", request, None)

        if error := self._pop_error("list_agents"):
            return error
        if error := self._require_workspace_auth(request):
            return error

        names = sorted(
            {agent["name"] for agent in self.registered_agents.values()} | self.extra_agents
        )
        agents = [
            {"id": f"agent-mock-{i}", "name": name, "type": "agent", "status": "online"}
            for i, name in enumerate(names, start=1)
        ]
        return web.json_response({"ok": True, "data": agents})

    async def _handle_ws(self, request: web.Request) -> web.StreamResponse:
        token = request.query.get("token")
        agent_id = next(
            (
                agent_id
                for agent_id, registration in self.registered_agents.items()
                if registration["token"] == token
            ),
            None,
        )
        if agent_id is None:
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

    # -- Helpers -----------------------------------------------------------

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

    def _require_workspace_auth(self, request: web.Request) -> web.StreamResponse | None:
        auth_header = request.headers.get("Authorization")
        if auth_header == f"Bearer {self.api_key}":
            return None
        return web.json_response(
            {"ok": False, "error": {"code": "unauthorized", "message": "Unauthorized"}},
            status=401,
        )

    def _authenticated_agent(
        self, request: web.Request
    ) -> dict[str, str] | web.StreamResponse:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return web.json_response(
                {"ok": False, "error": {"code": "unauthorized", "message": "Missing bearer token"}},
                status=401,
            )
        token = auth_header[len("Bearer ") :]
        for registration in self.registered_agents.values():
            if registration["token"] == token:
                return registration
        return web.json_response(
            {"ok": False, "error": {"code": "unauthorized", "message": "Unknown agent token"}},
            status=401,
        )

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

        payload = {
            "sender": sender,
            "text": text,
            "channel": channel,
            "thread_id": thread_id,
            "message_id": message_id or f"message-{next(self._message_ids)}",
            "timestamp": timestamp,
        }

        for agent_id in agent_ids:
            await self._deliver_message(agent_id, payload)

    async def _deliver_message(self, agent_id: str, payload: dict[str, Any]) -> None:
        ws = self._active_websockets.get(agent_id)
        if ws is not None and not ws.closed:
            try:
                await ws.send_json({"type": "message", **payload})
                return
            except Exception:
                self._active_websockets.pop(agent_id, None)

        self.inboxes[agent_id].append(dict(payload))


@pytest_asyncio.fixture
async def relay_server() -> MockRelayServer:
    server = MockRelayServer()
    await server.start()
    try:
        yield server
    finally:
        await server.stop()
