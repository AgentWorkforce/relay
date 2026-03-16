"""A2A-compliant HTTP server that exposes a Relay agent as an A2A endpoint."""

from __future__ import annotations

import uuid
from dataclasses import asdict
from typing import Any, Callable, Awaitable

from aiohttp import web

from .a2a_types import (
    A2AAgentCard,
    A2AMessage,
    A2APart,
    A2ASkill,
    A2ATask,
    A2ATaskStatus,
    A2AConfig,
)


class A2AServer:
    """Lightweight HTTP server that exposes a Relay agent as an A2A endpoint.

    Routes:
      GET  /.well-known/agent.json  -> Agent Card
      POST /                        -> JSON-RPC 2.0 dispatcher
    """

    def __init__(
        self,
        agent_name: str,
        port: int = 5000,
        host: str = "0.0.0.0",
        skills: list[A2ASkill] | None = None,
    ) -> None:
        self.agent_name = agent_name
        self.port = port
        self.host = host
        self.skills = skills or []
        self.tasks: dict[str, A2ATask] = {}
        self._on_message: Callable[[A2AMessage], Awaitable[A2AMessage | None] | A2AMessage | None] | None = None

        self._app = web.Application()
        self._app.router.add_get("/.well-known/agent.json", self._handle_agent_card)
        self._app.router.add_post("/", self._handle_jsonrpc)

        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._actual_port: int | None = None

    @property
    def url(self) -> str:
        port = self._actual_port or self.port
        return f"http://{self.host}:{port}"

    def on_message(self, callback: Callable[[A2AMessage], Awaitable[A2AMessage | None] | A2AMessage | None]) -> None:
        """Register callback for incoming A2A messages."""
        self._on_message = callback

    def get_agent_card(self) -> A2AAgentCard:
        """Build Agent Card for this agent."""
        return A2AAgentCard(
            name=self.agent_name,
            description=f"Agent Relay agent: {self.agent_name}",
            url=self.url,
            skills=list(self.skills),
        )

    async def handle_message_send(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle JSON-RPC message/send.

        1. Extract message from params
        2. Create or update Task
        3. Call on_message callback
        4. Return Task response
        """
        message_data = params.get("message", {})
        parts = [A2APart(text=p.get("text")) for p in message_data.get("parts", [])]
        incoming = A2AMessage(
            role=message_data.get("role", "user"),
            parts=parts,
            messageId=message_data.get("messageId") or str(uuid.uuid4()),
            contextId=message_data.get("contextId"),
            taskId=message_data.get("taskId"),
        )

        # Create or find task
        task_id = incoming.taskId or str(uuid.uuid4())
        context_id = incoming.contextId or str(uuid.uuid4())

        if task_id in self.tasks:
            task = self.tasks[task_id]
            task.messages.append(incoming)
            task.status = A2ATaskStatus(state="working")
        else:
            task = A2ATask(
                id=task_id,
                contextId=context_id,
                status=A2ATaskStatus(state="working"),
                messages=[incoming],
            )
            self.tasks[task_id] = task

        # Invoke callback
        response_msg: A2AMessage | None = None
        if self._on_message is not None:
            result = self._on_message(incoming)
            if hasattr(result, "__await__"):
                response_msg = await result  # type: ignore[union-attr]
            else:
                response_msg = result  # type: ignore[assignment]

        if response_msg is not None:
            task.messages.append(response_msg)
            task.status = A2ATaskStatus(state="completed", message=response_msg)
        else:
            task.status = A2ATaskStatus(state="completed")

        return self._task_to_dict(task)

    async def handle_tasks_get(self, task_id: str) -> dict[str, Any]:
        """JSON-RPC: tasks/get — return task state."""
        task = self.tasks.get(task_id)
        if task is None:
            raise KeyError(f"Task not found: {task_id}")
        return self._task_to_dict(task)

    async def handle_tasks_cancel(self, task_id: str) -> dict[str, Any]:
        """JSON-RPC: tasks/cancel — cancel a running task."""
        task = self.tasks.get(task_id)
        if task is None:
            raise KeyError(f"Task not found: {task_id}")
        task.status = A2ATaskStatus(state="canceled")
        return self._task_to_dict(task)

    async def start(self) -> None:
        """Start aiohttp server."""
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()

        # Resolve actual port (useful when port=0)
        server = getattr(self._site, "_server", None)
        if server is not None and server.sockets:
            self._actual_port = server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        """Stop server."""
        if self._runner is not None:
            await self._runner.cleanup()
        self._runner = None
        self._site = None

    # --- HTTP Handlers ---

    async def _handle_agent_card(self, request: web.Request) -> web.Response:
        card = self.get_agent_card()
        return web.json_response(self._agent_card_to_dict(card))

    async def _handle_jsonrpc(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None},
                status=400,
            )

        method = body.get("method", "")
        params = body.get("params", {})
        rpc_id = body.get("id")

        try:
            if method == "message/send":
                result = await self.handle_message_send(params)
            elif method == "tasks/get":
                task_id = params.get("id") or params.get("taskId", "")
                result = await self.handle_tasks_get(task_id)
            elif method == "tasks/cancel":
                task_id = params.get("id") or params.get("taskId", "")
                result = await self.handle_tasks_cancel(task_id)
            else:
                return web.json_response(
                    {"jsonrpc": "2.0", "error": {"code": -32601, "message": f"Method not found: {method}"}, "id": rpc_id},
                    status=400,
                )
        except KeyError as exc:
            return web.json_response(
                {"jsonrpc": "2.0", "error": {"code": -32602, "message": str(exc)}, "id": rpc_id},
                status=404,
            )

        return web.json_response({"jsonrpc": "2.0", "result": result, "id": rpc_id})

    # --- Serialization helpers ---

    @staticmethod
    def _task_to_dict(task: A2ATask) -> dict[str, Any]:
        status_dict: dict[str, Any] = {"state": task.status.state}
        if task.status.message is not None:
            status_dict["message"] = {
                "role": task.status.message.role,
                "parts": [{"text": p.text} for p in task.status.message.parts],
            }
            if task.status.message.messageId:
                status_dict["message"]["messageId"] = task.status.message.messageId

        messages = []
        for m in task.messages:
            md: dict[str, Any] = {
                "role": m.role,
                "parts": [{"text": p.text} for p in m.parts],
            }
            if m.messageId:
                md["messageId"] = m.messageId
            messages.append(md)

        return {
            "id": task.id,
            "contextId": task.contextId,
            "status": status_dict,
            "messages": messages,
            "artifacts": task.artifacts,
        }

    @staticmethod
    def _agent_card_to_dict(card: A2AAgentCard) -> dict[str, Any]:
        return {
            "name": card.name,
            "description": card.description,
            "url": card.url,
            "version": card.version,
            "capabilities": card.capabilities,
            "skills": [{"id": s.id, "name": s.name, "description": s.description} for s in card.skills],
            "defaultInputModes": card.defaultInputModes,
            "defaultOutputModes": card.defaultOutputModes,
        }


__all__ = ["A2AServer"]
