/**
 * Model and CLI Constants
 *
 * Re-exports from @agent-relay/config package.
 * Source of truth: packages/shared/cli-registry.yaml
 * Run `npm run codegen:models` after editing the YAML.
 */

export {
  // CLI tools and versions
  CLIs,
  CLIVersions,
  CLIRegistry,
  // Model constants
  ClaudeModels,
  CodexModels,
  GeminiModels,
  CursorModels,
  Models,
  DefaultModels,
  // Model options for UI dropdowns
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  GEMINI_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  ModelOptions,
  // Swarm patterns (type is in workflows/types.ts)
  SwarmPatterns,
  // Types
  type CLI,
  type ClaudeModel,
  type CodexModel,
  type GeminiModel,
  type CursorModel,
  type ModelOption,
} from '@agent-relay/config';
