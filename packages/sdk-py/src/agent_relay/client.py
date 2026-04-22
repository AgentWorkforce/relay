"""Low-level async client for the Agent Relay broker.

Communicates with the broker over HTTP/WS. Can either connect to a
running broker (remote) or spawn a local broker process.

Mirrors packages/sdk/src/client.ts.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import secrets
import shutil
from pathlib import Path
from typing import Any, Callable, Literal, Optional
from urllib.parse import quote

import aiohttp

from .protocol import (
    BrokerEvent,
    MessageInjectionMode,
)

# ── Errors ────────────────────────────────────────────────────────────────────


class AgentRelayProtocolError(Exception):
    """Raised when the broker returns a protocol-level error."""

    def __init__(
        self, code: str, message: str, retryable: bool = False, data: Any = None
    ):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.data = data


class AgentRelayProcessError(Exception):
    """Raised for broker process lifecycle errors."""


AgentTransport = Literal["pty", "headless"]


def _is_headless_provider(value: str) -> bool:
    return value in {"claude", "opencode"}


def _resolve_spawn_transport(provider: str, transport: Optional[AgentTransport]) -> AgentTransport:
    if transport is not None:
        return transport
    return "headless" if provider == "opencode" else "pty"


# ── Binary resolution ─────────────────────────────────────────────────────────


def _resolve_default_binary_path() -> str:
    broker_exe = "agent-relay-broker"

    override = os.environ.get("BROKER_BINARY_PATH") or os.environ.get("AGENT_RELAY_BIN")
    if override and Path(override).exists():
        return override

    embedded = Path(__file__).parent / "bin" / broker_exe
    if embedded.exists():
        return str(embedded)

    found = shutil.which(broker_exe)
    if found:
        return found

    plat = f"{platform.system().lower()}-{platform.machine().lower()}"
    raise AgentRelayProcessError(
        "agent-relay-broker not found. The installed wheel does not include a "
        f"binary for this platform ({plat}). Supported platforms: darwin-arm64, "
        "darwin-x64, linux-x64, linux-arm64. Set BROKER_BINARY_PATH to override."
    )


# ── Client ────────────────────────────────────────────────────────────────────


class AgentRelayClient:
    """Communicates with a broker over HTTP/WS.

    Usage:
        # Remote broker
        client = AgentRelayClient(base_url="http://...", api_key="br_...")

        # Local broker (spawn)
        client = await AgentRelayClient.spawn(cwd="/my/project")
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: Optional[str] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._ws_task: Optional[asyncio.Task[None]] = None
        self._lease_task: Optional[asyncio.Task[None]] = None
        self._stderr_task: Optional[asyncio.Task[None]] = None
        self._process: Optional[asyncio.subprocess.Process] = None
        self._event_listeners: list[Callable[[BrokerEvent], None]] = []
        self._event_buffer: list[BrokerEvent] = []
        self._max_buffer_size = 1000
        self.workspace_key: Optional[str] = None

    @classmethod
    async def spawn(
        cls,
        *,
        binary_path: Optional[str] = None,
        binary_args: Optional[list[str]] = None,
        broker_name: Optional[str] = None,
        channels: Optional[list[str]] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        on_stderr: Optional[Callable[[str], None]] = None,
        startup_timeout_ms: int = 15_000,
    ) -> AgentRelayClient:
        """Spawn a local broker process and return a connected client."""
        resolved_binary = binary_path or _resolve_default_binary_path()
        resolved_cwd = cwd or os.getcwd()
        resolved_name = broker_name or os.path.basename(resolved_cwd) or "project"
        resolved_channels = channels or ["general"]
        user_args = binary_args or []

        api_key = f"br_{secrets.token_hex(16)}"

        spawn_env = {**os.environ, **env} if env else dict(os.environ)
        spawn_env["RELAY_BROKER_API_KEY"] = api_key

        args = [
            "init",
            "--name", resolved_name,
            "--channels", ",".join(resolved_channels),
            *user_args,
        ]

        process = await asyncio.create_subprocess_exec(
            resolved_binary, *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=resolved_cwd,
            env=spawn_env,
        )

        # Forward stderr
        async def _read_stderr() -> None:
            assert process.stderr
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\n")
                if on_stderr:
                    on_stderr(text)

        stderr_task = asyncio.create_task(_read_stderr())

        # Parse API URL from stdout
        base_url = await _wait_for_api_url(process, startup_timeout_ms)

        client = cls(base_url=base_url, api_key=api_key)
        client._stderr_task = stderr_task
        client._process = process

        # Broker may still be connecting to Relaycast after binding its API
        # listener. Retry get_session with backoff while it returns 503.
        # Mirrors packages/sdk/src/client.ts.
        session: Optional[dict[str, Any]] = None
        last_error: Optional[Exception] = None
        for attempt in range(10):
            try:
                session = await client.get_session()
                break
            except AgentRelayProtocolError as err:
                last_error = err
                is_503 = err.code == "http_503" or "Service Unavailable" in str(err)
                if not is_503 or attempt >= 9:
                    raise
                await asyncio.sleep(1.0)
        assert session is not None, last_error
        client.workspace_key = session.get("workspace_key")

        # Start event stream
        await client._connect_ws()

        # Start lease renewal
        client._lease_task = asyncio.create_task(client._renew_lease_loop())

        return client

    # ── HTTP helpers ──────────────────────────────────────────────────────

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            headers: dict[str, str] = {"Content-Type": "application/json"}
            if self._api_key:
                headers["X-API-Key"] = self._api_key
            self._session = aiohttp.ClientSession(headers=headers)
        return self._session

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        session = await self._ensure_session()
        async with session.request(method, f"{self._base_url}{path}", **kwargs) as resp:
            body = await resp.json() if resp.content_type == "application/json" else None
            if not resp.ok:
                code = body.get("code", f"http_{resp.status}") if body else f"http_{resp.status}"
                message = body.get("message", resp.reason) if body else (resp.reason or "unknown error")
                raise AgentRelayProtocolError(
                    code=code,
                    message=message,
                    retryable=resp.status >= 500,
                )
            return body

    # ── WebSocket events ──────────────────────────────────────────────────

    async def _connect_ws(self) -> None:
        session = await self._ensure_session()
        ws_url = self._base_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        self._ws = await session.ws_connect(ws_url)
        self._ws_task = asyncio.create_task(self._ws_reader())

    async def _ws_reader(self) -> None:
        if not self._ws:
            return
        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    event: BrokerEvent = json.loads(msg.data)
                    self._event_buffer.append(event)
                    if len(self._event_buffer) > self._max_buffer_size:
                        self._event_buffer.pop(0)
                    for listener in self._event_listeners:
                        try:
                            listener(event)
                        except Exception:
                            pass
                except (json.JSONDecodeError, ValueError):
                    pass
            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                break

    async def _renew_lease_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await self.renew_lease()
            except Exception:
                pass

    # ── Event subscription ────────────────────────────────────────────────

    def on_event(self, listener: Callable[[BrokerEvent], None]) -> Callable[[], None]:
        self._event_listeners.append(listener)
        def unsubscribe() -> None:
            try:
                self._event_listeners.remove(listener)
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

    # ── Session ───────────────────────────────────────────────────────────

    async def get_session(self) -> dict[str, Any]:
        result = await self._request("GET", "/api/session")
        if result and result.get("workspace_key"):
            self.workspace_key = result["workspace_key"]
        return result

    async def health_check(self) -> dict[str, Any]:
        return await self._request("GET", "/health")

    # ── Agent lifecycle ───────────────────────────────────────────────────

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
        skip_relay_prompt: Optional[bool] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": name,
            "cli": cli,
            "args": args or [],
            "channels": channels or [],
        }
        if task is not None: payload["task"] = task
        if model is not None: payload["model"] = model
        if cwd is not None: payload["cwd"] = cwd
        if team is not None: payload["team"] = team
        if shadow_of is not None: payload["shadowOf"] = shadow_of
        if shadow_mode is not None: payload["shadowMode"] = shadow_mode
        if idle_threshold_secs is not None: payload["idleThresholdSecs"] = idle_threshold_secs
        if restart_policy is not None: payload["restartPolicy"] = restart_policy
        if continue_from is not None: payload["continueFrom"] = continue_from
        if skip_relay_prompt is not None: payload["skipRelayPrompt"] = skip_relay_prompt
        return await self._request("POST", "/api/spawn", json=payload)

    async def spawn_provider(
        self,
        *,
        name: str,
        provider: str,
        transport: Optional[AgentTransport] = None,
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
        skip_relay_prompt: Optional[bool] = None,
    ) -> dict[str, Any]:
        resolved_transport = _resolve_spawn_transport(provider, transport)
        if resolved_transport == "headless" and not _is_headless_provider(provider):
            raise AgentRelayProcessError(
                f"provider '{provider}' does not support headless transport (supported: claude, opencode)"
            )

        payload: dict[str, Any] = {
            "name": name,
            "cli": provider,
            "args": args or [],
            "channels": channels or [],
            "transport": resolved_transport,
        }
        if task is not None: payload["task"] = task
        if model is not None: payload["model"] = model
        if cwd is not None: payload["cwd"] = cwd
        if team is not None: payload["team"] = team
        if shadow_of is not None: payload["shadowOf"] = shadow_of
        if shadow_mode is not None: payload["shadowMode"] = shadow_mode
        if idle_threshold_secs is not None: payload["idleThresholdSecs"] = idle_threshold_secs
        if restart_policy is not None: payload["restartPolicy"] = restart_policy
        if continue_from is not None: payload["continueFrom"] = continue_from
        if skip_relay_prompt is not None: payload["skipRelayPrompt"] = skip_relay_prompt
        return await self._request("POST", "/api/spawn", json=payload)

    async def release(self, name: str, reason: Optional[str] = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if reason is not None:
            kwargs["json"] = {"reason": reason}
        return await self._request("DELETE", f"/api/spawned/{quote(name, safe=str())}", **kwargs)

    async def list_agents(self) -> list[dict[str, Any]]:
        result = await self._request("GET", "/api/spawned")
        return result.get("agents", []) if isinstance(result, dict) else []

    # ── PTY control ───────────────────────────────────────────────────────

    async def send_input(self, name: str, data: str) -> dict[str, Any]:
        return await self._request("POST", f"/api/input/{quote(name, safe=str())}", json={"data": data})

    async def resize_pty(self, name: str, rows: int, cols: int) -> dict[str, Any]:
        return await self._request("POST", f"/api/resize/{quote(name, safe=str())}", json={"rows": rows, "cols": cols})

    # ── Messaging ─────────────────────────────────────────────────────────

    async def send_message(
        self,
        *,
        to: str,
        text: str,
        from_: Optional[str] = None,
        thread_id: Optional[str] = None,
        priority: Optional[int] = None,
        data: Optional[dict[str, Any]] = None,
        mode: Optional[MessageInjectionMode] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"to": to, "text": text}
        if from_ is not None: payload["from"] = from_
        if thread_id is not None: payload["threadId"] = thread_id
        if priority is not None: payload["priority"] = priority
        if data is not None: payload["data"] = data
        if mode is not None: payload["mode"] = mode
        try:
            return await self._request("POST", "/api/send", json=payload)
        except AgentRelayProtocolError as e:
            if e.code == "unsupported_operation":
                return {"event_id": "unsupported_operation", "targets": []}
            raise

    # ── Model control ─────────────────────────────────────────────────────

    async def set_model(
        self, name: str, model: str, *, timeout_ms: Optional[int] = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": model}
        if timeout_ms is not None:
            payload["timeout_ms"] = timeout_ms
        return await self._request("POST", f"/api/spawned/{quote(name, safe=str())}/model", json=payload)

    # ── Channels ──────────────────────────────────────────────────────────

    async def subscribe_channels(self, name: str, channels: list[str]) -> None:
        await self._request("POST", f"/api/spawned/{quote(name, safe=str())}/subscribe", json={"channels": channels})

    async def unsubscribe_channels(self, name: str, channels: list[str]) -> None:
        await self._request("POST", f"/api/spawned/{quote(name, safe=str())}/unsubscribe", json={"channels": channels})

    # ── Observability ─────────────────────────────────────────────────────

    async def get_status(self) -> dict[str, Any]:
        return await self._request("GET", "/api/status")

    async def get_metrics(self, agent: Optional[str] = None) -> dict[str, Any]:
        query = f"?agent={quote(agent, safe=str())}" if agent else ""
        return await self._request("GET", f"/api/metrics{query}")

    async def get_crash_insights(self) -> dict[str, Any]:
        return await self._request("GET", "/api/crash-insights")

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def preflight_agents(self, agents: list[dict[str, str]]) -> None:
        if not agents:
            return
        await self._request("POST", "/api/preflight", json={"agents": agents})

    async def renew_lease(self) -> dict[str, Any]:
        return await self._request("POST", "/api/session/renew")

    async def shutdown(self) -> None:
        if self._lease_task and not self._lease_task.done():
            self._lease_task.cancel()
            self._lease_task = None

        # Only send shutdown if we own the broker process
        if self._process:
            try:
                await self._request("POST", "/api/shutdown")
            except Exception:
                pass

        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._ws_task and not self._ws_task.done():
            self._ws_task.cancel()

        if self._stderr_task and not self._stderr_task.done():
            self._stderr_task.cancel()

        if self._session and not self._session.closed:
            await self._session.close()

        if self._process:
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self._process.kill()
            self._process = None

    async def wait_for_exit(self) -> None:
        if self._process:
            await self._process.wait()

    @property
    def broker_pid(self) -> Optional[int]:
        return self._process.pid if self._process else None


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _wait_for_api_url(
    process: asyncio.subprocess.Process,
    timeout_ms: int,
) -> str:
    """Parse the API URL from the broker's stdout.

    The broker prints: [agent-relay] API listening on http://{bind}:{port}
    Returns the full URL (e.g. "http://127.0.0.1:3889").
    """
    import re

    assert process.stdout
    pattern = re.compile(r"API listening on (https?://\S+)")

    async def _read() -> str:
        assert process.stdout
        while True:
            line_bytes = await process.stdout.readline()
            if not line_bytes:
                raise AgentRelayProcessError(
                    f"Broker process exited with code {process.returncode} before becoming ready"
                )
            line = line_bytes.decode("utf-8", errors="replace").rstrip("\n")
            match = pattern.search(line)
            if match:
                return match.group(1)

    try:
        return await asyncio.wait_for(_read(), timeout=timeout_ms / 1000)
    except asyncio.TimeoutError:
        raise AgentRelayProcessError(
            f"Broker did not report API URL within {timeout_ms}ms"
        ) from None
