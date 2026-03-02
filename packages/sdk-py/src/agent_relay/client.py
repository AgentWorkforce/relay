"""Low-level async client for the Agent Relay broker subprocess.

Manages the broker process lifecycle, line-delimited JSON protocol,
request/response correlation, and event dispatch.

Mirrors packages/sdk/src/client.ts.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
from pathlib import Path
from typing import Any, Callable, Optional

from .protocol import PROTOCOL_VERSION, AgentSpec, BrokerEvent, ProtocolEnvelope

# ── Errors ────────────────────────────────────────────────────────────────────


class AgentRelayProtocolError(Exception):
    """Raised when the broker returns a protocol-level error."""

    def __init__(self, code: str, message: str, retryable: bool = False, data: Any = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.data = data


class AgentRelayProcessError(Exception):
    """Raised for broker process lifecycle errors."""


# ── CLI / model helpers ───────────────────────────────────────────────────────

_CLI_MODEL_FLAG_CLIS = {"claude", "codex", "gemini", "goose", "aider"}

_CLI_DEFAULT_ARGS: dict[str, list[str]] = {
    "codex": ["-c", "check_for_update_on_startup=false"],
}


def _has_model_arg(args: list[str]) -> bool:
    for arg in args:
        if arg == "--model" or arg.startswith("--model="):
            return True
    return False


def _build_pty_args_with_model(cli: str, args: list[str], model: Optional[str] = None) -> list[str]:
    cli_name = cli.split(":")[0].strip().lower()
    default_args = _CLI_DEFAULT_ARGS.get(cli_name, [])
    base_args = [*default_args, *args]
    if not model:
        return base_args
    if cli_name not in _CLI_MODEL_FLAG_CLIS:
        return base_args
    if _has_model_arg(base_args):
        return base_args
    return ["--model", model, *base_args]


def _expand_tilde(p: str) -> str:
    if p == "~" or p.startswith("~/") or p.startswith("~\\"):
        return str(Path.home() / p[2:])
    return p


def _is_explicit_path(binary_path: str) -> bool:
    return "/" in binary_path or "\\" in binary_path or binary_path.startswith(".") or binary_path.startswith("~")


def _resolve_default_binary_path() -> str:
    broker_exe = "agent-relay-broker"

    # 1. Check ~/.agent-relay/bin/
    home = Path.home()
    standalone = home / ".agent-relay" / "bin" / broker_exe
    if standalone.exists():
        return str(standalone)

    # 2. Fall back to PATH
    found = shutil.which(broker_exe)
    if found:
        return found

    # 3. Last resort: bare name (will fail at spawn time if not on PATH)
    return "agent-relay"


# ── Pending request tracking ─────────────────────────────────────────────────


class _PendingRequest:
    __slots__ = ("expected_type", "future", "timeout_handle")

    def __init__(self, expected_type: str, future: asyncio.Future[ProtocolEnvelope], timeout_handle: asyncio.TimerHandle):
        self.expected_type = expected_type
        self.future = future
        self.timeout_handle = timeout_handle


# ── Client ────────────────────────────────────────────────────────────────────


class AgentRelayClient:
    """Manages a broker subprocess and communicates over line-delimited JSON."""

    def __init__(
        self,
        *,
        binary_path: Optional[str] = None,
        binary_args: Optional[list[str]] = None,
        broker_name: Optional[str] = None,
        channels: Optional[list[str]] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        request_timeout_ms: int = 10_000,
        shutdown_timeout_ms: int = 3_000,
        client_name: str = "agent-relay-sdk-py",
        client_version: str = "0.3.0",
    ):
        self._binary_path = binary_path or _resolve_default_binary_path()
        self._binary_args = binary_args or []
        self._broker_name = broker_name or os.path.basename(cwd or os.getcwd()) or "project"
        self._channels = channels or ["general"]
        self._cwd = cwd or os.getcwd()
        self._env = env
        self._request_timeout_ms = request_timeout_ms
        self._shutdown_timeout_ms = shutdown_timeout_ms
        self._client_name = client_name
        self._client_version = client_version

        self._process: Optional[asyncio.subprocess.Process] = None
        self._request_seq = 0
        self._pending: dict[str, _PendingRequest] = {}
        self._event_listeners: list[Callable[[BrokerEvent], None]] = []
        self._stderr_listeners: list[Callable[[str], None]] = []
        self._event_buffer: list[BrokerEvent] = []
        self._max_buffer_size = 1000
        self._last_stderr_line: Optional[str] = None
        self._starting_lock = asyncio.Lock()
        self._started = False
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._stderr_task: Optional[asyncio.Task[None]] = None
        self._exit_future: Optional[asyncio.Future[None]] = None
        self.workspace_key: Optional[str] = None

    @classmethod
    async def start(cls, **kwargs: Any) -> AgentRelayClient:
        client = cls(**kwargs)
        await client.start_client()
        return client

    # ── Event subscription ────────────────────────────────────────────────

    def on_event(self, listener: Callable[[BrokerEvent], None]) -> Callable[[], None]:
        self._event_listeners.append(listener)

        def unsubscribe() -> None:
            try:
                self._event_listeners.remove(listener)
            except ValueError:
                pass

        return unsubscribe

    def on_broker_stderr(self, listener: Callable[[str], None]) -> Callable[[], None]:
        self._stderr_listeners.append(listener)

        def unsubscribe() -> None:
            try:
                self._stderr_listeners.remove(listener)
            except ValueError:
                pass

        return unsubscribe

    def query_events(
        self,
        *,
        kind: Optional[str] = None,
        name: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[BrokerEvent]:
        events = list(self._event_buffer)
        if kind:
            events = [e for e in events if e.get("kind") == kind]
        if name:
            events = [e for e in events if e.get("name") == name]
        if limit is not None:
            events = events[-limit:]
        return events

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def start_client(self) -> None:
        if self._started:
            return
        async with self._starting_lock:
            if self._started:
                return
            await self._start_internal()

    async def _start_internal(self) -> None:
        resolved_binary = _expand_tilde(self._binary_path)
        if _is_explicit_path(self._binary_path) and not Path(resolved_binary).exists():
            raise AgentRelayProcessError(f"broker binary not found: {self._binary_path}")

        args = [
            "init",
            "--name",
            self._broker_name,
            "--channels",
            ",".join(self._channels),
            *self._binary_args,
        ]

        env = dict(self._env) if self._env else dict(os.environ)
        if _is_explicit_path(self._binary_path):
            bin_dir = str(Path(resolved_binary).resolve().parent)
            current_path = env.get("PATH", "")
            if bin_dir not in current_path.split(os.pathsep):
                env["PATH"] = f"{bin_dir}{os.pathsep}{current_path}"

        self._last_stderr_line = None

        self._process = await asyncio.create_subprocess_exec(
            resolved_binary,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
            env=env,
        )

        loop = asyncio.get_running_loop()
        self._exit_future = loop.create_future()

        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

        # Monitor process exit
        asyncio.create_task(self._monitor_exit())

        # Hello handshake
        hello_ack = await self._request_hello()
        self._started = True
        if hello_ack.get("workspace_key"):
            self.workspace_key = hello_ack["workspace_key"]

    async def _monitor_exit(self) -> None:
        if not self._process:
            return
        code = await self._process.wait()
        detail = f": {self._last_stderr_line}" if self._last_stderr_line else ""
        error = AgentRelayProcessError(f"broker exited (code={code}){detail}")
        self._fail_all_pending(error)
        if self._exit_future and not self._exit_future.done():
            self._exit_future.set_result(None)

    async def _read_stdout(self) -> None:
        assert self._process and self._process.stdout
        while True:
            line = await self._process.stdout.readline()
            if not line:
                break
            self._handle_stdout_line(line.decode("utf-8", errors="replace").rstrip("\n"))

    async def _read_stderr(self) -> None:
        assert self._process and self._process.stderr
        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            trimmed = text.strip()
            if trimmed:
                self._last_stderr_line = trimmed
            for listener in self._stderr_listeners:
                listener(text)

    def _handle_stdout_line(self, line: str) -> None:
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            return

        if not isinstance(parsed, dict):
            return
        if parsed.get("v") != PROTOCOL_VERSION or not isinstance(parsed.get("type"), str):
            return

        envelope = ProtocolEnvelope.from_dict(parsed)

        # Events are dispatched to listeners (no request_id)
        if envelope.type == "event":
            event: BrokerEvent = envelope.payload
            self._event_buffer.append(event)
            if len(self._event_buffer) > self._max_buffer_size:
                self._event_buffer.pop(0)
            for listener in self._event_listeners:
                listener(event)
            return

        # Responses are correlated to pending requests
        if not envelope.request_id:
            return

        pending = self._pending.pop(envelope.request_id, None)
        if not pending:
            return

        pending.timeout_handle.cancel()

        if envelope.type == "error":
            payload = envelope.payload
            pending.future.set_exception(
                AgentRelayProtocolError(
                    code=payload.get("code", "unknown"),
                    message=payload.get("message", "unknown error"),
                    retryable=payload.get("retryable", False),
                    data=payload.get("data"),
                )
            )
            return

        if envelope.type != pending.expected_type:
            pending.future.set_exception(
                AgentRelayProcessError(
                    f"unexpected response type '{envelope.type}' for request "
                    f"'{envelope.request_id}' (expected '{pending.expected_type}')"
                )
            )
            return

        pending.future.set_result(envelope)

    def _fail_all_pending(self, error: Exception) -> None:
        for pending in self._pending.values():
            pending.timeout_handle.cancel()
            if not pending.future.done():
                pending.future.set_exception(error)
        self._pending.clear()

    # ── Request helpers ───────────────────────────────────────────────────

    async def _send_request(self, type_: str, payload: Any, expected_type: str) -> ProtocolEnvelope:
        if not self._process or not self._process.stdin:
            raise AgentRelayProcessError("broker is not running")

        self._request_seq += 1
        request_id = f"req_{self._request_seq}"

        envelope = ProtocolEnvelope(
            v=PROTOCOL_VERSION,
            type=type_,
            payload=payload,
            request_id=request_id,
        )

        loop = asyncio.get_running_loop()
        future: asyncio.Future[ProtocolEnvelope] = loop.create_future()

        def on_timeout() -> None:
            self._pending.pop(request_id, None)
            if not future.done():
                future.set_exception(
                    AgentRelayProcessError(
                        f"request timed out after {self._request_timeout_ms}ms "
                        f"(type='{type_}', request_id='{request_id}')"
                    )
                )

        timeout_handle = loop.call_later(self._request_timeout_ms / 1000, on_timeout)
        self._pending[request_id] = _PendingRequest(expected_type, future, timeout_handle)

        line = json.dumps(envelope.to_dict()) + "\n"
        self._process.stdin.write(line.encode("utf-8"))
        await self._process.stdin.drain()

        return await future

    async def _request_hello(self) -> dict[str, Any]:
        payload = {
            "client_name": self._client_name,
            "client_version": self._client_version,
        }
        frame = await self._send_request("hello", payload, "hello_ack")
        return frame.payload

    async def _request_ok(self, type_: str, payload: Any) -> Any:
        frame = await self._send_request(type_, payload, "ok")
        return frame.payload.get("result")

    # ── Public API methods ────────────────────────────────────────────────

    async def spawn_pty(
        self,
        *,
        name: str,
        cli: str,
        args: Optional[list[str]] = None,
        channels: Optional[list[str]] = None,
        task: Optional[str] = None,
        model: Optional[str] = None,
        cwd: Optional[str] = None,
        team: Optional[str] = None,
        shadow_of: Optional[str] = None,
        shadow_mode: Optional[str] = None,
        idle_threshold_secs: Optional[int] = None,
        restart_policy: Optional[dict[str, Any]] = None,
        continue_from: Optional[str] = None,
    ) -> dict[str, Any]:
        await self.start_client()
        built_args = _build_pty_args_with_model(cli, args or [], model)
        from .protocol import RestartPolicy as ProtocolRestartPolicy
        rp = None
        if restart_policy:
            rp = ProtocolRestartPolicy(**restart_policy)
        agent = AgentSpec(
            name=name,
            runtime="pty",
            cli=cli,
            args=built_args,
            channels=channels or [],
            model=model,
            cwd=cwd or self._cwd,
            team=team,
            shadow_of=shadow_of,
            shadow_mode=shadow_mode,
            restart_policy=rp,
        )
        request_payload: dict[str, Any] = {"agent": agent.to_dict()}
        if task is not None:
            request_payload["initial_task"] = task
        if idle_threshold_secs is not None:
            request_payload["idle_threshold_secs"] = idle_threshold_secs
        if continue_from is not None:
            request_payload["continue_from"] = continue_from
        return await self._request_ok("spawn_agent", request_payload)

    async def spawn_headless_claude(
        self,
        *,
        name: str,
        args: Optional[list[str]] = None,
        channels: Optional[list[str]] = None,
        task: Optional[str] = None,
    ) -> dict[str, Any]:
        await self.start_client()
        agent = AgentSpec(
            name=name,
            runtime="headless_claude",
            args=args or [],
            channels=channels or [],
        )
        request_payload: dict[str, Any] = {"agent": agent.to_dict()}
        if task is not None:
            request_payload["initial_task"] = task
        return await self._request_ok("spawn_agent", request_payload)

    async def release(self, name: str, reason: Optional[str] = None) -> dict[str, Any]:
        await self.start_client()
        payload: dict[str, Any] = {"name": name}
        if reason is not None:
            payload["reason"] = reason
        return await self._request_ok("release_agent", payload)

    async def send_input(self, name: str, data: str) -> dict[str, Any]:
        await self.start_client()
        return await self._request_ok("send_input", {"name": name, "data": data})

    async def set_model(self, name: str, model: str, *, timeout_ms: Optional[int] = None) -> dict[str, Any]:
        await self.start_client()
        payload: dict[str, Any] = {"name": name, "model": model}
        if timeout_ms is not None:
            payload["timeout_ms"] = timeout_ms
        return await self._request_ok("set_model", payload)

    async def send_message(
        self,
        *,
        to: str,
        text: str,
        from_: Optional[str] = None,
        thread_id: Optional[str] = None,
        priority: Optional[int] = None,
        data: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        await self.start_client()
        payload: dict[str, Any] = {"to": to, "text": text}
        if from_ is not None:
            payload["from"] = from_
        if thread_id is not None:
            payload["thread_id"] = thread_id
        if priority is not None:
            payload["priority"] = priority
        if data is not None:
            payload["data"] = data
        try:
            return await self._request_ok("send_message", payload)
        except AgentRelayProtocolError as e:
            if e.code == "unsupported_operation":
                return {"event_id": "unsupported_operation", "targets": []}
            raise

    async def list_agents(self) -> list[dict[str, Any]]:
        await self.start_client()
        result = await self._request_ok("list_agents", {})
        return result.get("agents", []) if isinstance(result, dict) else []

    async def get_status(self) -> dict[str, Any]:
        await self.start_client()
        return await self._request_ok("get_status", {})

    async def get_metrics(self, agent: Optional[str] = None) -> dict[str, Any]:
        await self.start_client()
        return await self._request_ok("get_metrics", {"agent": agent} if agent else {})

    async def get_crash_insights(self) -> dict[str, Any]:
        await self.start_client()
        return await self._request_ok("get_crash_insights", {})

    async def preflight_agents(self, agents: list[dict[str, str]]) -> None:
        if not agents:
            return
        await self.start_client()
        await self._request_ok("preflight_agents", {"agents": agents})

    async def shutdown(self) -> None:
        if not self._process:
            return

        try:
            await self._request_ok("shutdown", {})
        except Exception:
            pass

        process = self._process
        try:
            await asyncio.wait_for(
                self._exit_future if self._exit_future else asyncio.sleep(0),
                timeout=self._shutdown_timeout_ms / 1000,
            )
        except asyncio.TimeoutError:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.kill()

        # Clean up reader tasks
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        if self._stderr_task and not self._stderr_task.done():
            self._stderr_task.cancel()

        self._process = None
        self._started = False

    async def wait_for_exit(self) -> None:
        if self._exit_future:
            await self._exit_future
