# Permissions

Permissions control what a workflow agent can read, write, execute, and access over the network.

This page documents the synthesized `relay.yaml` permissions grammar:

- Flat by default: `access`, `files`, `network`, and `exec`
- Reusable when needed: named permission profiles
- Strict when needed: explicit deny rules and step-level overrides

If you are working against an older runner, verify support for profiles, step-level overrides, or granular `network` / `exec` blocks before relying on them.

## Overview

You can assign permissions in three ways:

1. A preset string such as `readonly`
2. An inline permission block
3. A profile name defined under top-level `permissions.profiles`

```yaml
agents:
  - name: reviewer
    cli: claude
    permissions: readonly

  - name: writer
    cli: codex
    permissions:
      access: restricted
      files:
        read: ['docs/**', 'src/**']
        write: ['docs/**']

permissions:
  profiles:
    safe-reviewer:
      access: readonly
      files:
        deny: ['.env*', 'secrets/**']
```

## Quick Start

For most workflows, start with one of these three patterns.

### Read-only reviewer

```yaml
permissions: readonly
```

Use this for audit, review, planning, or analysis agents.

### Restricted docs writer

```yaml
permissions:
  access: restricted
  files:
    read: ['src/**', 'README.md']
    write: ['docs/**']
    deny: ['.env*', 'secrets/**']
```

Use this when an agent should only touch a narrow part of the repo.

### Test runner with command allowlist

```yaml
permissions:
  access: readonly
  network: false
  exec: ['npm test', 'npx vitest']
```

Use this when the agent should inspect code and run a small, approved command set.

## Grammar

```yaml
# Top-level, optional
permissions:
  profiles:
    <name>: <PermissionBlock>
  default: <preset> | <profile-name>

# On an agent or workflow step
permissions: readonly
permissions: my-profile
permissions:
  access: restricted
  files:
    read: ['glob', ...]
    write: ['glob', ...]
    deny: ['glob', ...]
  network: true | false
  exec: ['cmd prefix', ...]
```

Full synthesized grammar:

```yaml
permissions:
  profiles:
    <name>: <PermissionBlock>
  default: <preset> | <profile-name>

# <PermissionBlock>
access: readonly | readwrite | restricted | full

files:
  read:  ['glob', ...]
  write: ['glob', ...]
  deny:  ['glob', ...]

network: true | false
       | allow
       | deny
       | { allow: ['host:port', ...], deny: ['host:port', ...] }

exec: ['cmd prefix', ...]
    | allow
    | deny
    | { allow: ['pattern', ...], deny: ['pattern', ...] }
```

## Presets

`access` is the fast path. It expands into base filesystem behavior before explicit file rules are merged in.

### `readonly`

- Read all non-ignored files
- Write nothing
- Inherits `.agentignore` and `.agentreadonly`

### `readwrite`

- Read all non-ignored files
- Write all non-ignored files
- Inherits `.agentignore` and `.agentreadonly`
- This is the fallback if nothing else is specified

### `restricted`

- Read nothing by default
- Write nothing by default
- Requires explicit `files.read` and/or `files.write`

### `full`

- Read everything
- Write everything
- Ignores `.agentignore` and `.agentreadonly`

Example:

```yaml
permissions:
  access: readonly
```

## File Permissions

Use `files.read`, `files.write`, and `files.deny` to narrow or expand the preset.

```yaml
permissions:
  access: restricted
  files:
    read: ['src/**', 'package.json', 'tsconfig.json']
    write: ['tests/**', '**/*.test.ts']
    deny: ['.env*', 'secrets/**', 'node_modules/**']
```

### Rules

- `files.read` grants read access
- `files.write` grants both read and write access
- `files.deny` always wins
- Explicit file rules are merged on top of the preset

### Common patterns

Docs only:

```yaml
permissions:
  access: restricted
  files:
    read: ['src/**', 'README.md']
    write: ['docs/**', 'web/content/docs/**']
```

Backend only:

```yaml
permissions:
  access: restricted
  files:
    read: ['src/**', 'packages/**', 'package.json']
    write: ['src/server/**', 'src/api/**']
    deny: ['src/components/**']
```

Never expose secrets:

```yaml
permissions:
  access: readonly
  files:
    deny: ['.env*', 'secrets/**', '**/*.pem']
```

## Dotfiles

Relay can inherit file restrictions from workspace dotfiles:

- `.agentignore`
- `.agentreadonly`
- `.<agent>.agentignore`
- `.<agent>.agentreadonly`

These are applied before explicit YAML rules, except for `full`, which bypasses them.

### What they do

- `.agentignore` hides files from the agent entirely
- `.agentreadonly` keeps files visible but not writable
- Agent-specific dotfiles apply only to one named agent

Example:

```text
# .agentignore
secrets/**
dist/**
```

```text
# .reviewer.agentreadonly
docs/**
README.md
```

### Resolution order

Permissions resolve in this order:

1. Dotfiles when the preset inherits them
2. The `access` preset
3. Explicit `files.read` and `files.write`
4. `files.deny`
5. If profiles are used: step permissions, then agent permissions, then `permissions.default`, then `readwrite`

In practice:

- `full` ignores dotfiles entirely
- `restricted` starts from nothing
- `deny` beats read and write grants

## Advanced

### Profiles

Profiles let you reuse the same permission block across many agents.

```yaml
permissions:
  profiles:
    source-dev:
      access: restricted
      files:
        read: ['src/**', 'packages/**', 'package.json', 'tsconfig.json']
        write: ['src/**', 'packages/**', 'tests/**']
        deny: ['.env*', 'secrets/**', 'infrastructure/**']
      network: false

    reviewer:
      access: readonly
      files:
        deny: ['.env*', 'secrets/**']

  default: reviewer
```

Then reference them by name:

```yaml
agents:
  - name: frontend
    cli: codex
    permissions: source-dev

  - name: reviewer
    cli: claude
    permissions: reviewer
```

### Network

Use the simple boolean when all you need is on or off:

```yaml
permissions:
  network: false
```

Use scoped rules when an agent should only reach approved destinations:

```yaml
permissions:
  network:
    allow: ['registry.npmjs.org:443', 'github.com:443', 'nvd.nist.gov:443']
    deny: ['*']
```

Guidance:

- Prefer `false` for local-only work
- Prefer an allowlist for security review or dependency lookup tasks
- Treat `deny: ['*']` as the default floor when using granular host rules

### Exec

Use `exec` to control which shell commands the agent may run.

Simple allowlist:

```yaml
permissions:
  exec: ['npm test', 'npx vitest', 'git diff']
```

Allow everything:

```yaml
permissions:
  exec: allow
```

Block everything:

```yaml
permissions:
  exec: deny
```

Granular allow and deny:

```yaml
permissions:
  exec:
    allow: ['npm test', 'npx vitest', 'cargo test']
    deny: ['rm -rf', 'git push', 'docker system prune']
```

Guidance:

- Keep allowlists short and reviewable
- Prefer command prefixes over overly broad patterns
- Use deny rules for high-risk operations even when broader execution is allowed

### Step-level overrides

Workflow steps can replace the agent's default permissions for a narrower task.

```yaml
workflows:
  - name: fullstack-feature
    steps:
      - name: ui
        type: agent
        agent: frontend
        permissions:
          access: restricted
          files:
            read: ['src/**', 'packages/**', 'package.json']
            write: ['src/components/**', 'src/pages/**', 'src/styles/**']
            deny: ['.env*', 'src/server/**']
```

Keep step overrides narrow and explicit. They are easier to review than a broad agent-level permission set.

## Examples

### Code review

```yaml
version: '1.0'
name: code-review

agents:
  - name: lead
    cli: claude
    role: 'Coordinates review feedback'
    permissions: readonly

  - name: logic-reviewer
    cli: codex
    role: 'Checks correctness and edge cases'
    interactive: false
    permissions:
      access: readonly
      files:
        deny: ['.env*', 'secrets/**']
```

### Test-fix cycle

```yaml
version: '1.0'
name: test-suite

agents:
  - name: runner
    cli: codex
    role: 'Executes test suites'
    interactive: false
    permissions:
      access: readonly
      exec: ['npm test', 'npx vitest', 'npx jest']
      network: false

  - name: fixer
    cli: codex
    role: 'Fixes failing tests'
    interactive: false
    permissions:
      access: restricted
      files:
        read: ['src/**', 'tests/**', 'package.json', 'tsconfig.json']
        write: ['tests/**', '**/*.test.ts', '**/*.spec.ts']
        deny: ['.env*', 'secrets/**', 'node_modules/**']
```

### Full-stack feature with profiles

```yaml
version: '1.0'
name: full-stack

permissions:
  profiles:
    source-dev:
      access: restricted
      files:
        read: ['src/**', 'packages/**', 'package.json', 'tsconfig.json']
        write: ['src/**', 'packages/**', 'tests/**']
        deny: ['.env*', 'secrets/**', 'infrastructure/**']
      network: false

    reviewer:
      access: readonly
      files:
        deny: ['.env*', 'secrets/**']

  default: reviewer
```

### Security audit with network allowlist

```yaml
version: '1.0'
name: security-audit

agents:
  - name: auditor
    cli: claude
    role: 'Scans for vulnerabilities'
    permissions:
      access: readonly
      network:
        allow: ['registry.npmjs.org:443', 'github.com:443', 'nvd.nist.gov:443']
        deny: ['*']
      exec: ['npm audit', 'npx snyk test']
```

### Docs-only workflow

```yaml
version: '1.0'
name: docs-update

agents:
  - name: writer
    cli: claude
    role: 'Writes and updates documentation'
    permissions:
      access: restricted
      files:
        read: ['src/**', 'packages/**', 'README.md']
        write: ['docs/**', 'web/content/docs/**']
        deny: ['.env*', '.git/**']
```

## FAQ

### What happens if I omit `permissions` entirely?

The default is `readwrite`. The agent reads and writes the normal workspace view, while inherited dotfiles still apply unless bypassed by `full`.

### When should I use `restricted` instead of `readonly`?

Use `restricted` when the agent should only see part of the repo. Use `readonly` when the agent can inspect broadly but should not modify files.

### Does `files.write` imply read access?

Yes. A writable file is also readable.

### What wins if a path is in both `write` and `deny`?

`deny` wins.

### Do dotfiles still matter when YAML permissions exist?

Yes, unless the effective preset is `full`. Dotfiles apply first, then explicit YAML rules refine the result, and deny rules still win at the end.

### Should I use profiles everywhere?

No. Start with inline permissions. Add profiles when multiple agents share the same rules and duplication starts to hide intent.

### Should I prefer boolean or granular `network` / `exec` settings?

Prefer the simple form first. Use granular allow and deny blocks only when you have a clear review or security need.
