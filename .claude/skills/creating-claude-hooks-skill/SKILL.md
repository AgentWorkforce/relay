---
name: creating-claude-hooks
description: Use when creating or publishing Claude Code hooks - covers executable format, event types, JSON I/O, exit codes, security requirements, and PRPM package structure
skillType: skill
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# Creating Claude Code Hooks

Use this skill when creating, improving, or publishing Claude Code hooks. Provides essential guidance on hook format, event handling, I/O conventions, and package structure.

## When to Use This Skill

Activate this skill when:
- User asks to create a new Claude Code hook
- User wants to publish a hook as a PRPM package
- User needs to understand hook format or events
- User is troubleshooting hook execution
- User asks about hook vs skill vs command differences

## Quick Reference

### Hook File Format

| Aspect | Requirement |
|--------|-------------|
| **Location** | `.claude/hooks/<event-name>` |
| **Format** | Executable file (shell, TypeScript, Python, etc.) |
| **Permissions** | Must be executable (`chmod +x`) |
| **Shebang** | Required (`#!/bin/bash` or `#!/usr/bin/env node`) |
| **Input** | JSON via stdin |
| **Output** | Text via stdout (shown to user) |
| **Exit Codes** | `0` = success, `2` = block, other = error |

### Available Events

| Event | When It Fires | Common Use Cases |
|-------|---------------|------------------|
| `session-start` | New session begins | Environment setup, logging, checks |
| `user-prompt-submit` | Before user input processes | Validation, enhancement, filtering |
| `tool-call` | Before tool execution | Permission checks, logging, modification |
| `assistant-response` | After assistant responds | Formatting, logging, cleanup |

## Hook Format Requirements

### File Location

**Project hooks:**
```
.claude/hooks/session-start
.claude/hooks/user-prompt-submit
```

**User-global hooks:**
```
~/.claude/hooks/session-start
~/.claude/hooks/tool-call
```

### Executable Requirements

Every hook MUST:

1. **Have a shebang line:**
```bash
#!/bin/bash
# or
#!/usr/bin/env node
# or
#!/usr/bin/env python3
```

2. **Be executable:**
```bash
chmod +x .claude/hooks/session-start
```

3. **Handle JSON input from stdin:**
```bash
#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.input.file_path // empty')
```

4. **Exit with appropriate code:**
```bash
exit 0  # Success
exit 2  # Block operation
exit 1  # Error (logs but continues)
```

## Input/Output Format

### JSON Input Structure

Hooks receive JSON via stdin with event-specific data:

```json
{
  "event": "tool-call",
  "timestamp": "2025-01-15T10:30:00Z",
  "session_id": "abc123",
  "current_dir": "/path/to/project",
  "input": {
    "file_path": "/path/to/file.ts",
    "command": "npm test",
    "old_string": "...",
    "new_string": "..."
  }
}
```

### Stdout Output

- Normal output shows in transcript
- Empty output runs silently
- Use stderr (`>&2`) for errors

### Exit Codes

| Code | Meaning | Behavior |
|------|---------|----------|
| `0` | Success | Continue normally |
| `2` | Block | Stop operation, show error |
| `1` or other | Error | Log error, continue |

## Schema Validation

Hooks should validate against the JSON schema:

**Schema URL:** https://github.com/pr-pm/prpm/blob/main/packages/converters/schemas/claude-hook.schema.json

**Required frontmatter fields:**
- `name` - Hook identifier (lowercase, hyphens only)
- `description` - What the hook does
- `event` - Event type (optional, inferred from filename)
- `language` - bash, typescript, javascript, python, binary (optional)
- `hookType: "hook"` - For round-trip conversion

## Common Mistakes

| Mistake | Problem | Solution |
|---------|---------|----------|
| Not quoting variables | Breaks on spaces | Always use `"$VAR"` |
| Missing shebang | Won't execute | Add `#!/bin/bash` |
| Not executable | Permission denied | Run `chmod +x hook-file` |
| Logging to stdout | Clutters transcript | Use stderr: `echo "log" >&2` |
| Wrong exit code | Doesn't block when needed | Use `exit 2` to block |
| No input validation | Security risk | Always validate JSON fields |
| Slow operations | Blocks Claude | Run in background or use PostToolUse |
| Absolute paths missing | Can't find scripts | Use `$CLAUDE_PLUGIN_ROOT` |

## Basic Hook Examples

### Shell Script Hook

```bash
#!/bin/bash
# .claude/hooks/session-start

# Log session start
echo "Session started at $(date)" >> ~/.claude/session.log

# Check environment
if ! command -v node &> /dev/null; then
  echo "Warning: Node.js not installed" >&2
fi

# Output to user
echo "Development environment ready"
exit 0
```

### TypeScript Hook

```typescript
#!/usr/bin/env node
// .claude/hooks/user-prompt-submit

import { readFileSync } from 'fs';

// Read JSON from stdin
const input = readFileSync(0, 'utf-8');
const data = JSON.parse(input);

// Validate prompt
if (data.prompt.includes('API_KEY')) {
  console.error('Warning: Prompt may contain secrets');
  process.exit(2); // Block
}

console.log('Prompt validated');
process.exit(0);
```

## Best Practices

### 1. Keep Hooks Fast

Target < 100ms for PreToolUse hooks:
- Cache results where possible
- Run heavy operations in background
- Use specific matchers, not wildcards

### 2. Handle Errors Gracefully

```bash
# Check dependencies exist
if ! command -v jq &> /dev/null; then
  echo "jq not installed, skipping" >&2
  exit 0
fi

# Validate input
FILE=$(echo "$INPUT" | jq -r '.input.file_path // empty')
if [[ -z "$FILE" ]]; then
  echo "No file path provided" >&2
  exit 1
fi
```

### 3. Use Shebangs

Always start with shebang:
```bash
#!/bin/bash
#!/usr/bin/env node
#!/usr/bin/env python3
```

### 4. Secure Sensitive Files

```bash
BLOCKED=(".env" ".env.*" "*.pem" "*.key")
for pattern in "${BLOCKED[@]}"; do
  case "$FILE" in
    $pattern)
      echo "Blocked: $FILE is sensitive" >&2
      exit 2
      ;;
  esac
done
```

### 5. Quote All Variables

```bash
# WRONG - breaks on spaces
prettier --write $FILE

# RIGHT - handles spaces
prettier --write "$FILE"
```

### 6. Log for Debugging

```bash
LOG_FILE=~/.claude-hooks/debug.log

# Log to file
echo "[$(date)] Processing $FILE" >> "$LOG_FILE"

# Log to stderr (shows in transcript)
echo "Hook running..." >&2
```

## Publishing as PRPM Package

### Package Structure

```
my-hook/
├── prpm.json          # Package manifest
├── HOOK.md            # Hook documentation
└── hook-script.sh     # Hook executable
```

### prpm.json

```json
{
  "name": "@username/hook-name",
  "version": "1.0.0",
  "description": "Brief description shown in search",
  "author": "Your Name",
  "format": "claude",
  "subtype": "hook",
  "tags": ["automation", "security", "formatting"],
  "main": "HOOK.md"
}
```

### HOOK.md Format

```markdown
---
name: session-logger
description: Logs session start/end times for tracking
event: SessionStart
language: bash
hookType: hook
---

# Session Logger Hook

Logs Claude Code session activity for tracking and debugging.

## Installation

This hook will be installed to `.claude/hooks/session-start`.

## Behavior

- Logs session start time to `~/.claude/session.log`
- Displays environment status
- Runs silent dependency checks

## Requirements

- bash 4.0+
- write access to `~/.claude/`

## Source Code

\`\`\`bash
#!/bin/bash
echo "Session started at $(date)" >> ~/.claude/session.log
echo "Environment ready"
exit 0
\`\`\`
```

### Publishing Process

```bash
# Test locally first
prpm test

# Publish to registry
prpm publish

# Version bumps
prpm publish patch  # 1.0.0 -> 1.0.1
prpm publish minor  # 1.0.0 -> 1.1.0
prpm publish major  # 1.0.0 -> 2.0.0
```

## Security Requirements

### Input Validation

```bash
# Parse JSON safely
INPUT=$(cat)
if ! FILE=$(echo "$INPUT" | jq -r '.input.file_path // empty' 2>&1); then
  echo "JSON parse failed" >&2
  exit 1
fi

# Validate field exists
[[ -n "$FILE" ]] || exit 1
```

### Path Sanitization

```bash
# Prevent directory traversal
if [[ "$FILE" == *".."* ]]; then
  echo "Path traversal detected" >&2
  exit 2
fi

# Keep in project directory
if [[ "$FILE" != "$CLAUDE_PROJECT_DIR"* ]]; then
  echo "File outside project" >&2
  exit 2
fi
```

### User Confirmation

Claude Code automatically:
- Requires confirmation before installing hooks
- Shows hook source code to user
- Warns about hook execution
- Displays hook output in transcript

## Hooks vs Skills vs Commands

| Feature | Hooks | Skills | Commands |
|---------|-------|--------|----------|
| **Format** | Executable code | Markdown | Markdown |
| **Trigger** | Automatic (events) | Automatic (context) | Manual (`/command`) |
| **Language** | Any executable | N/A | N/A |
| **Use Case** | Automation, validation | Reference, patterns | Quick tasks |
| **Security** | Requires confirmation | No special permissions | Inherits from session |

**Examples:**
- **Hook:** Auto-format files on save
- **Skill:** Reference guide for testing patterns
- **Command:** `/review-pr` quick code review

## Related Resources

- **claude-hook-writer skill** - Detailed hook development guidance
- **typescript-hook-writer skill** - TypeScript-specific hook development
- [Claude Code Docs](https://docs.claude.com/claude-code)
- [Schema](https://github.com/pr-pm/prpm/blob/main/packages/converters/schemas/claude-hook.schema.json)

## Checklist for New Hooks

Before publishing:

- [ ] Shebang line included
- [ ] File is executable (`chmod +x`)
- [ ] Validates all stdin input
- [ ] Quotes all variables
- [ ] Handles missing dependencies gracefully
- [ ] Uses appropriate exit codes
- [ ] Logs errors to stderr or file
- [ ] Tests with edge cases (spaces, Unicode, missing fields)
- [ ] Documents dependencies in HOOK.md
- [ ] Includes installation instructions
- [ ] Source code included in documentation
- [ ] Clear description and tags in prpm.json
- [ ] Version number is semantic
