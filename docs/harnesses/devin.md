# Devin CLI

Relay supports `devin` as a PTY harness in local spawning, fleet spawning and
Agent Relay MCP. Install and authenticate Devin separately, then use:

```sh
agent-relay local agent spawn devin --name reviewer --task 'Review the current diff'
```

The TypeScript harness export is `devin` from `@agent-relay/harnesses`.
Use `model` to pass Devin's `--model`; `/model <name>` switches a running session.
Available model names depend on the account: run `devin models list`.
An explicit Relay session reference resumes with `--resume <id>`; conflicting
resume/continue arguments are rejected. Relay does not discover new Devin
session IDs from terminal output.

## Permissions and readiness

Verified against Devin `3000.10.31 (b98cc431)` on Linux. Its default permission
mode is `auto` (read-only tools); workspace trust is enabled by default.
Relay adds no approval, permission or trust bypass flags and disables generic
PTY auto-responders for Devin. Trust and tool approvals require an operator in
an attached terminal. Authenticate and trust the intended worktree before
unattended spawning. Trust is scoped to that directory.

Readiness requires the live idle `❭ Ask Devin to build features, fix bugs, or
work on your code` composer at the cursor. Trust choices, busy composers and
output byte counts do not establish readiness. Messages remain queued while
an approval or other dialog occupies the composer.

Both initial tasks and follow-up messages use bracketed paste, then a separate
Enter after 250 ms. In the installed CLI, a paste and Enter in one terminal
write left the prompt in the composer; a later Enter submitted it. Relay does
not send repeated recovery Enters that might accidentally approve a tool.

## MCP configuration

Devin's `--config` overrides settings, but does not relocate its user MCP file.
The broker's dedicated PTY worker creates a private temporary XDG configuration
snapshot, preserving existing Devin settings and unrelated MCP server entries,
and supplies a worker-specific `agent-relay` entry in
`$XDG_CONFIG_HOME/devin/mcp_config.json`. HOME and data directories remain
unchanged so authentication, workspace trust and session storage remain usable.
No credentials appear in command arguments. The source user files are never
rewritten; each worker receives its own snapshot. Snapshot files are private,
MCP writes are atomic, and normal worker exit deletes the temporary directory.
A forcibly killed wrapper can leave a private snapshot requiring cleanup.

Malformed MCP files and symlinks inside the Devin configuration directory are
rejected. A project MCP entry named `agent-relay` is rejected rather than
silently overriding the worker's identity. Other project configuration remains
under Devin's normal loading and trust rules. Configuration changes made in a
running worker's user snapshot do not update the original user settings.

The isolated configuration is installed by the broker PTY/wrap process;
`mcp-args --cli devin` alone does not configure a standalone Devin process.
Only Linux has been exercised end to end. Windows executable suffixes are
recognized for readiness and submission; native Windows configuration isolation
has not been validated.

## Rollout

Deploy the patched broker and CLI through the normal approved rollout. Nodes
using the default harness set advertise `spawn:devin`; nodes with an explicit
harness list must add `devin`. The executable and authenticated account must be
available on the selected node. No production broker restart is required to
validate a candidate: use a separately built broker, unique node ID and private
state directory on the same host.
