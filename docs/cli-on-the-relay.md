# On the relay

Launch an agent into the sandboxed relay environment, preview permissions, and shut the services down.

`agent-relay on` is the CLI entry point for running an agent inside the relay sandbox, with mounted services and permission-aware workspace access.

## Launch an agent

```bash
agent-relay on codex --agent reviewer -- --model gpt-5.4
```

Common options:

- `--agent <name>` sets the relay identity name.
- `--workspace <id>` joins an existing relay workspace.
- `--port-auth <port>` overrides the Relayauth port.
- `--port-file <port>` overrides the Relayfile port.
- any extra args after `--` are passed through to the underlying CLI.

## Preview or diagnose the environment

```bash
agent-relay on --scan
agent-relay on --doctor
```

- `--scan` previews what the agent will be able to see before launch.
- `--doctor` checks prerequisites and exits without starting a session.

## Stop relay services

```bash
agent-relay off
```

Use `off` when you are done with the mounted relay environment and want a clean shutdown.

## File visibility with dotfiles

Place `.agentignore` and `.agentreadonly` files in the project root to control what the agent sees. Both use gitignore-style glob syntax (one pattern per line, `#` for comments). `.agentignore` hides files entirely; `.agentreadonly` makes them visible but not writable.

```text
# .agentignore
.env*
secrets/**
```

```text
# .agentreadonly
docs/**
README.md
```

For per-agent rules, prefix with the agent name: `.reviewer.agentignore`, `.writer.agentreadonly`.

Dotfiles are loaded automatically and applied before YAML-level permissions. Use `--scan` to preview what the agent will see. See [Permissions](permissions.md) for full details.

> **Note:** `.agentignore` does **not** inherit from `.gitignore`. The relay automatically skips `.git`, `node_modules`, and `.relay` regardless of your dotfiles.

## Isolation model

`agent-relay on` copies your project into a mount directory and sets the agent's working directory to it. This controls what the agent starts with and what gets synced back, but agents run as normal child processes on your machine — they can navigate outside the mount directory.

For true sandboxed execution, use [cloud mode](cli-cloud-commands.md). Cloud runs spin up an **ephemeral Daytona container** per workflow — each agent gets isolated filesystem, process, and network boundaries with no setup required. Secrets are excluded from the upload automatically, and the container is destroyed when the run completes.

|            | Local (`on`)           | Cloud                      |
| ---------- | ---------------------- | -------------------------- |
| Filesystem | Copy-based (escapable) | Container-isolated         |
| Process    | Bare child process     | Container process          |
| Network    | Unrestricted           | Container network policies |
| Setup      | None                   | None                       |

## See also

- [CLI Overview](cli-overview.md) — Full map of the CLI command surface.
- [Cloud commands](cli-cloud-commands.md) — Run workflows remotely instead of entering the sandbox yourself.
- [Authentication](authentication.md) — Understand the auth service used by relay-aware environments.
- [File sharing](file-sharing.md) — Shared filesystem concepts used by the relay environment.
