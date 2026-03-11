"""
AUTO-GENERATED FILE - DO NOT EDIT
Generated from packages/shared/cli-registry.yaml
Run: npm run codegen:models
"""

from typing import Final, TypedDict, List


class CLIVersions:
    """CLI tool versions. Update packages/shared/cli-registry.yaml to change versions."""
    CLAUDE: Final[str] = "2.1.72"  # Claude Code
    CODEX: Final[str] = "0.114.0"  # Codex CLI
    GEMINI: Final[str] = "0.33.0"  # Gemini CLI
    CURSOR: Final[str] = "2026.02.27-e7d2ef6"  # Cursor
    DROID: Final[str] = "0.1.0"  # Droid
    OPENCODE: Final[str] = "1.2.24"  # OpenCode
    AIDER: Final[str] = "0.72.1"  # Aider
    GOOSE: Final[str] = "1.0.16"  # Goose


class CLIs:
    """Supported CLI tools."""
    CLAUDE: Final[str] = "claude"
    CODEX: Final[str] = "codex"
    GEMINI: Final[str] = "gemini"
    CURSOR: Final[str] = "cursor"
    DROID: Final[str] = "droid"
    OPENCODE: Final[str] = "opencode"
    AIDER: Final[str] = "aider"
    GOOSE: Final[str] = "goose"


class ClaudeModels:
    """Claude Code model identifiers."""
    SONNET: Final[str] = "sonnet"  # Sonnet (default)
    OPUS: Final[str] = "opus"  # Opus
    HAIKU: Final[str] = "haiku"  # Haiku


class CodexModels:
    """Codex CLI model identifiers."""
    GPT_5_4: Final[str] = "gpt-5.4"  # GPT-5.4 — Latest frontier agentic coding model (default)
    GPT_5_3_CODEX: Final[str] = "gpt-5.3-codex"  # GPT-5.3 Codex — Frontier agentic coding model
    GPT_5_3_CODEX_SPARK: Final[str] = "gpt-5.3-codex-spark"  # GPT-5.3 Codex Spark — Ultra-fast coding model
    GPT_5_2_CODEX: Final[str] = "gpt-5.2-codex"  # GPT-5.2 Codex — Frontier agentic coding model
    GPT_5_2: Final[str] = "gpt-5.2"  # GPT-5.2 — Frontier model, knowledge & reasoning
    GPT_5_1_CODEX_MAX: Final[str] = "gpt-5.1-codex-max"  # GPT-5.1 Codex Max — Deep and fast reasoning
    GPT_5_1_CODEX_MINI: Final[str] = "gpt-5.1-codex-mini"  # GPT-5.1 Codex Mini — Cheaper, faster


class GeminiModels:
    """Gemini CLI model identifiers."""
    GEMINI_3_1_PRO_PREVIEW: Final[str] = "gemini-3.1-pro-preview"  # Gemini 3.1 Pro Preview (default)
    GEMINI_3_FLASH_PREVIEW: Final[str] = "gemini-3-flash-preview"  # Gemini 3 Flash Preview
    GEMINI_2_5_PRO: Final[str] = "gemini-2.5-pro"  # Gemini 2.5 Pro
    GEMINI_2_5_FLASH: Final[str] = "gemini-2.5-flash"  # Gemini 2.5 Flash
    GEMINI_2_5_FLASH_LITE: Final[str] = "gemini-2.5-flash-lite"  # Gemini 2.5 Flash Lite


class CursorModels:
    """Cursor model identifiers."""
    OPUS_4_6_THINKING: Final[str] = "opus-4.6-thinking"  # Claude 4.6 Opus (Thinking) (default)
    OPUS_4_6: Final[str] = "opus-4.6"  # Claude 4.6 Opus
    OPUS_4_5: Final[str] = "opus-4.5"  # Claude 4.5 Opus
    OPUS_4_5_THINKING: Final[str] = "opus-4.5-thinking"  # Claude 4.5 Opus (Thinking)
    SONNET_4_6: Final[str] = "sonnet-4.6"  # Claude 4.6 Sonnet
    SONNET_4_6_THINKING: Final[str] = "sonnet-4.6-thinking"  # Claude 4.6 Sonnet (Thinking)
    SONNET_4_5: Final[str] = "sonnet-4.5"  # Claude 4.5 Sonnet
    SONNET_4_5_THINKING: Final[str] = "sonnet-4.5-thinking"  # Claude 4.5 Sonnet (Thinking)
    COMPOSER_1_5: Final[str] = "composer-1.5"  # Composer 1.5
    COMPOSER_1: Final[str] = "composer-1"  # Composer 1
    GPT_5_4_XHIGH: Final[str] = "gpt-5.4-xhigh"  # GPT-5.4 Extra High
    GPT_5_4_XHIGH_FAST: Final[str] = "gpt-5.4-xhigh-fast"  # GPT-5.4 Extra High Fast
    GPT_5_4_HIGH: Final[str] = "gpt-5.4-high"  # GPT-5.4 High
    GPT_5_4_HIGH_FAST: Final[str] = "gpt-5.4-high-fast"  # GPT-5.4 High Fast
    GPT_5_4_MEDIUM: Final[str] = "gpt-5.4-medium"  # GPT-5.4
    GPT_5_4_MEDIUM_FAST: Final[str] = "gpt-5.4-medium-fast"  # GPT-5.4 Fast
    GPT_5_4_LOW: Final[str] = "gpt-5.4-low"  # GPT-5.4 Low
    GPT_5_3_CODEX_XHIGH: Final[str] = "gpt-5.3-codex-xhigh"  # GPT-5.3 Codex Extra High
    GPT_5_3_CODEX_XHIGH_FAST: Final[str] = "gpt-5.3-codex-xhigh-fast"  # GPT-5.3 Codex Extra High Fast
    GPT_5_3_CODEX_HIGH: Final[str] = "gpt-5.3-codex-high"  # GPT-5.3 Codex High
    GPT_5_3_CODEX_HIGH_FAST: Final[str] = "gpt-5.3-codex-high-fast"  # GPT-5.3 Codex High Fast
    GPT_5_3_CODEX: Final[str] = "gpt-5.3-codex"  # GPT-5.3 Codex
    GPT_5_3_CODEX_FAST: Final[str] = "gpt-5.3-codex-fast"  # GPT-5.3 Codex Fast
    GPT_5_3_CODEX_LOW: Final[str] = "gpt-5.3-codex-low"  # GPT-5.3 Codex Low
    GPT_5_3_CODEX_LOW_FAST: Final[str] = "gpt-5.3-codex-low-fast"  # GPT-5.3 Codex Low Fast
    GPT_5_3_CODEX_SPARK_PREVIEW: Final[str] = "gpt-5.3-codex-spark-preview"  # GPT-5.3 Codex Spark
    GPT_5_2_CODEX_XHIGH: Final[str] = "gpt-5.2-codex-xhigh"  # GPT-5.2 Codex Extra High
    GPT_5_2_CODEX_XHIGH_FAST: Final[str] = "gpt-5.2-codex-xhigh-fast"  # GPT-5.2 Codex Extra High Fast
    GPT_5_2_CODEX_HIGH: Final[str] = "gpt-5.2-codex-high"  # GPT-5.2 Codex High
    GPT_5_2_CODEX_HIGH_FAST: Final[str] = "gpt-5.2-codex-high-fast"  # GPT-5.2 Codex High Fast
    GPT_5_2_CODEX: Final[str] = "gpt-5.2-codex"  # GPT-5.2 Codex
    GPT_5_2_CODEX_FAST: Final[str] = "gpt-5.2-codex-fast"  # GPT-5.2 Codex Fast
    GPT_5_2_CODEX_LOW: Final[str] = "gpt-5.2-codex-low"  # GPT-5.2 Codex Low
    GPT_5_2_CODEX_LOW_FAST: Final[str] = "gpt-5.2-codex-low-fast"  # GPT-5.2 Codex Low Fast
    GPT_5_2: Final[str] = "gpt-5.2"  # GPT-5.2
    GPT_5_2_HIGH: Final[str] = "gpt-5.2-high"  # GPT-5.2 High
    GPT_5_1_CODEX_MAX: Final[str] = "gpt-5.1-codex-max"  # GPT-5.1 Codex Max
    GPT_5_1_CODEX_MAX_HIGH: Final[str] = "gpt-5.1-codex-max-high"  # GPT-5.1 Codex Max High
    GPT_5_1_CODEX_MINI: Final[str] = "gpt-5.1-codex-mini"  # GPT-5.1 Codex Mini
    GPT_5_1_HIGH: Final[str] = "gpt-5.1-high"  # GPT-5.1 High
    GEMINI_3_1_PRO: Final[str] = "gemini-3.1-pro"  # Gemini 3.1 Pro
    GEMINI_3_PRO: Final[str] = "gemini-3-pro"  # Gemini 3 Pro
    GEMINI_3_FLASH: Final[str] = "gemini-3-flash"  # Gemini 3 Flash
    GROK: Final[str] = "grok"  # Grok
    KIMI_K2_5: Final[str] = "kimi-k2.5"  # Kimi K2.5


class DroidModels:
    """Droid model identifiers."""
    OPUS_4_6_FAST: Final[str] = "opus-4.6-fast"  # Opus 4.6 Fast Mode (12x) (default)
    OPUS_4_5: Final[str] = "opus-4.5"  # Opus 4.5 (2x)
    SONNET_4_5: Final[str] = "sonnet-4.5"  # Sonnet 4.5 (1.2x)
    HAIKU_4_5: Final[str] = "haiku-4.5"  # Haiku 4.5 (0.4x)
    GPT_5_2: Final[str] = "gpt-5.2"  # GPT-5.2 (0.7x)
    GPT_5_2_CODEX: Final[str] = "gpt-5.2-codex"  # GPT-5.2 Codex (0.7x)
    GEMINI_3_FLASH: Final[str] = "gemini-3-flash"  # Gemini 3 Flash (0.2x)
    DROID_CORE: Final[str] = "droid-core-glm-4.7"  # Droid Core (GLM-4.7) (0.25x)


class OpencodeModels:
    """OpenCode model identifiers."""
    OPENCODE_BIG_PICKLE: Final[str] = "opencode/big-pickle"  # Big Pickle
    OPENCODE_GPT_5_NANO: Final[str] = "opencode/gpt-5-nano"  # GPT-5 Nano (OpenCode)
    OPENCODE_MIMO_V2_FLASH_FREE: Final[str] = "opencode/mimo-v2-flash-free"  # Mimo V2 Flash Free
    OPENCODE_MINIMAX_M2_5_FREE: Final[str] = "opencode/minimax-m2.5-free"  # MiniMax M2.5 Free
    OPENAI_CODEX_MINI_LATEST: Final[str] = "openai/codex-mini-latest"  # Codex Mini Latest
    OPENAI_GPT_3_5_TURBO: Final[str] = "openai/gpt-3.5-turbo"  # GPT-3.5 Turbo
    OPENAI_GPT_4: Final[str] = "openai/gpt-4"  # GPT-4
    OPENAI_GPT_4_TURBO: Final[str] = "openai/gpt-4-turbo"  # GPT-4 Turbo
    OPENAI_GPT_4_1: Final[str] = "openai/gpt-4.1"  # GPT-4.1
    OPENAI_GPT_4_1_MINI: Final[str] = "openai/gpt-4.1-mini"  # GPT-4.1 Mini
    OPENAI_GPT_4_1_NANO: Final[str] = "openai/gpt-4.1-nano"  # GPT-4.1 Nano
    OPENAI_GPT_4O: Final[str] = "openai/gpt-4o"  # GPT-4o
    OPENAI_GPT_4O_2024_05_13: Final[str] = "openai/gpt-4o-2024-05-13"  # GPT-4o (2024-05-13)
    OPENAI_GPT_4O_2024_08_06: Final[str] = "openai/gpt-4o-2024-08-06"  # GPT-4o (2024-08-06)
    OPENAI_GPT_4O_2024_11_20: Final[str] = "openai/gpt-4o-2024-11-20"  # GPT-4o (2024-11-20)
    OPENAI_GPT_4O_MINI: Final[str] = "openai/gpt-4o-mini"  # GPT-4o Mini
    OPENAI_GPT_5: Final[str] = "openai/gpt-5"  # GPT-5
    OPENAI_GPT_5_CODEX: Final[str] = "openai/gpt-5-codex"  # GPT-5 Codex
    OPENAI_GPT_5_MINI: Final[str] = "openai/gpt-5-mini"  # GPT-5 Mini
    OPENAI_GPT_5_NANO: Final[str] = "openai/gpt-5-nano"  # GPT-5 Nano
    OPENAI_GPT_5_PRO: Final[str] = "openai/gpt-5-pro"  # GPT-5 Pro
    OPENAI_GPT_5_1: Final[str] = "openai/gpt-5.1"  # GPT-5.1
    OPENAI_GPT_5_1_CHAT_LATEST: Final[str] = "openai/gpt-5.1-chat-latest"  # GPT-5.1 Chat Latest
    OPENAI_GPT_5_1_CODEX: Final[str] = "openai/gpt-5.1-codex"  # GPT-5.1 Codex
    OPENAI_GPT_5_1_CODEX_MAX: Final[str] = "openai/gpt-5.1-codex-max"  # GPT-5.1 Codex Max
    OPENAI_GPT_5_1_CODEX_MINI: Final[str] = "openai/gpt-5.1-codex-mini"  # GPT-5.1 Codex Mini
    OPENAI_GPT_5_2: Final[str] = "openai/gpt-5.2"  # GPT-5.2 (default)
    OPENAI_GPT_5_2_CHAT_LATEST: Final[str] = "openai/gpt-5.2-chat-latest"  # GPT-5.2 Chat Latest
    OPENAI_GPT_5_2_CODEX: Final[str] = "openai/gpt-5.2-codex"  # GPT-5.2 Codex
    OPENAI_GPT_5_2_PRO: Final[str] = "openai/gpt-5.2-pro"  # GPT-5.2 Pro
    OPENAI_GPT_5_3_CODEX: Final[str] = "openai/gpt-5.3-codex"  # GPT-5.3 Codex
    OPENAI_GPT_5_3_CODEX_SPARK: Final[str] = "openai/gpt-5.3-codex-spark"  # GPT-5.3 Codex Spark
    OPENAI_GPT_5_4: Final[str] = "openai/gpt-5.4"  # GPT-5.4
    OPENAI_GPT_5_4_PRO: Final[str] = "openai/gpt-5.4-pro"  # GPT-5.4 Pro
    OPENAI_O1: Final[str] = "openai/o1"  # O1
    OPENAI_O1_MINI: Final[str] = "openai/o1-mini"  # O1 Mini
    OPENAI_O1_PREVIEW: Final[str] = "openai/o1-preview"  # O1 Preview
    OPENAI_O1_PRO: Final[str] = "openai/o1-pro"  # O1 Pro
    OPENAI_O3: Final[str] = "openai/o3"  # O3
    OPENAI_O3_DEEP_RESEARCH: Final[str] = "openai/o3-deep-research"  # O3 Deep Research
    OPENAI_O3_MINI: Final[str] = "openai/o3-mini"  # O3 Mini
    OPENAI_O3_PRO: Final[str] = "openai/o3-pro"  # O3 Pro
    OPENAI_O4_MINI: Final[str] = "openai/o4-mini"  # O4 Mini
    OPENAI_O4_MINI_DEEP_RESEARCH: Final[str] = "openai/o4-mini-deep-research"  # O4 Mini Deep Research


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
    {"value": "gpt-5.4", "label": "GPT-5.4 — Latest frontier agentic coding model"},
    {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex — Frontier agentic coding model"},
    {"value": "gpt-5.3-codex-spark", "label": "GPT-5.3 Codex Spark — Ultra-fast coding model"},
    {"value": "gpt-5.2-codex", "label": "GPT-5.2 Codex — Frontier agentic coding model"},
    {"value": "gpt-5.2", "label": "GPT-5.2 — Frontier model, knowledge & reasoning"},
    {"value": "gpt-5.1-codex-max", "label": "GPT-5.1 Codex Max — Deep and fast reasoning"},
    {"value": "gpt-5.1-codex-mini", "label": "GPT-5.1 Codex Mini — Cheaper, faster"},
]

GEMINI_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro Preview"},
    {"value": "gemini-3-flash-preview", "label": "Gemini 3 Flash Preview"},
    {"value": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"value": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    {"value": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite"},
]

CURSOR_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "opus-4.6-thinking", "label": "Claude 4.6 Opus (Thinking)"},
    {"value": "opus-4.6", "label": "Claude 4.6 Opus"},
    {"value": "opus-4.5", "label": "Claude 4.5 Opus"},
    {"value": "opus-4.5-thinking", "label": "Claude 4.5 Opus (Thinking)"},
    {"value": "sonnet-4.6", "label": "Claude 4.6 Sonnet"},
    {"value": "sonnet-4.6-thinking", "label": "Claude 4.6 Sonnet (Thinking)"},
    {"value": "sonnet-4.5", "label": "Claude 4.5 Sonnet"},
    {"value": "sonnet-4.5-thinking", "label": "Claude 4.5 Sonnet (Thinking)"},
    {"value": "composer-1.5", "label": "Composer 1.5"},
    {"value": "composer-1", "label": "Composer 1"},
    {"value": "gpt-5.4-xhigh", "label": "GPT-5.4 Extra High"},
    {"value": "gpt-5.4-xhigh-fast", "label": "GPT-5.4 Extra High Fast"},
    {"value": "gpt-5.4-high", "label": "GPT-5.4 High"},
    {"value": "gpt-5.4-high-fast", "label": "GPT-5.4 High Fast"},
    {"value": "gpt-5.4-medium", "label": "GPT-5.4"},
    {"value": "gpt-5.4-medium-fast", "label": "GPT-5.4 Fast"},
    {"value": "gpt-5.4-low", "label": "GPT-5.4 Low"},
    {"value": "gpt-5.3-codex-xhigh", "label": "GPT-5.3 Codex Extra High"},
    {"value": "gpt-5.3-codex-xhigh-fast", "label": "GPT-5.3 Codex Extra High Fast"},
    {"value": "gpt-5.3-codex-high", "label": "GPT-5.3 Codex High"},
    {"value": "gpt-5.3-codex-high-fast", "label": "GPT-5.3 Codex High Fast"},
    {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex"},
    {"value": "gpt-5.3-codex-fast", "label": "GPT-5.3 Codex Fast"},
    {"value": "gpt-5.3-codex-low", "label": "GPT-5.3 Codex Low"},
    {"value": "gpt-5.3-codex-low-fast", "label": "GPT-5.3 Codex Low Fast"},
    {"value": "gpt-5.3-codex-spark-preview", "label": "GPT-5.3 Codex Spark"},
    {"value": "gpt-5.2-codex-xhigh", "label": "GPT-5.2 Codex Extra High"},
    {"value": "gpt-5.2-codex-xhigh-fast", "label": "GPT-5.2 Codex Extra High Fast"},
    {"value": "gpt-5.2-codex-high", "label": "GPT-5.2 Codex High"},
    {"value": "gpt-5.2-codex-high-fast", "label": "GPT-5.2 Codex High Fast"},
    {"value": "gpt-5.2-codex", "label": "GPT-5.2 Codex"},
    {"value": "gpt-5.2-codex-fast", "label": "GPT-5.2 Codex Fast"},
    {"value": "gpt-5.2-codex-low", "label": "GPT-5.2 Codex Low"},
    {"value": "gpt-5.2-codex-low-fast", "label": "GPT-5.2 Codex Low Fast"},
    {"value": "gpt-5.2", "label": "GPT-5.2"},
    {"value": "gpt-5.2-high", "label": "GPT-5.2 High"},
    {"value": "gpt-5.1-codex-max", "label": "GPT-5.1 Codex Max"},
    {"value": "gpt-5.1-codex-max-high", "label": "GPT-5.1 Codex Max High"},
    {"value": "gpt-5.1-codex-mini", "label": "GPT-5.1 Codex Mini"},
    {"value": "gpt-5.1-high", "label": "GPT-5.1 High"},
    {"value": "gemini-3.1-pro", "label": "Gemini 3.1 Pro"},
    {"value": "gemini-3-pro", "label": "Gemini 3 Pro"},
    {"value": "gemini-3-flash", "label": "Gemini 3 Flash"},
    {"value": "grok", "label": "Grok"},
    {"value": "kimi-k2.5", "label": "Kimi K2.5"},
]

DROID_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "opus-4.6-fast", "label": "Opus 4.6 Fast Mode (12x)"},
    {"value": "opus-4.5", "label": "Opus 4.5 (2x)"},
    {"value": "sonnet-4.5", "label": "Sonnet 4.5 (1.2x)"},
    {"value": "haiku-4.5", "label": "Haiku 4.5 (0.4x)"},
    {"value": "gpt-5.2", "label": "GPT-5.2 (0.7x)"},
    {"value": "gpt-5.2-codex", "label": "GPT-5.2 Codex (0.7x)"},
    {"value": "gemini-3-flash", "label": "Gemini 3 Flash (0.2x)"},
    {"value": "droid-core-glm-4.7", "label": "Droid Core (GLM-4.7) (0.25x)"},
]

OPENCODE_MODEL_OPTIONS: Final[List[ModelOption]] = [
    {"value": "opencode/big-pickle", "label": "Big Pickle"},
    {"value": "opencode/gpt-5-nano", "label": "GPT-5 Nano (OpenCode)"},
    {"value": "opencode/mimo-v2-flash-free", "label": "Mimo V2 Flash Free"},
    {"value": "opencode/minimax-m2.5-free", "label": "MiniMax M2.5 Free"},
    {"value": "openai/codex-mini-latest", "label": "Codex Mini Latest"},
    {"value": "openai/gpt-3.5-turbo", "label": "GPT-3.5 Turbo"},
    {"value": "openai/gpt-4", "label": "GPT-4"},
    {"value": "openai/gpt-4-turbo", "label": "GPT-4 Turbo"},
    {"value": "openai/gpt-4.1", "label": "GPT-4.1"},
    {"value": "openai/gpt-4.1-mini", "label": "GPT-4.1 Mini"},
    {"value": "openai/gpt-4.1-nano", "label": "GPT-4.1 Nano"},
    {"value": "openai/gpt-4o", "label": "GPT-4o"},
    {"value": "openai/gpt-4o-2024-05-13", "label": "GPT-4o (2024-05-13)"},
    {"value": "openai/gpt-4o-2024-08-06", "label": "GPT-4o (2024-08-06)"},
    {"value": "openai/gpt-4o-2024-11-20", "label": "GPT-4o (2024-11-20)"},
    {"value": "openai/gpt-4o-mini", "label": "GPT-4o Mini"},
    {"value": "openai/gpt-5", "label": "GPT-5"},
    {"value": "openai/gpt-5-codex", "label": "GPT-5 Codex"},
    {"value": "openai/gpt-5-mini", "label": "GPT-5 Mini"},
    {"value": "openai/gpt-5-nano", "label": "GPT-5 Nano"},
    {"value": "openai/gpt-5-pro", "label": "GPT-5 Pro"},
    {"value": "openai/gpt-5.1", "label": "GPT-5.1"},
    {"value": "openai/gpt-5.1-chat-latest", "label": "GPT-5.1 Chat Latest"},
    {"value": "openai/gpt-5.1-codex", "label": "GPT-5.1 Codex"},
    {"value": "openai/gpt-5.1-codex-max", "label": "GPT-5.1 Codex Max"},
    {"value": "openai/gpt-5.1-codex-mini", "label": "GPT-5.1 Codex Mini"},
    {"value": "openai/gpt-5.2", "label": "GPT-5.2"},
    {"value": "openai/gpt-5.2-chat-latest", "label": "GPT-5.2 Chat Latest"},
    {"value": "openai/gpt-5.2-codex", "label": "GPT-5.2 Codex"},
    {"value": "openai/gpt-5.2-pro", "label": "GPT-5.2 Pro"},
    {"value": "openai/gpt-5.3-codex", "label": "GPT-5.3 Codex"},
    {"value": "openai/gpt-5.3-codex-spark", "label": "GPT-5.3 Codex Spark"},
    {"value": "openai/gpt-5.4", "label": "GPT-5.4"},
    {"value": "openai/gpt-5.4-pro", "label": "GPT-5.4 Pro"},
    {"value": "openai/o1", "label": "O1"},
    {"value": "openai/o1-mini", "label": "O1 Mini"},
    {"value": "openai/o1-preview", "label": "O1 Preview"},
    {"value": "openai/o1-pro", "label": "O1 Pro"},
    {"value": "openai/o3", "label": "O3"},
    {"value": "openai/o3-deep-research", "label": "O3 Deep Research"},
    {"value": "openai/o3-mini", "label": "O3 Mini"},
    {"value": "openai/o3-pro", "label": "O3 Pro"},
    {"value": "openai/o4-mini", "label": "O4 Mini"},
    {"value": "openai/o4-mini-deep-research", "label": "O4 Mini Deep Research"},
]

class Models:
    """All models grouped by CLI tool."""
    Claude = ClaudeModels
    Codex = CodexModels
    Gemini = GeminiModels
    Cursor = CursorModels
    Droid = DroidModels
    Opencode = OpencodeModels


class ModelOptions:
    """All model options grouped by CLI tool (for UI dropdowns)."""
    Claude = CLAUDE_MODEL_OPTIONS
    Codex = CODEX_MODEL_OPTIONS
    Gemini = GEMINI_MODEL_OPTIONS
    Cursor = CURSOR_MODEL_OPTIONS
    Droid = DROID_MODEL_OPTIONS
    Opencode = OPENCODE_MODEL_OPTIONS


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
    "codex": "gpt-5.4",
    "gemini": "gemini-3.1-pro-preview",
    "cursor": "opus-4.6-thinking",
    "droid": "opus-4.6-fast",
    "opencode": "openai/gpt-5.2",
}

CLI_REGISTRY: Final[dict] = {
    "claude": {
        "name": "Claude Code",
        "package": "@anthropic-ai/claude-code",
        "version": "2.1.72",
        "install": "npm install -g @anthropic-ai/claude-code",
    },
    "codex": {
        "name": "Codex CLI",
        "package": "@openai/codex",
        "version": "0.114.0",
        "install": "npm install -g @openai/codex",
    },
    "gemini": {
        "name": "Gemini CLI",
        "package": "@google/gemini-cli",
        "version": "0.33.0",
        "install": "npm install -g @google/gemini-cli",
    },
    "cursor": {
        "name": "Cursor",
        "package": "cursor",
        "version": "2026.02.27-e7d2ef6",
        "install": "Download from cursor.com",
    },
    "droid": {
        "name": "Droid",
        "package": "droid",
        "version": "0.1.0",
        "install": "Download from droid.dev",
    },
    "opencode": {
        "name": "OpenCode",
        "package": "opencode-ai",
        "version": "1.2.24",
        "install": "npm install -g opencode-ai",
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
