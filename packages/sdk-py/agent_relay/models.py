"""
AUTO-GENERATED FILE - DO NOT EDIT
Generated from packages/shared/cli-registry.yaml
Run: npm run codegen:models
"""

from typing import Final


class CLIVersions:
    """CLI tool versions. Update packages/shared/cli-registry.yaml to change versions."""
    CLAUDE: Final[str] = "1.0.24"  # Claude Code
    CODEX: Final[str] = "0.1.2504301707"  # Codex CLI
    GEMINI: Final[str] = "0.1.17"  # Gemini CLI
    CURSOR: Final[str] = "0.48.6"  # Cursor
    AIDER: Final[str] = "0.72.1"  # Aider
    GOOSE: Final[str] = "1.0.16"  # Goose


class CLIs:
    """Supported CLI tools."""
    CLAUDE: Final[str] = "claude"
    CODEX: Final[str] = "codex"
    GEMINI: Final[str] = "gemini"
    CURSOR: Final[str] = "cursor"
    AIDER: Final[str] = "aider"
    GOOSE: Final[str] = "goose"


class ClaudeModels:
    """Claude Code model identifiers."""
    OPUS: Final[str] = "opus"  # Claude Opus 4 - most capable, best for complex reasoning
    SONNET: Final[str] = "sonnet"  # Claude Sonnet 4 - balanced performance and speed (default)
    HAIKU: Final[str] = "haiku"  # Claude Haiku - fastest, best for simple tasks


class CodexModels:
    """Codex CLI model identifiers."""
    CODEX_5_3: Final[str] = "codex-5.3"  # Codex 5.3 - latest codex model (default)


class GeminiModels:
    """Gemini CLI model identifiers."""
    FLASH: Final[str] = "gemini-2.0-flash"  # Gemini 2.0 Flash - fast and capable (default)
    PRO: Final[str] = "gemini-2.0-pro"  # Gemini 2.0 Pro - most capable


class CursorModels:
    """Cursor model identifiers."""
    CLAUDE_SONNET: Final[str] = "claude-sonnet"  # Claude Sonnet via Cursor (default)
    GPT4O: Final[str] = "gpt-4o"  # GPT-4o via Cursor


class Models:
    """All models grouped by CLI tool."""
    Claude = ClaudeModels
    Codex = CodexModels
    Gemini = GeminiModels
    Cursor = CursorModels


class SwarmPatterns:
    """Swarm patterns for multi-agent workflows."""
    HUB_SPOKE: Final[str] = "hub-spoke"  # Central coordinator distributes tasks to workers
    DAG: Final[str] = "dag"  # Directed acyclic graph with dependencies
    FAN_OUT: Final[str] = "fan-out"  # Parallel execution across multiple agents
    PIPELINE: Final[str] = "pipeline"  # Sequential processing through stages
    CONSENSUS: Final[str] = "consensus"  # Agents reach agreement before proceeding
    MESH: Final[str] = "mesh"  # Fully connected peer-to-peer communication
    HANDOFF: Final[str] = "handoff"  # Sequential handoff between agents
    CASCADE: Final[str] = "cascade"  # Cascading delegation
    DEBATE: Final[str] = "debate"  # Agents debate to reach conclusion
    HIERARCHICAL: Final[str] = "hierarchical"  # Tree-structured coordination


CLI_REGISTRY: Final[dict] = {
    "claude": {
        "name": "Claude Code",
        "package": "@anthropic-ai/claude-code",
        "version": "1.0.24",
        "install": "npm install -g @anthropic-ai/claude-code",
    },
    "codex": {
        "name": "Codex CLI",
        "package": "@openai/codex",
        "version": "0.1.2504301707",
        "install": "npm install -g @openai/codex",
    },
    "gemini": {
        "name": "Gemini CLI",
        "package": "@anthropic-ai/gemini-cli",
        "version": "0.1.17",
        "install": "npm install -g @google/gemini-cli",
    },
    "cursor": {
        "name": "Cursor",
        "package": "cursor",
        "version": "0.48.6",
        "install": "Download from cursor.com",
    },
    "aider": {
        "name": "Aider",
        "package": "aider-chat",
        "version": "0.72.1",
        "install": "pip install aider-chat",
    },
    "goose": {
        "name": "Goose",
        "package": "goose-ai",
        "version": "1.0.16",
        "install": "pip install goose-ai",
    },
}
