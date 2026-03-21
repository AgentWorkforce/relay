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
    """Minimal in-process Relaycast mock for transport and integration tests."""

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

        self._active_websockets: dict[str, web.WebSocketResponse] = {}
        self._queued_errors: dict[str, deque[tuple[int, dict[str, Any]]]] = defaultdict(deque)
        self._agent_ids = count(1)
        self._message_ids = count(1)

        self._app = web.Application()
        self._app.router.add_post("/v1/agents/register", self._handle_register)
        self._app.router.add_delete("/v1/agents/{agent_id}", self._handle_unregister)
        self._app.router.add_post("/v1/messages/dm", self._handle_dm)
        self._app.router.add_post("/v1/messages/channel", self._handle_channel)
        self._app.router.add_post("/v1/messages/reply", self._handle_reply)
        self._app.router.add_get("/v1/inbox/{agent_id}", self._handle_inbox)
        self._app.router.add_get("/v1/agents", self._handle_agents)
        self._app.router.add_get("/v1/ws/{agent_id}", self._handle_ws)

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
        body = {"message": message}
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

    async def _handle_register(self, request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        self._record_request("register_agent", request, payload)

        if error := self._pop_error("register_agent"):
            return error
        if error := self._require_auth(request):
            return error

        agent_id = f"agent-{next(self._agent_ids)}"
        token = f"token-{agent_id}"
        self.registered_agents[agent_id] = {"name": payload["name"], "token": token}
        return web.json_response({"agent_id": agent_id, "token": token})

    async def _handle_unregister(self, request: web.Request) -> web.StreamResponse:
        agent_id = request.match_info["agent_id"]
        self._record_request("unregister_agent", request, {"agent_id": agent_id})

        if error := self._pop_error("unregister_agent"):
            return error
        if error := self._require_auth(request):
            return error

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
        if error := self._require_auth(request):
            return error

        message_id = f"message-{next(self._message_ids)}"
        self.messages.append({"kind": "dm", "message_id": message_id, **payload})
        await self._deliver_to_agents(
            self.find_agent_ids(payload["to"]),
            sender=payload["from"],
            text=payload["text"],
            message_id=message_id,
        )
        return web.json_response({"message_id": message_id})

    async def _handle_channel(self, request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        self._record_request("post_message", request, payload)

        if error := self._pop_error("post_message"):
            return error
        if error := self._require_auth(request):
            return error

        message_id = f"message-{next(self._message_ids)}"
        self.messages.append({"kind": "channel", "message_id": message_id, **payload})
        await self._deliver_to_agents(
            [
                agent_id
                for agent_id, registration in self.registered_agents.items()
                if registration["name"] != payload["from"]
            ],
            sender=payload["from"],
            text=payload["text"],
            channel=payload["channel"],
            message_id=message_id,
        )
        return web.json_response({"message_id": message_id})

    async def _handle_reply(self, request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        self._record_request("reply", request, payload)

        if error := self._pop_error("reply"):
            return error
        if error := self._require_auth(request):
            return error

        reply_id = f"message-{next(self._message_ids)}"
        self.messages.append(
            {
                "kind": "reply",
                "reply_id": reply_id,
                "thread_id": payload.get("thread_id") or payload.get("message_id"),
                **payload,
            }
        )
        return web.json_response({"message_id": reply_id})

    async def _handle_inbox(self, request: web.Request) -> web.StreamResponse:
        agent_id = request.match_info["agent_id"]
        self._record_request("check_inbox", request, {"agent_id": agent_id})

        if error := self._pop_error("check_inbox"):
            return error
        if error := self._require_auth(request):
            return error

        messages = list(self.inboxes[agent_id])
        self.inboxes[agent_id].clear()
        return web.json_response({"messages": messages})

    async def _handle_agents(self, request: web.Request) -> web.StreamResponse:
        self._record_request("list_agents", request, None)

        if error := self._pop_error("list_agents"):
            return error
        if error := self._require_auth(request):
            return error

        agents = sorted(
            {agent["name"] for agent in self.registered_agents.values()} | self.extra_agents
        )
        return web.json_response({"agents": agents})

    async def _handle_ws(self, request: web.Request) -> web.StreamResponse:
        agent_id = request.match_info["agent_id"]
        token = request.query.get("token")
        registration = self.registered_agents.get(agent_id)
        if registration is None or token != registration["token"]:
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

    def _require_auth(self, request: web.Request) -> web.StreamResponse | None:
        auth_header = request.headers.get("Authorization")
        if auth_header == f"Bearer {self.api_key}":
            return None
        return web.json_response({"message": "Unauthorized"}, status=401)

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
