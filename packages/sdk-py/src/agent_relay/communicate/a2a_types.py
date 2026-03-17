"""A2A (Agent-to-Agent) protocol data model types."""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class A2APart:
    """A single part of an A2A message (text, file, or structured data)."""

    text: str | None = None
    file: dict[str, Any] | None = None  # FileContent — phase 2
    data: dict[str, Any] | None = None  # Structured data — phase 2

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {}
        if self.text is not None:
            d["text"] = self.text
        if self.file is not None:
            d["file"] = self.file
        if self.data is not None:
            d["data"] = self.data
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> A2APart:
        return cls(
            text=d.get("text"),
            file=d.get("file"),
            data=d.get("data"),
        )


@dataclass
class A2AMessage:
    """An A2A protocol message."""

    role: str  # "user" | "agent"
    parts: list[A2APart]
    messageId: str | None = None
    contextId: str | None = None
    taskId: str | None = None

    def __post_init__(self) -> None:
        if self.messageId is None:
            self.messageId = str(uuid.uuid4())

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "role": self.role,
            "parts": [p.to_dict() for p in self.parts],
        }
        if self.messageId is not None:
            d["messageId"] = self.messageId
        if self.contextId is not None:
            d["contextId"] = self.contextId
        if self.taskId is not None:
            d["taskId"] = self.taskId
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> A2AMessage:
        parts = [A2APart.from_dict(p) for p in d.get("parts", [])]
        return cls(
            role=d["role"],
            parts=parts,
            messageId=d.get("messageId"),
            contextId=d.get("contextId"),
            taskId=d.get("taskId"),
        )

    def get_text(self) -> str:
        """Extract concatenated text from all text parts."""
        return " ".join(p.text for p in self.parts if p.text)


@dataclass
class A2ATaskStatus:
    """Status of an A2A task."""

    state: str  # "submitted" | "working" | "completed" | "failed" | "canceled"
    message: A2AMessage | None = None
    timestamp: str | None = None

    def __post_init__(self) -> None:
        if self.timestamp is None:
            self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"state": self.state}
        if self.message is not None:
            d["message"] = self.message.to_dict()
        if self.timestamp is not None:
            d["timestamp"] = self.timestamp
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> A2ATaskStatus:
        msg = None
        if "message" in d and d["message"] is not None:
            msg = A2AMessage.from_dict(d["message"])
        return cls(
            state=d["state"],
            message=msg,
            timestamp=d.get("timestamp"),
        )


VALID_TASK_STATES = {"submitted", "working", "completed", "failed", "canceled"}


@dataclass
class A2ATask:
    """An A2A protocol task."""

    id: str
    contextId: str | None = None
    status: A2ATaskStatus = field(
        default_factory=lambda: A2ATaskStatus(state="submitted")
    )
    messages: list[A2AMessage] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "contextId": self.contextId,
            "status": self.status.to_dict(),
            "messages": [m.to_dict() for m in self.messages],
            "artifacts": self.artifacts,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> A2ATask:
        status = A2ATaskStatus.from_dict(d["status"]) if "status" in d else A2ATaskStatus(state="submitted")
        messages = [A2AMessage.from_dict(m) for m in d.get("messages", [])]
        return cls(
            id=d["id"],
            contextId=d.get("contextId"),
            status=status,
            messages=messages,
            artifacts=d.get("artifacts", []),
        )


@dataclass
class A2ASkill:
    """A skill advertised by an A2A agent."""

    id: str
    name: str
    description: str

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "description": self.description}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> A2ASkill:
        return cls(id=d["id"], name=d["name"], description=d["description"])


@dataclass
class A2AAgentCard:
    """An A2A Agent Card describing an agent's capabilities and endpoint."""

    name: str
    description: str
    url: str
    version: str = "1.0.0"
    capabilities: dict[str, Any] = field(
        default_factory=lambda: {"streaming": True, "pushNotifications": False}
    )
    skills: list[A2ASkill] = field(default_factory=list)
    defaultInputModes: list[str] = field(default_factory=lambda: ["text"])
    defaultOutputModes: list[str] = field(default_factory=lambda: ["text"])

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "url": self.url,
            "version": self.version,
            "capabilities": self.capabilities,
            "skills": [s.to_dict() for s in self.skills],
            "defaultInputModes": self.defaultInputModes,
            "defaultOutputModes": self.defaultOutputModes,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> A2AAgentCard:
        skills = [A2ASkill.from_dict(s) for s in d.get("skills", [])]
        return cls(
            name=d["name"],
            description=d["description"],
            url=d["url"],
            version=d.get("version", "1.0.0"),
            capabilities=d.get("capabilities", {"streaming": True, "pushNotifications": False}),
            skills=skills,
            defaultInputModes=d.get("defaultInputModes", ["text"]),
            defaultOutputModes=d.get("defaultOutputModes", ["text"]),
        )


@dataclass
class A2AConfig:
    """Configuration for A2A transport."""

    # Server mode
    server_port: int = 5000
    server_host: str = "0.0.0.0"

    # Client mode
    target_url: str | None = None

    # Agent Card registry (known A2A agent URLs)
    registry: list[str] = field(default_factory=list)

    # Auth
    auth_scheme: str | None = None  # "bearer", "api_key", etc.
    auth_token: str | None = None

    # Agent metadata
    agent_description: str | None = None
    skills: list[A2ASkill] = field(default_factory=list)


def make_jsonrpc_request(method: str, params: dict[str, Any], id: str | int | None = None) -> dict[str, Any]:
    """Build a JSON-RPC 2.0 request envelope."""
    req: dict[str, Any] = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    }
    if id is not None:
        req["id"] = id
    else:
        req["id"] = str(uuid.uuid4())
    return req


def make_jsonrpc_response(result: Any, id: str | int) -> dict[str, Any]:
    """Build a JSON-RPC 2.0 success response."""
    return {
        "jsonrpc": "2.0",
        "result": result,
        "id": id,
    }


def make_jsonrpc_error(code: int, message: str, id: str | int | None) -> dict[str, Any]:
    """Build a JSON-RPC 2.0 error response."""
    return {
        "jsonrpc": "2.0",
        "error": {"code": code, "message": message},
        "id": id,
    }


# Standard JSON-RPC error codes
JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
JSONRPC_INTERNAL_ERROR = -32603

# A2A-specific error codes
A2A_TASK_NOT_FOUND = -32001
A2A_TASK_NOT_CANCELABLE = -32002


__all__ = [
    "A2AAgentCard",
    "A2AConfig",
    "A2AMessage",
    "A2APart",
    "A2ASkill",
    "A2ATask",
    "A2ATaskStatus",
    "A2A_TASK_NOT_CANCELABLE",
    "A2A_TASK_NOT_FOUND",
    "JSONRPC_INTERNAL_ERROR",
    "JSONRPC_INVALID_PARAMS",
    "JSONRPC_INVALID_REQUEST",
    "JSONRPC_METHOD_NOT_FOUND",
    "JSONRPC_PARSE_ERROR",
    "VALID_TASK_STATES",
    "make_jsonrpc_error",
    "make_jsonrpc_request",
    "make_jsonrpc_response",
]
