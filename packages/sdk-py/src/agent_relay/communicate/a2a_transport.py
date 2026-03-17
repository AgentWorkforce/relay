"""A2A (Agent-to-Agent) protocol transport implementation."""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import suppress
from inspect import isawaitable
from typing import Any, Callable

try:
    import aiohttp
    from aiohttp import web
except ImportError:
    raise ImportError(
        "A2A transport requires 'aiohttp'. "
        "Install it with: pip install agent-relay-sdk[communicate]"
    )

from .a2a_types import (
    A2AAgentCard,
    A2AConfig,
    A2AMessage,
    A2APart,
    A2ASkill,
    A2ATask,
    A2ATaskStatus,
    A2A_TASK_NOT_CANCELABLE,
    A2A_TASK_NOT_FOUND,
    JSONRPC_INTERNAL_ERROR,
    JSONRPC_INVALID_PARAMS,
    JSONRPC_METHOD_NOT_FOUND,
    JSONRPC_PARSE_ERROR,
    make_jsonrpc_error,
    make_jsonrpc_request,
    make_jsonrpc_response,
)
from .types import Message, MessageCallback


class A2ATransport:
    """
    Transport that speaks A2A protocol instead of Relaycast API.

    Client side: sends JSON-RPC 2.0 to external A2A agent endpoints.
    Server side: runs a local HTTP server accepting A2A JSON-RPC calls.
    """

    def __init__(self, config: A2AConfig) -> None:
        self.config = config
        self.agent_name: str | None = None
        self.agent_card: A2AAgentCard | None = None
        self.tasks: dict[str, A2ATask] = {}
        self._message_callbacks: list[MessageCallback] = []
        self._session: aiohttp.ClientSession | None = None
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._discovered_cards: dict[str, A2AAgentCard] = {}
        self._closing = False

    # === Transport interface ===

    async def register(self, name: str) -> dict[str, Any]:
        """
        Register by starting an HTTP server that serves:
        - GET /.well-known/agent.json -> AgentCard
        - POST / -> JSON-RPC 2.0 endpoint
        """
        self.agent_name = name
        self.agent_card = A2AAgentCard(
            name=name,
            description=self.config.agent_description or f"Agent Relay agent: {name}",
            url=f"http://{self.config.server_host}:{self.config.server_port}",
            skills=list(self.config.skills),
        )

        self._app = web.Application()
        self._app.router.add_get("/.well-known/agent.json", self._handle_agent_card)
        self._app.router.add_post("/", self._handle_jsonrpc_http)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.config.server_host, self.config.server_port)
        await self._site.start()

        return {
            "name": name,
            "url": self.agent_card.url,
            "type": "a2a",
        }

    async def unregister(self) -> None:
        """Stop the HTTP server and clean up."""
        self._closing = True
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        self._app = None
        await self._close_session()
        self._closing = False

    async def send_dm(self, target: str, text: str) -> dict[str, Any]:
        """
        Send a message to an external A2A agent.

        target: URL of the A2A agent endpoint
        text: message text to send
        """
        card = await self._discover_agent(target)

        message = A2AMessage(
            role="user",
            parts=[A2APart(text=text)],
        )

        rpc_request = make_jsonrpc_request(
            "message/send",
            {"message": message.to_dict()},
        )

        session = await self._ensure_session()
        headers = self._auth_headers()
        headers["Content-Type"] = "application/json"

        async with session.post(card.url, json=rpc_request, headers=headers) as resp:
            body = await resp.json()

        if "error" in body:
            err = body["error"]
            raise A2AError(err.get("code", -1), err.get("message", "Unknown error"))

        result = body.get("result", {})
        return self._a2a_result_to_relay(result, card.name)

    async def list_agents(self) -> list[dict[str, Any]]:
        """List known A2A agents from registry."""
        agents: list[dict[str, Any]] = []
        for url in self.config.registry:
            try:
                card = await self._discover_agent(url)
                agents.append({
                    "name": card.name,
                    "url": card.url,
                    "description": card.description,
                    "skills": [s.to_dict() for s in card.skills],
                })
            except Exception:
                continue
        return agents

    def on_message(self, callback: MessageCallback) -> None:
        """Register callback for incoming A2A messages."""
        self._message_callbacks.append(callback)

    async def connect_ws(self) -> None:
        """
        A2A uses HTTP, not WebSocket. This is a no-op.
        The HTTP server started in register() handles incoming calls.
        """
        pass

    # === HTTP handlers for incoming A2A requests ===

    async def _handle_agent_card(self, request: web.Request) -> web.Response:
        """Serve the Agent Card at /.well-known/agent.json."""
        if self.agent_card is None:
            return web.json_response({"error": "Not registered"}, status=503)
        return web.json_response(self.agent_card.to_dict())

    async def _handle_jsonrpc_http(self, request: web.Request) -> web.Response:
        """Handle incoming JSON-RPC 2.0 requests over HTTP."""
        try:
            body = await request.json()
        except (json.JSONDecodeError, Exception):
            error = make_jsonrpc_error(JSONRPC_PARSE_ERROR, "Parse error", None)
            return web.json_response(error)

        result = await self._dispatch_jsonrpc(body)
        return web.json_response(result)

    async def _dispatch_jsonrpc(self, request: dict[str, Any]) -> dict[str, Any]:
        """Dispatch a JSON-RPC request to the appropriate handler."""
        rpc_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {})

        handlers = {
            "message/send": self._handle_message_send,
            "tasks/get": self._handle_tasks_get,
            "tasks/cancel": self._handle_tasks_cancel,
        }

        handler = handlers.get(method)
        if handler is None:
            return make_jsonrpc_error(JSONRPC_METHOD_NOT_FOUND, f"Method not found: {method}", rpc_id)

        try:
            result = await handler(params)
            return make_jsonrpc_response(result, rpc_id)
        except A2AError as exc:
            return make_jsonrpc_error(exc.code, exc.message, rpc_id)
        except Exception as exc:
            return make_jsonrpc_error(JSONRPC_INTERNAL_ERROR, str(exc), rpc_id)

    async def _handle_message_send(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle message/send JSON-RPC method."""
        msg_data = params.get("message")
        if not msg_data:
            raise A2AError(JSONRPC_INVALID_PARAMS, "Missing 'message' in params")

        a2a_msg = A2AMessage.from_dict(msg_data)

        # Create or update task
        task_id = a2a_msg.taskId or str(uuid.uuid4())
        context_id = a2a_msg.contextId or str(uuid.uuid4())

        if task_id in self.tasks:
            task = self.tasks[task_id]
            task.messages.append(a2a_msg)
            task.status = A2ATaskStatus(state="working")
        else:
            task = A2ATask(
                id=task_id,
                contextId=context_id,
                status=A2ATaskStatus(state="working"),
                messages=[a2a_msg],
            )
            self.tasks[task_id] = task

        # Convert to Relay message and invoke callbacks
        relay_msg = self._a2a_to_relay_msg(a2a_msg, sender="a2a-client")
        await self._invoke_callbacks(relay_msg)

        # Mark completed
        task.status = A2ATaskStatus(state="completed")

        return task.to_dict()

    async def _handle_tasks_get(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle tasks/get JSON-RPC method."""
        task_id = params.get("id")
        if not task_id or task_id not in self.tasks:
            raise A2AError(A2A_TASK_NOT_FOUND, f"Task not found: {task_id}")
        return self.tasks[task_id].to_dict()

    async def _handle_tasks_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle tasks/cancel JSON-RPC method."""
        task_id = params.get("id")
        if not task_id or task_id not in self.tasks:
            raise A2AError(A2A_TASK_NOT_FOUND, f"Task not found: {task_id}")

        task = self.tasks[task_id]
        if task.status.state in ("completed", "failed", "canceled"):
            raise A2AError(A2A_TASK_NOT_CANCELABLE, f"Task {task_id} is already {task.status.state}")

        task.status = A2ATaskStatus(state="canceled")
        return task.to_dict()

    # === Agent discovery ===

    async def _discover_agent(self, url: str) -> A2AAgentCard:
        """Fetch and parse Agent Card from /.well-known/agent.json."""
        url = url.rstrip("/")

        if url in self._discovered_cards:
            return self._discovered_cards[url]

        session = await self._ensure_session()
        card_url = f"{url}/.well-known/agent.json"

        async with session.get(card_url) as resp:
            if resp.status != 200:
                raise A2AError(-1, f"Failed to discover agent at {card_url}: HTTP {resp.status}")
            data = await resp.json()

        card = A2AAgentCard.from_dict(data)
        self._discovered_cards[url] = card
        return card

    # === Message conversion ===

    @staticmethod
    def _relay_msg_to_a2a(text: str, sender: str) -> A2AMessage:
        """Convert Relay message text to A2A Message."""
        return A2AMessage(
            role="user",
            parts=[A2APart(text=text)],
        )

    @staticmethod
    def _a2a_to_relay_msg(msg: A2AMessage, sender: str = "unknown") -> Message:
        """Convert A2A Message to Relay Message format."""
        text = msg.get_text()
        return Message(
            sender=sender,
            text=text,
            channel=None,
            thread_id=msg.contextId,
            message_id=msg.messageId,
        )

    @staticmethod
    def _a2a_result_to_relay(result: dict[str, Any], sender: str) -> dict[str, Any]:
        """Convert A2A task/message result to Relay-compatible dict."""
        # Result could be a Task dict
        messages = result.get("messages", [])
        text = ""
        if messages:
            last_msg = messages[-1]
            parts = last_msg.get("parts", [])
            text = " ".join(p.get("text", "") for p in parts if p.get("text"))

        return {
            "sender": sender,
            "text": text,
            "task_id": result.get("id"),
            "status": result.get("status", {}).get("state"),
        }

    # === Internal helpers ===

    async def _invoke_callbacks(self, msg: Message) -> None:
        """Invoke all registered message callbacks."""
        for cb in self._message_callbacks:
            result = cb(msg)
            if isawaitable(result):
                await result

    def _auth_headers(self) -> dict[str, str]:
        """Build auth headers from config."""
        headers: dict[str, str] = {}
        if self.config.auth_token:
            if self.config.auth_scheme == "bearer":
                headers["Authorization"] = f"Bearer {self.config.auth_token}"
            elif self.config.auth_scheme == "api_key":
                headers["X-API-Key"] = self.config.auth_token
            else:
                headers["Authorization"] = f"Bearer {self.config.auth_token}"
        return headers

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _close_session(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None


class A2AError(Exception):
    """Error raised during A2A protocol operations."""

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"A2A error {code}: {message}")


__all__ = ["A2AError", "A2ATransport"]
