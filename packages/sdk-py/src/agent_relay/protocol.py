"""Wire protocol types for the Agent Relay broker.

Matches the TypeScript definitions in packages/sdk/src/protocol.ts.
"""

from __future__ import annotations

from typing import Any, Literal

AgentRuntime = Literal["pty", "headless"]
HeadlessProvider = Literal["claude", "opencode"]
MessageInjectionMode = Literal["wait", "steer"]

# BrokerEvent is a dict with a 'kind' field discriminator.
# Event kinds: agent_spawned, agent_released, agent_exit, agent_exited,
# relay_inbound, worker_stream, worker_ready, worker_error,
# delivery_queued, delivery_injected, delivery_verified, delivery_failed,
# delivery_active, delivery_ack, delivery_retry, delivery_dropped,
# relaycast_published, relaycast_publish_failed, acl_denied,
# agent_idle, agent_restarting, agent_restarted, agent_permanently_dead
BrokerEvent = dict[str, Any]
