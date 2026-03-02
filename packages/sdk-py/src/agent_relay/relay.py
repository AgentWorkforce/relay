"""High-level facade for the Agent Relay SDK.

Provides a clean, property-based API on top of the lower-level
AgentRelayClient protocol client.

Mirrors packages/sdk/src/relay.ts.
"""

from __future__ import annotations

import asyncio
import os
import secrets
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .client import AgentRelayClient, AgentRelayProtocolError
from .protocol import AgentRuntime, BrokerEvent

# ── Public types ──────────────────────────────────────────────────────────────

AgentStatus = str  # "spawning" | "ready" | "idle" | "exited"

EventHook = Optional[Callable[..., None]]


@dataclass
class Message:
    """A relay message between agents."""

    event_id: str
    from_name: str
    to: str
    text: str
    thread_id: Optional[str] = None
    data: Optional[dict[str, Any]] = None


@dataclass
class SpawnOptions:
    """Options for spawning an agent."""

    args: list[str] = field(default_factory=list)
    channels: list[str] = field(default_factory=list)
    model: Optional[str] = None
    cwd: Optional[str] = None
    team: Optional[str] = None
    shadow_of: Optional[str] = None
    shadow_mode: Optional[str] = None
    idle_threshold_secs: Optional[int] = None
    restart_policy: Optional[dict[str, Any]] = None


# ── Agent handle ──────────────────────────────────────────────────────────────


class Agent:
    """Handle for a spawned agent with lifecycle methods."""

    def __init__(
        self,
        name: str,
        runtime: AgentRuntime,
        channels: list[str],
        relay: AgentRelay,
    ):
        self._name = name
        self._runtime = runtime
        self._channels = channels
        self._relay = relay
        self.exit_code: Optional[int] = None
        self.exit_signal: Optional[str] = None
        self.exit_reason: Optional[str] = None

    @property
    def name(self) -> str:
        return self._name

    @property
    def runtime(self) -> AgentRuntime:
        return self._runtime

    @property
    def channels(self) -> list[str]:
        return self._channels

    @property
    def status(self) -> AgentStatus:
        if self._name in self._relay._exited_agents:
            return "exited"
        if self._name in self._relay._idle_agents:
            return "idle"
        if self._name in self._relay._ready_agents:
            return "ready"
        return "spawning"

    async def release(self, reason: Optional[str] = None) -> None:
        client = await self._relay._ensure_started()
        await client.release(self._name, reason)

    async def wait_for_ready(self, timeout_ms: int = 60_000) -> None:
        await self._relay.wait_for_agent_ready(self._name, timeout_ms)

    async def wait_for_exit(self, timeout_ms: Optional[int] = None) -> str:
        """Wait for agent to exit. Returns 'exited', 'released', or 'timeout'."""
        if self._name not in self._relay._known_agents:
            return "exited"
        if timeout_ms == 0:
            return "timeout"

        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._relay._exit_resolvers[self._name] = future

        if timeout_ms is not None:
            try:
                return await asyncio.wait_for(future, timeout=timeout_ms / 1000)
            except asyncio.TimeoutError:
                self._relay._exit_resolvers.pop(self._name, None)
                return "timeout"
        else:
            return await future

    async def wait_for_idle(self, timeout_ms: Optional[int] = None) -> str:
        """Wait for agent to go idle. Returns 'idle', 'exited', or 'timeout'."""
        if self._name not in self._relay._known_agents:
            return "exited"
        if timeout_ms == 0:
            return "timeout"

        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._relay._idle_resolvers[self._name] = future

        if timeout_ms is not None:
            try:
                return await asyncio.wait_for(future, timeout=timeout_ms / 1000)
            except asyncio.TimeoutError:
                self._relay._idle_resolvers.pop(self._name, None)
                return "timeout"
        else:
            return await future

    async def send_message(
        self,
        *,
        to: str,
        text: str,
        thread_id: Optional[str] = None,
        priority: Optional[int] = None,
        data: Optional[dict[str, Any]] = None,
    ) -> Message:
        client = await self._relay._ensure_started()
        try:
            result = await client.send_message(
                to=to,
                text=text,
                from_=self._name,
                thread_id=thread_id,
                priority=priority,
                data=data,
            )
        except AgentRelayProtocolError as e:
            if e.code == "unsupported_operation":
                return Message(
                    event_id="unsupported_operation",
                    from_name=self._name,
                    to=to,
                    text=text,
                    thread_id=thread_id,
                    data=data,
                )
            raise

        event_id = result.get("event_id", secrets.token_hex(8))
        msg = Message(
            event_id=event_id,
            from_name=self._name,
            to=to,
            text=text,
            thread_id=thread_id,
            data=data,
        )
        if self._relay.on_message_sent:
            self._relay.on_message_sent(msg)
        return msg

    def on_output(self, callback: Callable[[str], None]) -> Callable[[], None]:
        listeners = self._relay._output_listeners.setdefault(self._name, [])
        listeners.append(callback)

        def unsubscribe() -> None:
            try:
                listeners.remove(callback)
            except ValueError:
                pass
            if not listeners:
                self._relay._output_listeners.pop(self._name, None)

        return unsubscribe


# ── Human handle ──────────────────────────────────────────────────────────────


class HumanHandle:
    """A messaging handle for human/system messages."""

    def __init__(self, name: str, relay: AgentRelay):
        self._name = name
        self._relay = relay

    @property
    def name(self) -> str:
        return self._name

    async def send_message(
        self,
        *,
        to: str,
        text: str,
        thread_id: Optional[str] = None,
        priority: Optional[int] = None,
        data: Optional[dict[str, Any]] = None,
    ) -> Message:
        client = await self._relay._ensure_started()
        try:
            result = await client.send_message(
                to=to,
                text=text,
                from_=self._name,
                thread_id=thread_id,
                priority=priority,
                data=data,
            )
        except AgentRelayProtocolError as e:
            if e.code == "unsupported_operation":
                return Message(
                    event_id="unsupported_operation",
                    from_name=self._name,
                    to=to,
                    text=text,
                    thread_id=thread_id,
                    data=data,
                )
            raise

        event_id = result.get("event_id", secrets.token_hex(8))
        msg = Message(
            event_id=event_id,
            from_name=self._name,
            to=to,
            text=text,
            thread_id=thread_id,
            data=data,
        )
        if self._relay.on_message_sent:
            self._relay.on_message_sent(msg)
        return msg


# ── Agent spawner ─────────────────────────────────────────────────────────────


class AgentSpawner:
    """Shorthand spawner for a specific CLI (e.g., relay.claude.spawn(...))."""

    def __init__(self, cli: str, default_name: str, relay: AgentRelay):
        self._cli = cli
        self._default_name = default_name
        self._relay = relay

    async def spawn(
        self,
        *,
        name: Optional[str] = None,
        args: Optional[list[str]] = None,
        channels: Optional[list[str]] = None,
        task: Optional[str] = None,
        model: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> Agent:
        agent_name = name or self._default_name
        agent_channels = channels or ["general"]
        client = await self._relay._ensure_started()

        result = await client.spawn_pty(
            name=agent_name,
            cli=self._cli,
            args=args or [],
            channels=agent_channels,
            task=task,
            model=model,
            cwd=cwd,
        )

        agent = Agent(
            name=result.get("name", agent_name),
            runtime=result.get("runtime", "pty"),
            channels=agent_channels,
            relay=self._relay,
        )
        self._relay._known_agents[agent.name] = agent
        self._relay._ready_agents.discard(agent.name)
        self._relay._message_ready_agents.discard(agent.name)
        self._relay._exited_agents.discard(agent.name)
        self._relay._idle_agents.discard(agent.name)
        return agent


# ── AgentRelay facade ─────────────────────────────────────────────────────────


class AgentRelay:
    """High-level facade for the Agent Relay SDK.

    Example::

        relay = AgentRelay(channels=["GTM"])
        relay.on_message_received = lambda msg: print(f"[{msg.from_name}]: {msg.text}")

        await relay.claude.spawn(name="Analyst", model="opus", channels=["GTM"], task="Analyze")
        await relay.wait_for_agent_ready("Analyst")
        await relay.shutdown()
    """

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
    ):
        # Event hooks — assign a callback or None to clear
        self.on_message_received: EventHook = None
        self.on_message_sent: EventHook = None
        self.on_agent_spawned: EventHook = None
        self.on_agent_released: EventHook = None
        self.on_agent_exited: EventHook = None
        self.on_agent_ready: EventHook = None
        self.on_worker_output: EventHook = None
        self.on_delivery_update: EventHook = None
        self.on_agent_exit_requested: EventHook = None
        self.on_agent_idle: EventHook = None

        self._default_channels = channels or ["general"]
        self._client_kwargs: dict[str, Any] = {
            "binary_path": binary_path,
            "binary_args": binary_args,
            "broker_name": broker_name,
            "channels": self._default_channels,
            "cwd": cwd,
            "env": env,
            "request_timeout_ms": request_timeout_ms,
            "shutdown_timeout_ms": shutdown_timeout_ms,
        }

        self._client: Optional[AgentRelayClient] = None
        self._start_lock = asyncio.Lock()
        self._unsubscribe_event: Optional[Callable[[], None]] = None

        # Agent tracking
        self._known_agents: dict[str, Agent] = {}
        self._ready_agents: set[str] = set()
        self._message_ready_agents: set[str] = set()
        self._exited_agents: set[str] = set()
        self._idle_agents: set[str] = set()
        self._output_listeners: dict[str, list[Callable[[str], None]]] = {}
        self._exit_resolvers: dict[str, asyncio.Future[str]] = {}
        self._idle_resolvers: dict[str, asyncio.Future[str]] = {}

        # Shorthand spawners
        self.codex = AgentSpawner("codex", "Codex", self)
        self.claude = AgentSpawner("claude", "Claude", self)
        self.gemini = AgentSpawner("gemini", "Gemini", self)

    @property
    def workspace_key(self) -> Optional[str]:
        return self._client.workspace_key if self._client else None

    # ── Internal startup ──────────────────────────────────────────────────

    async def _ensure_started(self) -> AgentRelayClient:
        if self._client:
            return self._client
        async with self._start_lock:
            if self._client:
                return self._client

            # Ensure env has RELAY_API_KEY if available
            env = self._client_kwargs.get("env")
            if env is None:
                env_key = os.environ.get("RELAY_API_KEY")
                if env_key:
                    self._client_kwargs["env"] = {**os.environ, "RELAY_API_KEY": env_key}
                else:
                    self._client_kwargs["env"] = dict(os.environ)

            # Remove None values to use defaults
            kwargs = {k: v for k, v in self._client_kwargs.items() if v is not None}
            client = AgentRelayClient(**kwargs)
            await client.start_client()

            self._client = client
            if client.workspace_key:
                pass  # workspace_key is available via property

            self._wire_events(client)
            return client

    # ── Spawning ──────────────────────────────────────────────────────────

    async def spawn(
        self,
        name: str,
        cli: str,
        task: Optional[str] = None,
        options: Optional[SpawnOptions] = None,
    ) -> Agent:
        client = await self._ensure_started()
        opts = options or SpawnOptions()
        channels = opts.channels or ["general"]

        result = await client.spawn_pty(
            name=name,
            cli=cli,
            task=task,
            args=opts.args,
            channels=channels,
            model=opts.model,
            cwd=opts.cwd,
            team=opts.team,
            shadow_of=opts.shadow_of,
            shadow_mode=opts.shadow_mode,
            idle_threshold_secs=opts.idle_threshold_secs,
            restart_policy=opts.restart_policy,
        )

        self._ready_agents.discard(name)
        self._message_ready_agents.discard(name)
        self._exited_agents.discard(name)
        self._idle_agents.discard(name)
        agent = Agent(
            name=result.get("name", name),
            runtime=result.get("runtime", "pty"),
            channels=channels,
            relay=self,
        )
        self._known_agents[agent.name] = agent
        return agent

    async def spawn_and_wait(
        self,
        name: str,
        cli: str,
        task: str,
        options: Optional[SpawnOptions] = None,
        timeout_ms: int = 60_000,
        wait_for_message: bool = False,
    ) -> Agent:
        await self.spawn(name, cli, task, options)
        if wait_for_message:
            return await self.wait_for_agent_message(name, timeout_ms)
        return await self.wait_for_agent_ready(name, timeout_ms)

    # ── Human/system messaging ────────────────────────────────────────────

    def human(self, name: str) -> HumanHandle:
        return HumanHandle(name, self)

    def system(self) -> HumanHandle:
        return HumanHandle("system", self)

    async def broadcast(self, text: str, *, from_name: str = "human:orchestrator") -> Message:
        return await self.human(from_name).send_message(to="*", text=text)

    # ── Listing / status ──────────────────────────────────────────────────

    async def list_agents(self) -> list[Agent]:
        client = await self._ensure_started()
        raw_list = await client.list_agents()
        agents = []
        for entry in raw_list:
            name = entry.get("name", "")
            existing = self._known_agents.get(name)
            if existing:
                agents.append(existing)
            else:
                agent = Agent(
                    name=name,
                    runtime=entry.get("runtime", "pty"),
                    channels=entry.get("channels", []),
                    relay=self,
                )
                self._known_agents[name] = agent
                agents.append(agent)
        return agents

    async def preflight_agents(self, agents: list[dict[str, str]]) -> None:
        client = await self._ensure_started()
        await client.preflight_agents(agents)

    async def get_status(self) -> dict[str, Any]:
        client = await self._ensure_started()
        return await client.get_status()

    # ── Wait helpers ──────────────────────────────────────────────────────

    async def wait_for_agent_ready(self, name: str, timeout_ms: int = 60_000) -> Agent:
        client = await self._ensure_started()
        existing = self._known_agents.get(name)
        if existing and name in self._ready_agents:
            return existing

        future: asyncio.Future[Agent] = asyncio.get_running_loop().create_future()

        def on_event(event: BrokerEvent) -> None:
            if event.get("kind") != "worker_ready" or event.get("name") != name:
                return
            agent = self._ensure_agent_handle(name, event.get("runtime", "pty"))
            self._ready_agents.add(name)
            self._exited_agents.discard(name)
            if not future.done():
                future.set_result(agent)

        unsub = client.on_event(on_event)
        try:
            # Check again after subscribing (race condition guard)
            known = self._known_agents.get(name)
            if known and name in self._ready_agents:
                return known
            return await asyncio.wait_for(future, timeout=timeout_ms / 1000)
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"Timed out waiting for worker_ready for '{name}' after {timeout_ms}ms"
            ) from None
        finally:
            unsub()

    async def wait_for_agent_message(self, name: str, timeout_ms: int = 60_000) -> Agent:
        client = await self._ensure_started()
        existing = self._known_agents.get(name)
        if existing and name in self._message_ready_agents:
            return existing

        future: asyncio.Future[Agent] = asyncio.get_running_loop().create_future()

        def on_event(event: BrokerEvent) -> None:
            if future.done():
                return
            if event.get("kind") == "relay_inbound" and event.get("from") == name:
                self._message_ready_agents.add(name)
                self._exited_agents.discard(name)
                future.set_result(self._ensure_agent_handle(name))
            elif event.get("kind") == "agent_exited" and event.get("name") == name:
                future.set_exception(
                    RuntimeError(f"Agent '{name}' exited before sending its first relay message")
                )

        unsub = client.on_event(on_event)
        try:
            known = self._known_agents.get(name)
            if known and name in self._message_ready_agents:
                return known
            return await asyncio.wait_for(future, timeout=timeout_ms / 1000)
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"Timed out waiting for first relay message from '{name}' after {timeout_ms}ms"
            ) from None
        finally:
            unsub()

    @staticmethod
    async def wait_for_any(
        agents: list[Agent], timeout_ms: Optional[int] = None
    ) -> tuple[Agent, str]:
        """Wait for any agent to exit. Returns (agent, result) tuple."""
        if not agents:
            raise ValueError("wait_for_any requires at least one agent")

        async def _wait(agent: Agent) -> tuple[Agent, str]:
            result = await agent.wait_for_exit(timeout_ms)
            return (agent, result)

        done, pending = await asyncio.wait(
            [asyncio.create_task(_wait(a)) for a in agents],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        return done.pop().result()

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def shutdown(self) -> None:
        if self._unsubscribe_event:
            self._unsubscribe_event()
            self._unsubscribe_event = None
        if self._client:
            await self._client.shutdown()
            self._client = None

        self._known_agents.clear()
        self._ready_agents.clear()
        self._message_ready_agents.clear()
        self._exited_agents.clear()
        self._idle_agents.clear()
        self._output_listeners.clear()

        for future in self._exit_resolvers.values():
            if not future.done():
                future.set_result("released")
        self._exit_resolvers.clear()
        for future in self._idle_resolvers.values():
            if not future.done():
                future.set_result("exited")
        self._idle_resolvers.clear()

    # ── Private helpers ───────────────────────────────────────────────────

    def _ensure_agent_handle(
        self, name: str, runtime: AgentRuntime = "pty", channels: Optional[list[str]] = None,
    ) -> Agent:
        existing = self._known_agents.get(name)
        if existing:
            return existing
        agent = Agent(name, runtime, channels or [], self)
        self._known_agents[name] = agent
        return agent

    def _wire_events(self, client: AgentRelayClient) -> None:
        def on_event(event: BrokerEvent) -> None:
            kind = event.get("kind")
            name = event.get("name", "")

            if kind == "relay_inbound":
                from_name = event.get("from", "")
                if from_name in self._known_agents:
                    self._message_ready_agents.add(from_name)
                    self._exited_agents.discard(from_name)
                msg = Message(
                    event_id=event.get("event_id", ""),
                    from_name=event.get("from", ""),
                    to=event.get("target", ""),
                    text=event.get("body", ""),
                    thread_id=event.get("thread_id"),
                )
                if self.on_message_received:
                    self.on_message_received(msg)

            elif kind == "agent_spawned":
                agent = self._ensure_agent_handle(name, event.get("runtime", "pty"))
                self._ready_agents.discard(name)
                self._message_ready_agents.discard(name)
                self._exited_agents.discard(name)
                self._idle_agents.discard(name)
                if self.on_agent_spawned:
                    self.on_agent_spawned(agent)

            elif kind == "agent_released":
                agent = self._known_agents.get(name) or self._ensure_agent_handle(name)
                self._exited_agents.add(name)
                self._ready_agents.discard(name)
                self._message_ready_agents.discard(name)
                self._idle_agents.discard(name)
                if self.on_agent_released:
                    self.on_agent_released(agent)
                self._known_agents.pop(name, None)
                self._output_listeners.pop(name, None)
                future = self._exit_resolvers.pop(name, None)
                if future and not future.done():
                    future.set_result("released")
                idle_future = self._idle_resolvers.pop(name, None)
                if idle_future and not idle_future.done():
                    idle_future.set_result("exited")

            elif kind == "agent_exited":
                agent = self._known_agents.get(name) or self._ensure_agent_handle(name)
                self._exited_agents.add(name)
                self._ready_agents.discard(name)
                self._message_ready_agents.discard(name)
                self._idle_agents.discard(name)
                agent.exit_code = event.get("code")
                agent.exit_signal = event.get("signal")
                if self.on_agent_exited:
                    self.on_agent_exited(agent)
                self._known_agents.pop(name, None)
                self._output_listeners.pop(name, None)
                future = self._exit_resolvers.pop(name, None)
                if future and not future.done():
                    future.set_result("exited")
                idle_future = self._idle_resolvers.pop(name, None)
                if idle_future and not idle_future.done():
                    idle_future.set_result("exited")

            elif kind == "agent_exit":
                agent = self._known_agents.get(name) or self._ensure_agent_handle(name)
                agent.exit_reason = event.get("reason", "")
                if self.on_agent_exit_requested:
                    self.on_agent_exit_requested({"name": name, "reason": event.get("reason", "")})

            elif kind == "worker_ready":
                agent = self._ensure_agent_handle(name, event.get("runtime", "pty"))
                self._ready_agents.add(name)
                self._exited_agents.discard(name)
                self._idle_agents.discard(name)
                if self.on_agent_ready:
                    self.on_agent_ready(agent)

            elif kind == "worker_stream":
                self._idle_agents.discard(name)
                if self.on_worker_output:
                    self.on_worker_output({
                        "name": name,
                        "stream": event.get("stream", ""),
                        "chunk": event.get("chunk", ""),
                    })
                # Per-agent output listeners
                listeners = self._output_listeners.get(name, [])
                for listener in listeners:
                    listener(event.get("chunk", ""))

            elif kind == "agent_idle":
                self._idle_agents.add(name)
                if self.on_agent_idle:
                    self.on_agent_idle({
                        "name": name,
                        "idle_secs": event.get("idle_secs", 0),
                    })
                idle_future = self._idle_resolvers.pop(name, None)
                if idle_future and not idle_future.done():
                    idle_future.set_result("idle")

            # Delivery events
            if kind and kind.startswith("delivery_"):
                if self.on_delivery_update:
                    self.on_delivery_update(event)

        self._unsubscribe_event = client.on_event(on_event)
