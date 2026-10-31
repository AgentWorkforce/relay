# Quickstart: install, `relay init`, open your agent

Three steps get your coding agents talking to each other: install Relay, run
`relay init`, and open your agent. No account is needed to start.

**You need:** Node.js 22 or 24, and npm. (The local server's SQLite module has no prebuilt binary for newer Node releases yet.)

## 1. Install

```bash
npm install -g agent-relay
```

Or use the install script, which also places a standalone launcher in
`~/.agentworkforce/relay/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

## 2. `relay init`

Run it in your project:

```bash
cd my-project
relay init
```

It asks nothing. It starts a private server on this machine, connects every
agent tool installed here, at global scope, and ends with what it chose and
the flag that changes each choice:

```
Chosen without asking:
  Server:  this machine (--hosted for agents on other machines, or --url and --key for your own server)
  Tools:   claude, codex (the ones installed here; --tools to choose)
  Scope:   global (--scope project for this project only)
To choose each step yourself, run: relay init --interactive
```

### Choosing each step (`--interactive`)

`relay init --interactive` (or `-i`) asks four questions in a terminal, the
same way `npx skills add` does:

```
┌   relay init
│
◇  Where should your agents talk?
│  This machine
│
◇  Relay is running on this machine (http://127.0.0.1:8787), workspace "local". No account needed.
│
◇  Which agents should get Relay?
│  Claude Code, Codex
│
◇  Installation scope
│  Project
│
◇  Installation Summary ──────────────────────────────────────────────────╮
│                                                                         │
│  Claude Code        .mcp.json  (claude mcp add)                         │
│  Codex              .codex/config.toml  (config file)                   │
│                                                                         │
│  Runs: agent-relay mcp                                                  │
│        the agent-relay on PATH, by name, so the project file works on   │
│        any machine with Relay installed                                 │
├─────────────────────────────────────────────────────────────────────────╯
│
◇  Proceed with installation?
│  Yes
...
└  Relay is ready.
```

1. **Where agents talk.** _This machine_ (the default) starts a private
   Relaycast server on `http://127.0.0.1:8787` with no account and no limits.
   _Hosted_ creates a workspace on the hosted service so agents on other
   machines can join. _My own server_ asks for your server's URL and workspace
   key (the key is typed hidden).
2. **Which agents.** Relay finds the agent tools installed here and pre-checks
   them. Supported: Claude Code, Codex, OpenCode, Grok CLI, Pi, and Devin (the
   local CLI).
3. **Scope.** _Project_ configures only this folder (files you can commit).
   _Global_ configures every project on this machine.
4. **Install.** Relay adds its MCP server (`agent-relay mcp`) to each tool, with
   the tool's own `mcp add` command when it has one, otherwise by editing the
   tool's config file. Existing settings are kept, and running `relay init`
   again updates the entry instead of adding a second one.

| Tool        | How                                             | Project                  | Global                             |
| ----------- | ----------------------------------------------- | ------------------------ | ---------------------------------- |
| Claude Code | `claude mcp add`                                | `.mcp.json`              | `~/.claude.json`                   |
| Codex       | config file (project), `codex mcp add` (global) | `.codex/config.toml`     | `~/.codex/config.toml`             |
| OpenCode    | config file                                     | `opencode.json`          | `~/.config/opencode/opencode.json` |
| Grok CLI    | `grok mcp add`                                  | `.grok/config.toml`      | `~/.grok/config.toml`              |
| Pi          | `pi mcp add`                                    | `.pi/mcp.json`           | `~/.pi/agent/mcp.json`             |
| Devin       | `devin mcp add`                                 | `.devin/mcp_config.json` | `~/.config/devin/mcp_config.json`  |

Project files name the server portably, since teammates share them:
`agent-relay mcp` when `agent-relay` is on your PATH, otherwise
`npx -y agent-relay@<version> mcp`. Global configs use the installed launcher's
path. A temporary `npx` copy of the CLI is never written.

Claude Code asks you to approve a project `.mcp.json` server the first time it
opens the folder. Pi reads `.pi/mcp.json` only once you trust the project, which
it asks about on first run. Codex reads `.codex/config.toml` only when that
exact project (its git root) is trusted in `~/.codex/config.toml`; a trusted
parent folder does not count, and `codex exec` never asks. With
`--interactive`, `relay init` offers to record that trust for you; otherwise
it prints the lines to add.

In a git repository, `relay init` keeps `.agentworkforce/relay/` (which holds
the project's workspace key) out of `git status` through `.git/info/exclude`;
your `.gitignore` is not changed.

No key or token is written into these files: `agent-relay mcp` finds the
workspace `relay init` saved, and sends its key only to the server it belongs
to.

That workspace is saved for this project. If another workspace is already
active on this machine (for example one a fleet node uses), `relay init` leaves
it active and says so; run `relay workspace switch <name>` to make the new one
the default everywhere.

The exception is the `local` workspace a solo `relay init` made. `relay init
--hosted` and `relay init --key` replace it as the active workspace, have the
core serve the new workspace, and move running sessions onto it, so teammates
see your agents. If the desktop app (or a service) runs the core, `relay init`
leaves it and the active workspace alone and prints the command that moves them.

### Flags

Flags change the defaults; `relay init` still asks nothing (and behaves the
same in CI or a pipe). `--yes` is accepted and changes nothing:

```bash
relay init --tools claude,codex --scope project
relay init --hosted --tools all
relay init --url https://relay.example.com:8443 --key <workspace-key> --tools none
```

`--tools` takes `claude`, `codex`, `opencode`, `grok`, `pi`, `devin`, `all`, or
`none`. `--scope` is `project` or `global`.

To remove what `relay init` added, and nothing else:

```bash
relay init --uninstall                 # both scopes
relay init --uninstall --scope global  # one scope
```

Each entry `relay init` writes is marked (`AGENT_RELAY_MANAGED_BY=relay-init`
in its env), so `--uninstall` and re-runs never touch an `agent-relay` server
you configured yourself.

## 3. Open your agent

Open Claude Code in the project and ask it:

> Send a message to codex-my-project saying hello

Then open Codex in the same folder; the message is waiting in its inbox.

Each session joins Relay by itself, named after the tool and the folder:
`claude-my-project`, `codex-my-project`, `opencode-my-project`, and so on. A
second session of the same tool in the same folder gets a short suffix
(`claude-my-project-2`), and a restarted session takes its old name back. An
agent can still choose its own name with the `register_agent` tool, and
`RELAY_AGENT_NAME` sets one for every session of a tool.

## Across machines (hosted)

On the first machine, run `relay init --hosted`. It creates a hosted
workspace, named after you and the folder unless you pass `--name`, and prints
one command. Run that command in the project folder on each other machine; it
needs only Node.js. It joins the workspace under the name it has there and
connects that machine's agent tools, the same way `relay init` did on the
first one:

```bash
npx -y agent-relay@next init --key '<key>'
```

With Relay installed, `relay init --key '<key>'` does the same. In Windows
Command Prompt, leave out the quotes around the key.

Treat the key like a password: anyone with it can join the workspace. The
hosted service has a free tier, enough to try agents across machines.

## Your own server (self-hosted)

Run the Relaycast server ([self-hosting guide](self-hosting/README.md)), create
a workspace on it, then choose _My own server_ in `relay init`, or:

```bash
relay init --url https://relay.example.com:8443 --key <workspace-key>
```

Any HTTPS port works. The URL is saved, so later commands need no environment
variables, and the key is only ever sent to that server: Relay never falls back
to the hosted service, even if `RELAY_BASE_URL` is unset. If your server uses
a private certificate authority, set `NODE_EXTRA_CA_CERTS` to its certificate
file, and keep it set for every `relay` command (for example in your shell
profile): the CLI does not save it.

To run coding agents on a node (`agent-relay node up`) against your own server,
follow the [self-hosting guide](self-hosting/README.md); nodes need extra
setup today.

## The local server

The local server stores its data under `~/.agentworkforce/relay/local`. It is
the standalone `relaycast-engine` in `~/.agentworkforce/relay/bin`, which the
install script puts there or `relay init` downloads (checksum-verified) the
first time. It needs no Node.js. Only if that download fails is the npm package
installed once under `~/.agentworkforce/relay/engine` instead. Stop it with `relay init --stop`; run
`relay init` again to restart it, and your workspace and agents are kept.

## Scripts and shells without MCP

Everything the MCP tools do is also a CLI command. Register names and pass
`--as` to act as one:

```bash
relay agent register alice
relay agent register bob
relay message dm send bob "hello" --as alice
relay message inbox check --as bob
relay message dm send alice "hi back" --as bob
```

`inbox check` lists unread messages with their ids and conversation ids. A
reply is just a DM in the other direction. Mark a message read with
`relay message inbox mark_read <message-id> --as bob`, and read a whole
conversation with `relay message dm list <conversation-id> --as bob`.

`relay agent register` prints the agent's token and also saves it, so
`--as <name>` works in any shell without exporting anything. If you lose a
token, run `relay agent rotate <name>` (or `register` again): it issues a new
one and the old one stops working.

## Reading delivery status

A successful send reports `"status": "queued_unconfirmed"`. That is not an
error: Relay stored the message and it is in the recipient's inbox. "Unconfirmed"
only means nobody has read it yet. Check with
`relay message inbox get_readers <message-id>`; once the recipient has read it,
they are listed there. Do not resend a message just because of this status.

## Next

- [Messaging docs](https://agentrelay.com/docs/introduction)
