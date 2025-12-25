---
name: creating-claude-rules
description: Use when creating or fixing .claude/rules/ files - provides correct paths frontmatter (not globs), glob patterns, and avoids Cursor-specific fields like alwaysApply
---

# Creating Claude Rules

## Overview

Rules in `.claude/rules/` are modular instructions scoped to specific files via glob patterns. They load automatically with same priority as `CLAUDE.md`.

## When to Use

- Creating new rules in `.claude/rules/`
- Fixing rules that use wrong frontmatter (`globs` instead of `paths`)
- Migrating Cursor rules to Claude format
- Organizing project-specific conventions

## Quick Reference

| Field | Claude | Cursor |
|-------|--------|--------|
| Path patterns | `paths` | `globs` |
| Always apply | Omit `paths` | `alwaysApply: true` |
| Description | Not documented | `description` |

## Frontmatter

### Path-Scoped Rules

```yaml
---
paths:
  - "src/api/**/*.ts"
  - "tests/**/*.test.ts"
---
```

Or single pattern:

```yaml
---
paths: src/**/*.{ts,tsx}
---
```

### Global Rules

Omit frontmatter entirely - applies to all files:

```markdown
# TypeScript Conventions

Use .js extensions in imports.
```

## Common Mistakes

```yaml
# ❌ WRONG - globs is Cursor format
---
globs:
  - "**/*.ts"
---

# ✅ CORRECT - Claude uses paths
---
paths:
  - "**/*.ts"
---
```

```yaml
# ❌ WRONG - alwaysApply is Cursor-only
---
alwaysApply: true
---

# ✅ CORRECT - just omit paths for global rules
# (no frontmatter needed)
```

```yaml
# ❌ WRONG - unquoted patterns
---
paths:
  - **/*.ts
---

# ✅ CORRECT - quote glob patterns
---
paths:
  - "**/*.ts"
---
```

## Directory Structure

```
.claude/rules/
├── testing.md          # Path-scoped or global
├── typescript.md
└── frontend/           # Subdirectories supported
    └── react.md
```

Files discovered recursively. Use subdirectories to organize.

## Glob Patterns

| Pattern | Matches |
|---------|---------|
| `**/*.ts` | All .ts files anywhere |
| `src/**/*` | Everything under src/ |
| `*.md` | Markdown in root only |
| `**/*.{ts,tsx}` | .ts and .tsx files |
| `{src,lib}/**/*.ts` | .ts in src/ or lib/ |

## Reference

https://code.claude.com/docs/en/memory#modular-rules-with-claude/rules/
