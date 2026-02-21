"""
AUTO-GENERATED FILE - DO NOT EDIT
Generated from packages/shared/cli-registry.yaml
Run: npm run codegen:models
"""

from typing import Final, TypedDict, List


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
    SONNET: Final[str] = "sonnet"  # Sonnet (default)
    OPUS: Final[str] = "opus"  # Opus
    HAIKU: Final[str] = "haiku"  # Haiku


class CodexModels:
    """Codex CLI model identifiers."""
    GPT_5_2_CODEX: Final[str] = "gpt-5.2-codex"  # GPT-5.2 Codex — Frontier agentic coding model (default)
    GPT_5_3_CODEX: Final[str] = "gpt-5.3-codex"  # GPT-5.3 Codex — Latest frontier agentic coding model
    GPT_5_1_CODEX_MAX: Final[str] = "gpt-5.1-codex-max"  # GPT-5.1 Codex Max — Deep and fast reasoning
    GPT_5_2: Final[str] = "gpt-5.2"  # GPT-5.2 — Frontier model, knowledge & reasoning
    GPT_5_1_CODEX_MINI: Final[str] = "gpt-5.1-codex-mini"  # GPT-5.1 Codex Mini — Cheaper, faster


class GeminiModels:
    """Gemini CLI model identifiers."""
    GEMINI_3_PRO_PREVIEW: Final[str] = "gemini-3-pro-preview"  # Gemini 3 Pro Preview
    GEMINI_2_5_PRO: Final[str] = "gemini-2.5-pro"  # Gemini 2.5 Pro (default)
    GEMINI_2_5_FLASH: Final[str] = "gemini-2.5-flash"  # Gemini 2.5 Flash
    GEMINI_2_5_FLASH_LITE: Final[str] = "gemini-2.5-flash-lite"  # Gemini 2.5 Flash Lite


class CursorModels:
    """Cursor model identifiers."""
    OPUS_4_5_THINKING: Final[str] = "opus-4.5-thinking"  # Claude 4.5 Opus (Thinking) (default)
    OPUS_4_5: Final[str] = "opus-4.5"  # Claude 4.5 Opus
    SONNET_4_5: Final[str] = "sonnet-4.5"  # Claude 4.5 Sonnet
    SONNET_4_5_THINKING: Final[str] = "sonnet-4.5-thinking"  # Claude 4.5 Sonnet (Thinking)
    GPT_5_2_CODEX: Final[str] = "gpt-5.2-codex"  # GPT-5.2 Codex
    GPT_5_2_CODEX_HIGH: Final[str] = "gpt-5.2-codex-high"  # GPT-5.2 Codex High
    GPT_5_2_CODEX_LOW: Final[str] = "gpt-5.2-codex-low"  # GPT-5.2 Codex Low
    GPT_5_2_CODEX_XHIGH: Final[str] = "gpt-5.2-codex-xhigh"  # GPT-5.2 Codex Extra High
    GPT_5_2_CODEX_FAST: Final[str] = "gpt-5.2-codex-fast"  # GPT-5.2 Codex Fast
    GPT_5_2_CODEX_HIGH_FAST: Final[str] = "gpt-5.2-codex-high-fast"  # GPT-5.2 Codex High Fast
    GPT_5_2_CODEX_LOW_FAST: Final[str] = "gpt-5.2-codex-low-fast"  # GPT-5.2 Codex Low Fast
    GPT_5_2_CODEX_XHIGH_FAST: Final[str] = "gpt-5.2-codex-xhigh-fast"  # GPT-5.2 Codex Extra High Fast
    GPT_5_1_CODEX_MAX: Final[str] = "gpt-5.1-codex-max"  # GPT-5.1 Codex Max
    GPT_5_1_CODEX_MAX_HIGH: Final[str] = "gpt-5.1-codex-max-high"  # GPT-5.1 Codex Max High
    GPT_5_2: Final[str] = "gpt-5.2"  # GPT-5.2
    GPT_5_2_HIGH: Final[str] = "gpt-5.2-high"  # GPT-5.2 High
    GPT_5_1_HIGH: Final[str] = "gpt-5.1-high"  # GPT-5.1 High
    GEMINI_3_PRO: Final[str] = "gemini-3-pro"  # Gemini 3 Pro
    GEMINI_3_FLASH: Final[str] = "gemini-3-flash"  # Gemini 3 Flash
    COMPOSER_1: Final[str] = "composer-1"  # Composer 1
    GROK: Final[str] = "grok"  # Grok


class ModelOption(TypedDict):
    """Model option for UI dropdowns."""
    value: str
    label: str


CLAUDE_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "sonnet", "label": "Sonnet"},
    {"value": "opus", "label": "Opus"},
    {"value": "haiku", "label": "Haiku"},
]

CODEX_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "gpt-5.2-codex", "label": "GPT-5.2 Codex — Frontier agentic coding model"},
    {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex — Latest frontier agentic coding model"},
    {"value": "gpt-5.1-codex-max", "label": "GPT-5.1 Codex Max — Deep and fast reasoning"},
    {"value": "gpt-5.2", "label": "GPT-5.2 — Frontier model, knowledge & reasoning"},
    {"value": "gpt-5.1-codex-mini", "label": "GPT-5.1 Codex Mini — Cheaper, faster"},
]

GEMINI_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "gemini-3-pro-preview", "label": "Gemini 3 Pro Preview"},
    {"value": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"value": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    {"value": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite"},
]

CURSOR_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "opus-4.5-thinking", "label": "Claude 4.5 Opus (Thinking)"},
    {"value": "opus-4.5", "label": "Claude 4.5 Opus"},
    {"value": "sonnet-4.5", "label": "Claude 4.5 Sonnet"},
    {"value": "sonnet-4.5-thinking", "label": "Claude 4.5 Sonnet (Thinking)"},
    {"value": "gpt-5.2-codex", "label": "GPT-5.2 Codex"},
    {"value": "gpt-5.2-codex-high", "label": "GPT-5.2 Codex High"},
    {"value": "gpt-5.2-codex-low", "label": "GPT-5.2 Codex Low"},
    {"value": "gpt-5.2-codex-xhigh", "label": "GPT-5.2 Codex Extra High"},
    {"value": "gpt-5.2-codex-fast", "label": "GPT-5.2 Codex Fast"},
    {"value": "gpt-5.2-codex-high-fast", "label": "GPT-5.2 Codex High Fast"},
    {"value": "gpt-5.2-codex-low-fast", "label": "GPT-5.2 Codex Low Fast"},
    {"value": "gpt-5.2-codex-xhigh-fast", "label": "GPT-5.2 Codex Extra High Fast"},
    {"value": "gpt-5.1-codex-max", "label": "GPT-5.1 Codex Max"},
    {"value": "gpt-5.1-codex-max-high", "label": "GPT-5.1 Codex Max High"},
    {"value": "gpt-5.2", "label": "GPT-5.2"},
    {"value": "gpt-5.2-high", "label": "GPT-5.2 High"},
    {"value": "gpt-5.1-high", "label": "GPT-5.1 High"},
    {"value": "gemini-3-pro", "label": "Gemini 3 Pro"},
    {"value": "gemini-3-flash", "label": "Gemini 3 Flash"},
    {"value": "composer-1", "label": "Composer 1"},
    {"value": "grok", "label": "Grok"},
]

class Models:
    """All models grouped by CLI tool."""
    Claude = ClaudeModels
    Codex = CodexModels
    Gemini = GeminiModels
    Cursor = CursorModels


class ModelOptions:
    """All model options grouped by CLI tool (for UI dropdowns)."""
    Claude = CLAUDE_MODEL_OPTIONS
    Codex = CODEX_MODEL_OPTIONS
    Gemini = GEMINI_MODEL_OPTIONS
    Cursor = CURSOR_MODEL_OPTIONS


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


DEFAULT_MODELS: Final[dict] = {
    "claude": "sonnet",
    "codex": "gpt-5.2-codex",
    "gemini": "gemini-2.5-pro",
    "cursor": "opus-4.5-thinking",
}

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
        "package": "@google/gemini-cli",
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
