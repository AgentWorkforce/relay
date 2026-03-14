"""Pi RPC adapter for on_relay().

Spawns Pi (a TypeScript coding agent) as a subprocess in RPC mode and bridges
relay communication over its stdin/stdout JSONL protocol.
"""

from __future__ import annotations

import json
import subprocess
import threading
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from ..core import Relay

RELAY_TOOL_PREAMBLE = (
    "You have access to the following relay tools for multi-agent communication:\n"
    "- relay_send(to, text): Send a direct message to another relay agent.\n"
    "- relay_inbox(): Drain and inspect newly received relay messages.\n"
    "- relay_post(channel, text): Post a message to a relay channel.\n"
    "- relay_agents(): List currently online relay agents.\n"
)


class PiRpcSession:
    """Manages a Pi subprocess in RPC mode with relay integration."""

    def __init__(
        self,
        proc: subprocess.Popen[str],
        relay: "Relay",
    ) -> None:
        self._proc = proc
        self._relay = relay
        self._is_streaming = False
        self._unsubscribe: Callable[[], None] | None = None
        self._reader_thread: threading.Thread | None = None
        self._event_callbacks: list[Callable[[dict[str, Any]], None]] = []
        self._closed = False

    @property
    def is_streaming(self) -> bool:
        return self._is_streaming

    def send_command(self, command: dict[str, Any]) -> None:
        """Send a JSONL command to Pi's stdin."""
        if self._proc.stdin is None:
            return
        line = json.dumps(command) + "\n"
        self._proc.stdin.write(line)
        self._proc.stdin.flush()

    def prompt(self, message: str, streaming_behavior: str | None = None) -> None:
        cmd: dict[str, Any] = {"type": "prompt", "message": message}
        if streaming_behavior:
            cmd["streamingBehavior"] = streaming_behavior
        self.send_command(cmd)

    def steer(self, message: str) -> None:
        self.send_command({"type": "prompt", "message": message, "streamingBehavior": "steer"})

    def follow_up(self, message: str) -> None:
        self.send_command({"type": "prompt", "message": message, "streamingBehavior": "followUp"})

    def abort(self) -> None:
        self.send_command({"type": "abort"})

    def on_event(self, callback: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._event_callbacks.append(callback)

        def unsubscribe() -> None:
            try:
                self._event_callbacks.remove(callback)
            except ValueError:
                pass

        return unsubscribe

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()


def _format_relay_message(message: Any) -> str:
    location = f" [#{message.channel}]" if getattr(message, "channel", None) else ""
    return f"Relay message from {message.sender}{location}: {message.text}"


def _start_reader(session: PiRpcSession) -> None:
    def _read_stdout() -> None:
        proc = session._proc
        if proc.stdout is None:
            return
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type", "")
            if event_type in ("agent_start", "turn_start"):
                session._is_streaming = True
            elif event_type in ("agent_end", "turn_end"):
                session._is_streaming = False
            for cb in list(session._event_callbacks):
                cb(event)

    thread = threading.Thread(target=_read_stdout, daemon=True)
    thread.start()
    session._reader_thread = thread


def on_relay(
    name: str,
    config: dict[str, Any] | None = None,
    relay: "Relay | None" = None,
) -> PiRpcSession:
    """Spawn Pi in RPC mode and bridge relay communication.

    Args:
        name: Agent name for relay registration.
        config: Optional dict with ``model``, ``provider``, or extra Pi CLI flags.
        relay: Optional pre-configured Relay instance.

    Returns:
        A :class:`PiRpcSession` managing the subprocess and relay bridge.
    """
    if config is None:
        config = {}
    if relay is None:
        from ..core import Relay

        relay = Relay(name)

    cmd = ["pi", "--mode", "rpc", "--no-session"]
    if "model" in config:
        cmd.extend(["--model", config["model"]])
    if "provider" in config:
        cmd.extend(["--provider", config["provider"]])

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    session = PiRpcSession(proc, relay)

    def handle_relay_message(message: Any) -> None:
        formatted = _format_relay_message(message)
        if session.is_streaming:
            session.steer(formatted)
        else:
            session.follow_up(formatted)

    session._unsubscribe = relay.on_message(handle_relay_message)

    _start_reader(session)

    return session
