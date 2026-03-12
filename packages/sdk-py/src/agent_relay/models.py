"""Model constants for supported CLI tools.

Matches packages/config/src/cli-registry.generated.ts.
"""


class Models:
    """Model identifiers organized by CLI tool."""

    class Claude:
        SONNET = "sonnet"
        OPUS = "opus"
        HAIKU = "haiku"

    class Codex:
        GPT_5_2_CODEX = "gpt-5.2-codex"
        GPT_5_3_CODEX = "gpt-5.3-codex"
        GPT_5_3_CODEX_SPARK = "gpt-5.3-codex-spark"
        GPT_5_1_CODEX_MAX = "gpt-5.1-codex-max"
        GPT_5_2 = "gpt-5.2"
        GPT_5_1_CODEX_MINI = "gpt-5.1-codex-mini"

    class Gemini:
        GEMINI_3_PRO_PREVIEW = "gemini-3-pro-preview"
        GEMINI_2_5_PRO = "gemini-2.5-pro"
        GEMINI_2_5_FLASH = "gemini-2.5-flash"
        GEMINI_2_5_FLASH_LITE = "gemini-2.5-flash-lite"

    class Opencode:
        OPENCODE_BIG_PICKLE = "opencode/big-pickle"
        OPENCODE_GPT_5_NANO = "opencode/gpt-5-nano"
        OPENCODE_MIMO_V2_FLASH_FREE = "opencode/mimo-v2-flash-free"
        OPENCODE_MINIMAX_M2_5_FREE = "opencode/minimax-m2.5-free"
        OPENAI_CODEX_MINI_LATEST = "openai/codex-mini-latest"
        OPENAI_GPT_5_2 = "openai/gpt-5.2"
        OPENAI_O3_MINI = "openai/o3-mini"
        OPENAI_O3_PRO = "openai/o3-pro"
        OPENAI_O4_MINI = "openai/o4-mini"
