---
name: setting-up-relayfile
description: Use when an agent or human needs to set up relayfile end-to-end so agents can read and write provider files through a local mount. Covers `relayfile setup`, dynamic integration discovery with `relayfile integration available/search`, Nango and Composio backend selection, Atlassian site selection and metadata, cloud login, OAuth/connect flows, mount verification, `RELAYFILE_LOCAL_DIR` handoff, writeback status and retry commands, and key May 2026 cloud-mount gotchas.
---

### Overview

Relayfile mounts a provider (Notion, Linear, Slack, GitHub, and other adapter-backed integrations) as ordinary files on disk so an agent can read and write through the filesystem instead of calling APIs. This skill is the canonical setup recipe. Follow it top-to-bottom for first-time setup; jump to **Recovering from breakage** if a working mount has gone wrong.

### When to use this skill

- An agent needs read access to a provider (e.g., "summarize this Notion database").
- An agent needs to write back to a provider (e.g., "post a review on this Notion page", "update this Linear issue").
- A human is setting up a mount before delegating work to an agent.
- A mount stopped reflecting changes and you need to diagnose where.

### What you get

#### After setup, files appear under `<local-dir>/<provider>/...`:

```text
~/relayfile-mount/notion/
├── databases/
│   ├── <slug>--<id>/
│   │   ├── metadata.json     ← database schema (read-only)
│   │   └── pages/
│   │       ├── <slug>--<id>.json     ← page metadata
│   │       └── <slug>--<id>/
│   │           ├── content.md        ← page body (READ + WRITE)
│   │           └── blocks/<id>.json  ← raw Notion block tree
└── pages/                            ← top-level pages (not in a database)
```

### Prerequisites

- Recent `relayfile` CLI on `$PATH`. Verify: `relayfile --help` should list `setup`, `integration`, `writeback`, and the `integration available` / `integration search` / `integration set-metadata` subcommands.
- A modern macOS or Linux shell with `jq` for JSON inspection. AWS CLI access is optional and only needed for internal cloud log diagnostics.
- Network access to `agentrelay.com/cloud` (cloud control plane), `api.relayfile.dev` (relayfile API), `connect.nango.dev` (Nango OAuth), and Composio connect endpoints when using `--backend composio`.

### Step 1 — Run setup (interactive happy path)

#### ```bash

```bash
relayfile setup \
  --provider notion \
  --workspace my-agent \
  --local-dir ~/relayfile-mount \
  --no-open
```

### Step 2 — Verify the mount is healthy

#### ```bash

```bash
relayfile status my-agent
```

### Step 3 — Hand off to an agent

#### Pattern A: local agent (Claude Code, scripts, Cursor)

```bash
export RELAYFILE_LOCAL_DIR=~/relayfile-mount
# point Claude Code at the dir or `cd` in
```

#### Pattern B: remote agent / SDK access (no disk mirror)

```ts
import { RelayFileClient } from '@relayfile/sdk';

const token = process.env.RELAYFILE_TOKEN; // from ~/.relayfile/credentials.json
const client = new RelayFileClient({ token, server: 'https://api.relayfile.dev' });

// Read
const file = await client.getFile('rw_xxxxxxxx', '/notion/pages/xxx/content.md');

// Write — triggers writeback automatically
await client.putFile('rw_xxxxxxxx', '/notion/pages/xxx/content.md', {
  content: '# New body\n\n…',
  contentType: 'text/markdown',
});
```

### Step 4 — Verify writeback works (optional but recommended)

#### Skip-able if the agent only reads. Required if the agent will write.

```bash
echo "[writeback test $(date -u +%FT%TZ)]" > ~/relayfile-mount/notion/pages/<throwaway-page>/content.md
```

### Discover writeback contracts before writing

#### Do not guess writeback shapes and do not use a magic `new.json` filename. Current relayfile adapters ship discovery documents for writable resources:

```text
<provider>/
├── .adapter.md                         ← adapter overview, operations, ID patterns
└── <resource>/
    ├── .schema.json                    ← full-record JSON Schema, draft 2020-12
    └── .create.example.json            ← minimal create payload
```

### Path conventions per provider

| Provider | Read paths                                                                                                          | Write paths                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notion   | `/notion/pages/<slug>--<id>/content.md`, `/notion/databases/<id>/pages/.../content.md`, `<slug>.json` (metadata)    | same paths overwrite the body / properties                                                                                                         |
| Slack    | `/slack/channels/<id>/messages/` plus `.adapter.md` / `.schema.json` discovery                                      | create by writing a valid message JSON to `/slack/channels/<id>/messages/<non-canonical>.json`; edit/delete canonical message files when supported |
| Linear   | `/linear/issues/<id>.json`, comments under issue resources, plus `.adapter.md` / `.schema.json` discovery           | create by writing a valid issue/comment JSON to a non-canonical filename; edit/delete canonical issue files when supported                         |
| GitHub   | `/github/repos/<owner>/<repo>/pulls/<n>/metadata.json`, `files.json`, plus `.adapter.md` / `.schema.json` discovery | create a review by writing the review JSON to a non-canonical file under the reviews resource                                                      |

`new.json` is not special in the file-native adapter contract. If a current `.adapter.md` and `.schema.json` are present, translate older examples using `/messages/new.json` or `/comments/new.json` to "write the create payload to any non-canonical filename in the resource directory." If the live mount only exposes `new.json`, treat that as an older deployment surface and follow the mounted template or wait for the workspace to refresh onto the new adapter version.

`<local-dir>/.relay/` is reserved — never write there. Anything you put under it gets ignored or treated as daemon state.

### Adding more integrations after setup

#### Do not guess provider names. Ask the CLI for the live catalog first; it pulls static Relayfile integrations plus dynamic Nango providers and Composio toolkits from the cloud, then caches the result locally.

```bash
relayfile integration available --refresh
relayfile integration search docker --backend composio --refresh
relayfile integration available --backend nango --search notion
```

### Common gotchas

#### G2 — OAuth callback timing trap

```bash
curl -sS -X POST "https://agentrelay.com/cloud/api/v1/workspaces/<id>/integrations/connect-session" \
  -H "Authorization: Bearer $(cat ~/.relayfile/credentials.json | jq -r .token)" \
  -H "Content-Type: application/json" \
  -d '{"allowedIntegrations":["notion"]}'
```

#### G3 — Dynamic provider discovery and Composio names

```bash
relayfile integration search <term> --backend composio --refresh
relayfile integration search <term> --backend nango --refresh
```

#### G4 — Jira / Confluence sync says `cloudId` is missing

```bash
relayfile integration connect jira --workspace my-agent --no-open
# or, if you know the target site:
relayfile integration set-metadata jira cloudId=<cloud-id> baseUrl=https://<site>.atlassian.net --workspace my-agent --yes
```

#### G6 — Mount mirror dir conventions

```text
<local-dir>/
├── <provider>/...                     ← actual files
├── .relay/
│   ├── state.json                     ← daemon's live state (workspaceId, lag, counters, remoteRoot)
│   ├── integrations/<provider>.json   ← per-integration metadata
│   ├── dead-letter/<opId>.json        ← failed writebacks (Phase 1 dead-letter)
│   ├── permissions-denied.log         ← read/write denials preserved for diagnosis
│   ├── disconnected/<provider>.json   ← marker after `integration disconnect`
│   └── conflicts/<resolved-conflicts>
└── .relayfile-mount-state.json        ← sync revisions per file
```

### Recovering from breakage

#### Symptom: file edits don't appear in the provider

```bash
relayfile writeback status my-agent --json | jq
```

### Cleaning up

#### When you're done with a mount and want to tear down:

```bash
# 1. stop the daemon
relayfile stop my-agent

# 2. disconnect each integration (revokes OAuth, removes <provider>/ tree)
relayfile integration disconnect notion --workspace my-agent --yes

# 3. remove the local workspace registration
relayfile workspace delete my-agent --yes

# 4. delete the mirror dir
rm -rf ~/relayfile-mount
```

### What this skill does NOT cover

- **Self-hosted relayfile** (running your own `relayfile-server` Go binary against a private Nango). For most agent use-cases the managed cloud at `agentrelay.com` is the right choice; self-hosted is for environments where data residency rules out the cloud.
- **Multi-workspace agents.** A single agent talking to multiple workspaces simultaneously needs careful token handling that's out of scope here.
- **GitHub-via-relayfile** for source code. The GitHub adapter exists but the productized cloud-mount workflow is heavier-weight than `git clone`; only use it if the agent specifically benefits from filesystem-shaped access to PR metadata, reviews, etc.

### Quick reference

| Command                                                                                             | Purpose                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `relayfile setup --provider <p> --workspace <name> --local-dir <path>`                              | First-time setup                                                                |
| `relayfile status <workspace>`                                                                      | Health overview                                                                 |
| `relayfile mount <workspace> <local-dir>`                                                           | Restart the daemon                                                              |
| `relayfile stop <workspace>`                                                                        | Stop the daemon                                                                 |
| `relayfile integration available [--search <q>] [--backend <nango\|composio>] [--json] [--refresh]` | Browse the live provider catalog                                                |
| `relayfile integration search <q> [--backend <nango\|composio>] [--json] [--refresh]`               | Search dynamic Nango providers and Composio toolkits                            |
| `relayfile integration list --workspace <name> --json`                                              | List connected providers                                                        |
| `relayfile integration connect <provider> [--backend <nango\|composio>] --workspace <name>`         | Add another provider                                                            |
| `relayfile integration set-metadata <provider> KEY=VALUE... --workspace <name> --yes`               | Replace flat provider metadata, such as Jira/Confluence `cloudId` and `baseUrl` |
| `relayfile integration disconnect <provider> --workspace <name> --yes`                              | Remove a provider                                                               |
| `relayfile tree <workspace> <path>`                                                                 | Live cloud-side directory listing                                               |
| `relayfile read <workspace> <path>`                                                                 | Live cloud-side file read                                                       |
| `relayfile writeback status <workspace> [--json]`                                                   | Pending / failed / dead-lettered counts                                         |
| `relayfile writeback retry --opId <op> <workspace>`                                                 | Re-enqueue a dead-lettered op                                                   |
| `relayfile pull --workspace <name>`                                                                 | Force a refresh from provider                                                   |
| `relayfile ops list --workspace <name> --json`                                                      | Cloud-side operation log                                                        |
| `relayfile workspace delete <name> --yes`                                                           | Remove from local registry                                                      |
