"""Node provider enrollment sugar for agent-relay.

A thin relay-side wrapper over ``relay_sdk.node.NodeProvider`` (the relaycast SDK
node provider client) that reads the node credentials from the enrollment — the
``RELAY_NODE_TOKEN`` / ``RELAY_BASE_URL`` environment (which ``relay node up``
sets on a spawned ``agent-relay.py`` child) or, failing that, the
``fleet-enrollments.json`` store written by ``relay cloud enroll`` — so a
project's node script attaches to its node without hand-wiring the token, id,
name, and base URL.

Usage::

    from agent_relay.node import NodeProvider

    node = NodeProvider.from_enrollment()

    @node.capability("run-etl", description="Run the ETL job")
    async def run_etl(input, ctx): ...

    node.serve()
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

from relay_sdk.node import NodeProvider as _NodeProvider
from relay_sdk.node import NodeRegistrationError

__all__ = ["NodeProvider", "NodeRegistrationError", "NodeProviderEnrollmentError"]


class NodeProviderEnrollmentError(RuntimeError):
    """Raised when the node enrollment cannot be resolved."""


class NodeProvider(_NodeProvider):
    """A node provider constructed from the machine's enrollment.

    Adds :meth:`from_enrollment` to the relaycast SDK's ``NodeProvider``; the
    constructor is otherwise unchanged (explicit ``node_token``/``node_id`` etc).
    """

    @classmethod
    def from_enrollment(
        cls,
        *,
        provider_name: str | None = None,
        base_url: str | None = None,
        capabilities: Mapping[str, Any] | None = None,
        max_agents: int = 0,
        **kwargs: Any,
    ) -> "NodeProvider":
        """Build a node provider from the resolved enrollment.

        The node token, id, name, and engine base URL come from the environment
        first (``RELAY_NODE_TOKEN``, ``RELAY_NODE_ID``, ``RELAY_NODE_NAME``,
        ``RELAY_BASE_URL``), then the ``fleet-enrollments.json`` store.

        :param provider_name: This provider's identity name, distinct from the
            broker ("broker") on the same node. Defaults to ``<node>-python``.
        """
        # Resolve the target engine first so a multi-node store picks the record
        # for THIS engine rather than mixing another node's token with it.
        base_pref = base_url or os.environ.get("RELAY_BASE_URL")
        enrollment = _resolve_enrollment(base_pref)
        token = os.environ.get("RELAY_NODE_TOKEN") or enrollment.get("node_token")
        node_id = os.environ.get("RELAY_NODE_ID") or enrollment.get("node_id")
        node_name = (
            os.environ.get("RELAY_NODE_NAME") or enrollment.get("node_name") or node_id
        )
        resolved_base = base_pref or enrollment.get("base_url")

        if not token:
            raise NodeProviderEnrollmentError(
                "No node token found. Set RELAY_NODE_TOKEN or run `relay cloud enroll`."
            )
        if not node_id:
            raise NodeProviderEnrollmentError(
                "No node id found. Set RELAY_NODE_ID or serve this provider under `relay node up`."
            )

        # Drop any keys this method already supplies so a caller's stray
        # `**dict` can't trigger "multiple values for keyword argument".
        handled = {
            "base_url",
            "node_token",
            "node_id",
            "node_name",
            "provider",
            "capabilities",
            "max_agents",
        }
        extra = {key: value for key, value in kwargs.items() if key not in handled}
        return cls(
            **({"base_url": resolved_base} if resolved_base else {}),
            node_token=token,
            node_id=node_id,
            node_name=node_name,
            provider={"name": provider_name or f"{node_name}-python"},
            capabilities=capabilities,
            max_agents=max_agents,
            **extra,
        )


def _enrollment_store_path() -> Path:
    home = os.environ.get("AGENT_RELAY_HOME") or os.path.join(
        os.path.expanduser("~"), ".agentworkforce", "relay"
    )
    return Path(home) / "fleet-enrollments.json"


def _resolve_enrollment(base_url: str | None = None) -> dict[str, str]:
    """Best-effort read of the fleet-node enrollment store, returning one record's
    node_token/node_id/node_name/base_url. When ``base_url`` is given, the record
    whose engine matches it wins; otherwise the active (or sole) record is used. A
    missing or malformed store resolves to empty so the environment path applies.
    """
    try:
        data = json.loads(_enrollment_store_path().read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    nodes = data.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        return {}

    record: Any = None
    # Prefer a record for the requested engine, so credentials never cross engines.
    if base_url:
        wanted = base_url.rstrip("/")
        for value in nodes.values():
            if isinstance(value, dict) and str(value.get("relaycastUrl") or "").rstrip("/") == wanted:
                record = value
                break
    if record is None:
        active = data.get("active")
        if isinstance(active, dict):
            for key in active.values():
                if isinstance(key, str) and key in nodes:
                    record = nodes[key]
                    break
    if record is None and len(nodes) == 1:
        record = next(iter(nodes.values()))
    if not isinstance(record, dict):
        return {}

    return {
        "node_token": str(record.get("nodeToken") or ""),
        "node_id": str(record.get("nodeId") or ""),
        "node_name": str(record.get("nodeName") or ""),
        "base_url": str(record.get("relaycastUrl") or ""),
    }
