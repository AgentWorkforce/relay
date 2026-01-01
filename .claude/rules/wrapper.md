---
paths:
  - "src/wrapper/**/*.ts"
---

# Wrapper Conventions

## Purpose

Wrappers integrate AI CLI tools (Claude, Codex, Gemini, etc.) with the relay system via tmux sessions.

## CLI Detection

- Auto-detect CLI type from command name
- Supported types: `'claude' | 'codex' | 'gemini' | 'droid' | 'other'`
- CLI type affects prompt patterns, escape sequences, and injection behavior

## tmux Integration

- Use resolved tmux path from `getTmuxPath()` for portability
- Session names: `relay-{agentName}`
- Always quote tmux path in commands: `"${this.tmuxPath}" send-keys ...`

## Relay Protocol

- Unified prefix: `->relay:` for all agent types
- Multi-line format: `->relay:Target <<<\ncontent\n>>>`
- Parse output using `OutputParser` from `./parser.js`

## Message Injection

- Wait for idle before injecting (default 1500ms)
- Wait for stable pane output before injection
- Check cursor position to avoid interrupting typing
- Use bracketed paste for Claude/Codex/Gemini, plain paste for others

## Output Parsing

- Strip ANSI escape sequences before parsing
- Join continuation lines for TUI output
- Use deduplication to prevent duplicate message sends
- Parse `[[SUMMARY]]` and `[[SESSION_END]]` blocks

## Error Handling

- Log to stderr only (stdout belongs to tmux)
- Use `logStderr()` method with optional force flag
- Graceful degradation if relay daemon unavailable

## Configuration Interface

```typescript
interface TmuxWrapperConfig {
  name: string;
  command: string;
  args?: string[];
  socketPath?: string;
  pollInterval?: number;      // Default: 200ms
  idleBeforeInjectMs?: number; // Default: 1500ms
  debug?: boolean;
  mouseMode?: boolean;        // Default: true
  streamLogs?: boolean;       // Default: true
}
```

## State Management

- Track `running` boolean for lifecycle
- Track `activityState`: `'active' | 'idle' | 'disconnected'`
- Use `isInjecting` flag to prevent concurrent injections
- Maintain message queue for pending injections
