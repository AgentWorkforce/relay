---
name: spawn-cloud-swarm
description: Use when spawning a swarm of cloud agents that share the user's local working directory via relayfile. Orchestrates local-mount lifecycle (ensure → monitor → teardown) around N cloud.agent.spawn calls. Requires `cloud.local-mount.*` MCP tools.
tags: cloud, multi-agent, relayfile, mount, swarm
---

# Spawn Cloud Swarm

## When to Use

The user asks to spawn one or more cloud-hosted agents that need to read or
write files from the current working directory — the project on their laptop.
Examples:

- "spawn 4 cloud workers to fix these typecheck errors"
- "kick off a swarm in the cloud against this repo"
- "run claude in the cloud on this project"

This skill drives the full lifecycle so the user's host edits and the cloud
workers' edits stay in sync through relayfile.

## Prereqs the Skill Enforces

Before spawning anything, confirm the host has the three artifacts the cloud
spawn flow depends on. Use the relaycast MCP `cloud.*` tools to probe; do
**not** read the underlying files directly from this skill.

1. `cloud.json` exists at `~/.config/agent-relay/cloud.json` (proves
   `agent-relay cloud login` has run). If missing, surface the verbatim
   remediation code `NEEDS_CLOUD_LOGIN` and the exact command the user must
   run: `agent-relay cloud login`. Then stop.
2. `connections.json` exists at `~/.config/agent-relay/connections.json`
   (proves `agent-relay cloud connect <provider>` has run for at least one
   CLI). If missing, surface `NEEDS_CLI_CONNECTION` and instruct the user to
   run `agent-relay cloud connect claude` (or codex, etc.). Then stop.
3. The current working directory is a relayfile-registered workspace. Call
   `cloud.local-mount.status { localDir: CWD }` — if the MCP reports the
   directory is not registered, surface `NEEDS_RELAYFILE_SETUP` and instruct
   the user to run `relayfile setup --local-dir <CWD>`. Then stop.
4. The relaycast MCP surface exposes every tool this skill drives. Before
   the prereq checks above, confirm `cloud.local-mount.ensure`,
   `cloud.local-mount.status`, and `cloud.local-mount.stop` are all
   registered on the MCP client. If any are missing, surface
   `MCP_LOCAL_MOUNT_TOOLS_MISSING` and the verbatim remediation: "Upgrade
   `@relaycast/mcp` to a build that includes `cloud.local-mount.*` (see
   relaycast PR `feat/cloud-local-mount-tools`)." Then stop.

All four remediation strings must be quoted verbatim so downstream tooling
can match on them.

## Procedure

Once prereqs pass:

1. **Ensure local mount.** Call
   `cloud.local-mount.ensure { localDir: CWD }`. The response shape is
   `{ mountPath, workspaceId, status: "running" | "started" }`. Record
   `workspaceId` — every spawned agent must be pinned to this workspace so
   their sandbox mounts the same tree the host is editing.

2. **Spawn workers.** Loop N times calling `cloud.agent.spawn` with the
   user's requested `cli`, `model`, `task`, and the `workspaceId` from step 1.
   On `QUOTA_EXCEEDED` from the server, wait 10 seconds and retry; allow up
   to 3 backoff cycles before failing. Surface a one-line note to the
   assistant for each successful spawn including the returned agent name and
   sandbox URL.

3. **Monitor.** Until every spawned agent has exited:
   - Every 5 seconds call `cloud.local-mount.status { localDir: CWD }`.
     If `conflictCount > 0`, surface a one-line warning naming the conflict
     count and the path of the conflict file (the MCP reports the first one).
     If `running` flips to false, surface a critical warning and stop the
     poll loop — the mount has died and the workers can no longer see host
     edits.
   - Every 5 seconds call `cloud.agent.list`. When an agent transitions to
     a terminal status (`completed`, `failed`, `killed`), report it once.
   - Stop polling when the count of non-terminal agents reaches zero.

4. **Teardown.** When the swarm has exited, ask the user one question:
   "Persist the local mount for next time, or stop it now? [persist]" The
   default (no answer / Enter / "persist") is to leave the mount running so
   the next spawn is faster. On an explicit "stop" / "no" / "tear down",
   call `cloud.local-mount.stop { localDir: CWD }` and confirm the response
   shape `{ stopped: true }`.

## Error Handling

| Error code | Where it surfaces | Verbatim remediation |
|---|---|---|
| `NEEDS_CLOUD_LOGIN` | Prereq 1 | "Run `agent-relay cloud login` to authenticate." |
| `NEEDS_CLI_CONNECTION` | Prereq 2 | "Run `agent-relay cloud connect claude` (or your CLI) to register a provider." |
| `NEEDS_RELAYFILE_SETUP` | Prereq 3 | "Run `relayfile setup --local-dir <CWD>` to register this directory as a relayfile workspace." |
| `MCP_LOCAL_MOUNT_TOOLS_MISSING` | Prereq 4 | "Upgrade `@relaycast/mcp` to a build that includes `cloud.local-mount.*` (see relaycast PR `feat/cloud-local-mount-tools`)." |
| `MOUNT_FAILED` | Step 1 | Report the MCP-returned error string verbatim and instruct the user to inspect `relayfile status`. Do not retry — the user's environment needs attention. |
| `QUOTA_EXCEEDED` | Step 2 | Internal: wait 10s and retry up to 3 cycles. If still failing, surface "Your cloud plan's concurrent worker limit was reached. Wait for a worker to finish or upgrade your plan." |
| `MOUNT_DIED` | Step 3 | "The local mount stopped while workers were running. Their later writes did not reach your host. Run `relayfile status` and `cloud.local-mount.ensure` before re-spawning." |
| `STOP_FAILED` | Step 4 | Report verbatim, then suggest `relayfile mount stop --local-dir <CWD>` as a manual fallback. |

## Boundaries

This skill **does not**:

- Spin up the relayfile mount process itself. That is the
  `cloud.local-mount.ensure` MCP tool's job; the skill only orchestrates.
- Make decisions about how many workers to spawn. The user — or the calling
  assistant — chooses N.
- Persist any state between runs other than what relayfile / cloud already
  persist. The skill is stateless across invocations.
- Edit any file in the user's working directory. Reads only what it needs
  to confirm prereqs (and that read goes through the MCP, not direct fs).
- Touch the `cloud.*` MCP surface beyond `cloud.local-mount.ensure`,
  `cloud.local-mount.status`, `cloud.local-mount.stop`, `cloud.agent.spawn`,
  and `cloud.agent.list`.
