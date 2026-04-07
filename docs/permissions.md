# Permissions

Control what workflow agents can read, write, execute, and access over the network.

## Quick Start

```yaml
agents:
  - name: reviewer
    cli: claude
    permissions: readonly # preset string

  - name: writer
    cli: codex
    permissions:
      access: restricted # inline block
      files:
        read: ['src/**']
        write: ['docs/**']
        deny: ['.env*', 'secrets/**']
```

## Access Presets

| Preset       | Read                    | Write                   | Dotfiles  |
| ------------ | ----------------------- | ----------------------- | --------- |
| `readonly`   | all non-ignored         | none                    | inherited |
| `readwrite`  | all non-ignored         | all non-ignored         | inherited |
| `restricted` | nothing (explicit only) | nothing (explicit only) | inherited |
| `full`       | everything              | everything              | ignored   |

Default when omitted: `readwrite`.

## File Permissions

```yaml
permissions:
  access: restricted
  files:
    read: ['src/**', 'package.json']
    write: ['tests/**']
    deny: ['.env*', 'secrets/**']
```

- `write` implies read access
- `deny` always wins over read/write grants
- Merged on top of the access preset

## Network

```yaml
# Boolean — allow or deny all
permissions:
  network: false

# Object — scoped allowlist
permissions:
  network:
    allow: ['registry.npmjs.org:443', 'github.com:443']
    deny: ['*']
```

## Exec

```yaml
permissions:
  exec: ['npm test', 'npx vitest', 'git diff']
```

Matches by command prefix. Omit to allow all commands.

## Profiles

Reusable named permission blocks:

```yaml
permissions:
  profiles:
    source-dev:
      access: restricted
      files:
        read: ['src/**', 'packages/**', 'package.json']
        write: ['src/**', 'tests/**']
        deny: ['.env*', 'secrets/**']
      network: false
  default: source-dev

agents:
  - name: frontend
    cli: codex
    permissions: source-dev
```

## Dotfiles

- `.agentignore` — hides files from agents entirely
- `.agentreadonly` — visible but not writable
- `.<agent>.agentignore` / `.<agent>.agentreadonly` — per-agent overrides

Applied before YAML rules. Bypassed by `full` preset.

## Resolution Order

1. Dotfiles (when inherited)
2. `access` preset
3. Explicit `files` globs
4. `deny` rules (always win)

## Step-Level Overrides

Steps can narrow the agent's permissions for a specific task:

```yaml
steps:
  - name: ui
    type: agent
    agent: frontend
    permissions:
      access: restricted
      files:
        write: ['src/components/**']
```
