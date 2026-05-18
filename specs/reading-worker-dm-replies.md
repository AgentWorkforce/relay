# Reading Worker DM Replies — Design Spec

**Status**: Draft
**Date**: 2026-05-15
**Issue**: [#860 — Headless Orchestrator Friction Report](https://github.com/AgentWorkforce/relay/issues/860)
**Related**: `src/cli/commands/messaging.ts`, `.claude/skills/running-headless-orchestrator/SKILL.md`

---

## 1. Problem

A headless orchestrator can spawn workers and send them tasks, but **cannot easily read what the workers said back**. The core loop works (`spawn → send → file written`); the introspection loop is broken.

Concretely, after `agent-relay send Worker2 "..."`:

| Command tried                              | What it returned                                    | What the user needed                                                 |
| ------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------- |
| `agent-relay inbox --agent Worker2`        | `relay: 1` (count only)                             | The text of Worker2's reply                                          |
| `agent-relay history --to Worker2`         | 60-char preview of one message per conversation     | The full reply, multiple messages, with timestamps                   |
| `agent-relay inbox --agent Worker2 --json` | `from: "relay"`, `last_message: "Create a file..."` | The _worker's_ reply, not the orchestrator's outbound DM echoed back |

Root causes, located in code:

1. **`inbox` text renderer drops content** — `src/cli/commands/messaging.ts:862-868` prints `${dm.from}: ${dm.unreadCount}` and nothing else. The `last_message` field is populated in the JSON path (`:814-820`) but never rendered in human output.
2. **`history --to <agent>` is conversation-summary mode, not message mode** — `:683-703` lists conversations with a 60-char preview (`:700`). To see messages, the user must also pass `--from <other-side>`, which is undocumented in `--help` and non-obvious.
3. **The orchestrator's outbound DM appears as `from: "relay"`** — `:436` hard-codes `senderName = options.from?.trim() || 'relay'`. The literal string `relay` is also a brand name and an entity name, so the JSON payload looks like the _broker_ sent the message. The reply (from Worker2) and the outbound DM (from "relay") sit in the same conversation, and the inbox renderer surfaces _the most recent message regardless of direction_ as `last_message`, which is almost always the orchestrator's own message that triggered the worker.
4. **No single command answers "what did Worker2 say to me?"** — the user must combine `--to Worker2 --from <self>` and know the conventional sender name, which is itself ambiguous.

A secondary friction (worker didn't appear in `who` immediately after spawn) is acknowledged but addressed separately; see §8.

## 2. Desired end state

After this work, an orchestrator running headlessly can answer **"what did Worker2 say?"** with one command and get full, untruncated, sender-attributed message text:

```text
$ agent-relay replies Worker2
[2026-05-15T15:31:02Z] Worker2: Done. Created result.json with {"status":"success","worker":"claude"}.
[2026-05-15T15:30:55Z] Worker2: Working on it now.
```

And the JSON form returns structured records, never echoing the orchestrator's own outbound message as the headline:

```json
[
  { "from": "Worker2", "text": "Done. Created result.json...", "createdAt": "...", "unread": true },
  { "from": "Worker2", "text": "Working on it now.", "createdAt": "...", "unread": false }
]
```

The existing `inbox`, `history`, and `send` commands keep working but become consistent and self-explanatory:

- `agent-relay inbox --agent Worker2` shows **message content**, not counts.
- `agent-relay history --to Worker2` shows **messages**, not a conversation summary, with no truncation by default.
- The orchestrator's outbound DMs are tagged with a clear sender name (`orchestrator` by default, configurable) and a clear `direction` field, so callers can filter trivially.
- The running-headless-orchestrator skill documents one canonical recipe per question ("How do I read replies?", "How do I detect completion?").

## 3. Scope

### In scope

- A new `agent-relay replies <agent>` command (single-purpose: read inbound messages addressed to the orchestrator from a given worker).
- Behavior changes to `inbox` and `history` for messages and content rendering.
- A sender-name change for `agent-relay send` (default `orchestrator`, not `relay`), with backwards-compatible env var to opt out.
- A `direction` field on returned DM records (`inbound` | `outbound`) relative to the registered agent of the call.
- Skill updates so the canonical recipe is one command, not three.

### Out of scope

- Bidirectional streaming / `tail -f` semantics for DMs. (Polling + `replies --since` is sufficient and matches existing patterns.)
- Reworking the broker's DM storage layer.
- Fixing the `who` race after spawn (tracked separately; see §8).
- Changing the broker's global read-tracking semantics. The existing
  auto-read-on-inbox behavior is preserved unchanged. (The `replies
--mark-read` flag is in scope, but it is an explicit, command-local
  acknowledgement only — it does not alter the default semantics other
  commands rely on.)

## 4. CLI surface

### 4.1 New: `agent-relay replies <agent>`

```text
agent-relay replies <agent> [options]

Show messages received from <agent> in the DM conversation between the
orchestrator and that agent. Returns inbound messages only — never echoes
the orchestrator's own outbound DMs.

Options:
  -n, --limit <count>      Number of messages to show (default: 50)
  --since <time>           Only messages after time (e.g. "5m", "1h", ISO-8601)
  --unread                 Only unread messages (does NOT mark them read)
  --mark-read              After printing, mark the printed messages as read
  --as <name>              Read as this orchestrator identity (default:
                           $AGENT_RELAY_ORCHESTRATOR_NAME or "orchestrator")
  --json                   Output as JSON
  --full                   Disable any truncation (default: full text is shown
                           in both text and JSON; this flag is a no-op kept for
                           forward compatibility)
```

Behavior:

- Resolves the DM conversation between `--as` and `<agent>` (creating none — if no conversation exists, prints `No DM conversation with <agent>.` and exits 0).
- Lists messages where `sender == <agent>`, in chronological order (oldest first), newest at the bottom — matches how a terminal user reads a transcript.
- **No text truncation.** Multi-line messages are printed verbatim, indented two spaces under a header line: `[<iso-ts>] <agent>:`.
- Exit code: 0 if any messages printed or none found; 1 only on connection / auth failure.

### 4.2 Changed: `agent-relay inbox --agent <name>`

The text renderer for `Unread DMs` changes from a count line to a content block. The JSON shape is unchanged (already includes `last_message`); only the text path is updated.

Before:

```text
Unread DMs:
  relay: 1
```

After:

```text
Unread DMs:
  Worker2 → orchestrator (3 unread):
    [2026-05-15T15:31:02Z] Worker2: Done. Created result.json...
    [2026-05-15T15:30:55Z] Worker2: Working on it now.
    [2026-05-15T15:30:40Z] Worker2: Got it.
```

Rules:

- Show **up to 3 most recent unread messages per conversation**, full text (no `...`).
- If the conversation has more than 3 unread messages, append `… (N more — run \`agent-relay replies <agent> --unread\` to see all)` as the last line of that block.
- The header line uses `<sender> → <reader>` so the user always knows who said what. The sender is the actual message sender, never a synthesized "relay" string.

### 4.3 Changed: `agent-relay history --to <agent>` (when `<agent>` is not a channel)

Today this command has two behaviors split by whether `--from` is also passed (`:648-703`). After this work it has **one** behavior: print messages in the conversation, newest at the bottom, no truncation.

```text
$ agent-relay history --to Worker2
[2026-05-15T15:29:10Z] orchestrator: Create a file called result.json...
[2026-05-15T15:30:40Z] Worker2: Got it.
[2026-05-15T15:30:55Z] Worker2: Working on it now.
[2026-05-15T15:31:02Z] Worker2: Done. Created result.json...
```

Rules:

- Default `--limit` stays at 50.
- `--from <agent>` continues to filter by sender (so `history --to Worker2 --from Worker2` is equivalent to `replies Worker2` for the no-`--unread` case).
- `--json` output gains a `direction` field per message: `"inbound"` if `sender == <agent>`, `"outbound"` otherwise (where "otherwise" means the orchestrator's own sends echoed into the conversation). Existing fields are preserved.
- The conversation-summary mode is removed. To list all conversations for an agent, use `agent-relay dms list --as <agent>` (existing — see `mcp__relaycast__message_dm_list` and its CLI mirror).

### 4.4 Changed: `agent-relay send` default sender

`:436` changes from:

```ts
const senderName = options.from?.trim() || 'relay';
```

to:

```ts
const senderName =
  options.from?.trim() || process.env.AGENT_RELAY_ORCHESTRATOR_NAME?.trim() || 'orchestrator';
```

The `--from` flag's help text is updated:

```text
--from <name>   Sender name (registered identity in relaycast).
                Default: $AGENT_RELAY_ORCHESTRATOR_NAME or "orchestrator".
                Used so workers' replies are addressed to a stable name
                you can read with `agent-relay replies <worker>`.
```

This is a **user-visible default change**. Existing scripts that filter on the literal string `"relay"` will break. That is desired — `"relay"` was a footgun. Release notes must call this out. No silent migration; users who want the old behavior set `--from relay` or export `AGENT_RELAY_ORCHESTRATOR_NAME=relay`.

### 4.5 New JSON field: `direction`

On every DM message record returned by `replies`, `history --to <agent>`, and `inbox --json`'s `unread_dms[].last_message`, add:

```jsonc
{
  "direction": "inbound" | "outbound",
  // existing fields unchanged
}
```

`inbound`/`outbound` is computed relative to the _reader identity_ of the call (the `--as` agent or, for `inbox`, the `--agent` agent). This makes filtering trivial and unambiguous, regardless of what name the orchestrator chose for `--from`.

## 5. Skill updates

`.claude/skills/running-headless-orchestrator/SKILL.md` must change such that the canonical answer to "How do I read worker replies?" is:

```text
agent-relay replies <worker>
```

Required edits:

- Replace the lookup-table rows for "Read worker's unread DM replies" and "Read full DM conversation history" with a single row pointing at `agent-relay replies <agent>`.
- The "Channel vs DM" section keeps its explanation but its examples switch to `replies`.
- The "Critical: `history` only shows channel messages" caveat is removed (no longer true after §4.3).
- Add a "Detecting task completion" subsection with a worked example using `agent-relay replies <worker> --since 30s` in a polling loop, terminating when a worker message matches a configurable pattern (default: case-insensitive `done|completed|finished|failed`). Provide the loop as a copy-pasteable bash snippet; do not introduce a new CLI subcommand for this.
- Update the MCP examples to use `mcp__relaycast__message_dm_list` with `as: "<worker>"` as the equivalent path, and call out that the MCP tool returns full content.

## 6. Tests

### 6.1 Unit & integration tests

Located in `src/cli/commands/messaging.test.ts` (existing) and a new `replies.test.ts`:

- `replies` returns only inbound messages, verified against a seeded conversation with mixed-direction messages.
- `replies --unread` filters by unread flag and does **not** flip read state.
- `replies --mark-read` flips read state for printed messages and the next `replies --unread` is empty.
- `replies` exits 0 with `No DM conversation with <agent>.` when no conversation exists.
- `replies --since 1h` filters by parsed duration; reuses `parseSince` already in the file.
- `inbox` text output renders up to 3 unread messages per conversation full-text, and the truncation footer appears when N > 3.
- `inbox --json` changes are strictly additive: every pre-existing key keeps its
  prior value and position, and the only difference is a new
  `unread_dms[].last_message.direction` field. Callers that ignore unknown keys
  are unaffected; no field is renamed, removed, or retyped.
- `history --to <agent>` returns messages, not conversation summary, when `<agent>` is non-channel.
- `send` without `--from` sends as `orchestrator` (verified by reading back via `replies`).
- `send` honors `AGENT_RELAY_ORCHESTRATOR_NAME` env var when `--from` is omitted.

The friction transcript from issue #860 is captured as an integration test fixture (`tests/fixtures/issue-860-transcript.test.ts`) that replays the exact command sequence the reporter ran and asserts the new outputs are useful.

### 6.2 End-to-end CLI validation (required before merge)

Automated tests alone are not sufficient. The implementer **must** run the locally-built CLI against a live broker and reproduce the issue #860 scenario end-to-end. This catches packaging, binary-resolution, and integration regressions that unit tests miss.

Required steps, run from a clean working tree on the feature branch:

1. **Build the local CLI from source.** Use `pnpm build` (or the equivalent monorepo build) so `agent-relay` resolves to the branch's compiled output, not a globally installed version. Confirm with `which agent-relay` and `agent-relay --version` — the version must match the bumped value from §7.
2. **Start a fresh broker.** `agent-relay up` in a scratch project directory; verify `agent-relay status` reports healthy. Do not reuse a long-running broker — state from prior runs masks bugs.
3. **Replay the issue #860 transcript verbatim.** Spawn two workers (one `codex`, one `claude`), send each a DM that asks them to write a file, then exercise every command in §4:
   - `agent-relay replies Worker2` — prints full inbound text, no truncation, sender is `Worker2`.
   - `agent-relay replies Worker2 --unread` — prints only unread, does not mark read.
   - `agent-relay replies Worker2 --since 30s --json` — JSON includes the new `direction` field with value `inbound` for worker messages.
   - `agent-relay inbox --agent Worker2` — renders message content (up to 3 per conversation), not counts. Run this **before** `--mark-read` so unread rendering is exercised against still-unread messages.
   - `agent-relay inbox --agent Worker2 --json` — `unread_dms[].last_message` carries the worker's text; `from` is the worker's name, not `"relay"`.
   - `agent-relay replies Worker2 --mark-read` — run **after** the inbox checks above; prints + marks read; a follow-up `--unread` call returns empty.
   - `agent-relay history --to Worker2` — chronological messages, no 60-char preview, outbound sender is `orchestrator`.
   - `agent-relay send Worker2 "ping"` with no `--from` — Worker2's subsequent `replies` view shows the outbound was attributed to `orchestrator`.
   - `AGENT_RELAY_ORCHESTRATOR_NAME=ops agent-relay send Worker2 "ping"` — outbound attributed to `ops`.
4. **Run the polling-loop snippet from the updated skill.** Confirm it terminates correctly when a worker emits `done`/`completed` and that it does not false-positive on the orchestrator's own outbound DMs (this is the failure mode the `direction` field is designed to prevent).
5. **Tear down and rerun on a second harness.** Validate at least one of: a `claude`-spawned worker _and_ a `codex`-spawned worker, since the reporter hit asymmetric behavior between them.
6. **Capture evidence.** Paste the live terminal transcript (commands + outputs) into the PR description under a `## E2E validation` heading. A green CI run is not a substitute — the PR must show the actual command outputs from a local broker. If any output diverges from §2 ("Desired end state") or §4 ("CLI surface"), the work is not done.

The PR description must explicitly answer: "Did you run the local CLI end-to-end against a live broker?" with a transcript. Reviewers should reject PRs that skip this section.

## 7. Migration & release

- Bump minor version (`6.1.0`) — default sender name change is user-visible.
- CHANGELOG entry under "Breaking" calls out:
  - Default `send --from` is now `orchestrator`, not `relay`. Set `AGENT_RELAY_ORCHESTRATOR_NAME=relay` to restore old behavior.
  - `history --to <agent>` no longer shows conversation summaries; use `agent-relay dms list --as <agent>` instead.
- CHANGELOG entry under "Added": `agent-relay replies`, `direction` field on DM JSON.
- CHANGELOG entry under "Changed": `inbox` text renderer shows DM content.
- Docs sync: any docs that mention `relay` as the default sender or describe `inbox` count-only output must be updated in both `web/content/docs/*.mdx` and `docs/*.md` (per `.claude/rules/docs-sync.md`).

## 8. Out-of-band: `who` race after spawn

The reporter noted Worker1 (codex) did not appear in `who` immediately after spawn. This is a separate defect — likely a registration race between the codex injector and the broker's agent table — and is **not** addressed by this spec. File as a follow-up issue and link from #860; do not bundle the fix here.

## 9. Acceptance

This spec is complete when an orchestrator can run the exact command sequence from issue #860, and:

- `agent-relay replies Worker2` prints Worker2's full reply text with sender attribution.
- `agent-relay inbox --agent Worker2` prints content, not counts.
- `agent-relay history --to Worker2` prints messages, not a conversation summary, and the orchestrator's outbound DMs are clearly attributed to `orchestrator` (or the configured name), not `relay`.
- The running-headless-orchestrator skill's "read worker replies" guidance is one command, not three.
- All tests in §6.1 pass.
- §6.2 end-to-end validation has been performed against a locally-built CLI and a live broker, and the transcript is pasted into the PR description.
- CHANGELOG and docs are updated, and the `.mdx`/`.md` mirror invariant from `.claude/rules/docs-sync.md` holds.

## 10. Addendum: channel history & structured `who` (issue #860 follow-on)

The original spec scoped the no-truncation fix to **DM** history only (§4.3,
"when `<agent>` is not a channel"). Field use surfaced that the same friction
applies to channel reads and to agent health, so this work additionally:

- **Channel history is no longer truncated.** `agent-relay history --to '#<channel>'`
  prints full message text (multi-line messages render under an indented
  header), matching the DM transcript behavior. Substantive payloads (literal
  diffs, grep counts, GO/NO-GO reasoning) are readable in full instead of cut
  at ~200 chars.
- **Channel history is chronological.** Messages are sorted oldest→newest and
  the most recent `--limit` are kept, so a reader reconstructs the
  conversation top-to-bottom without cross-referencing. The relaycast feed
  order is no longer trusted; an explicit sort prevents interleaving. The
  `--from` cross-context history view is de-truncated the same way.
- **`agent-relay who` reports real lifecycle, not placeholders.** The previous
  output fabricated `status: "ONLINE"` and `lastSeen: <now>`. `who` now joins
  the broker `/api/metrics` data so `who --json` emits structured, pollable
  records: `{ name, cli, status, pid, uptimeSecs, memoryBytes }`. This gives a
  headless orchestrator a machine-readable health signal instead of scraping
  the worker TTY. (Idle/exited/restart event-state and an in-TUI context-budget
  figure remain out of scope — they require a follow-up broker change; `who`
  does not synthesize values it cannot observe.)
- **Skill guidance.** `running-headless-orchestrator` (canonical copy plus the
  `.claude`/`.agents` mirrors) now states that the spawning orchestrator is not
  a registered relaycast agent — `mcp__relaycast__message_*` tools fail with
  `Not registered. Call agent.register first.` — so the CLI is the supported
  path, and `--json` is the recommended way to read full, untruncated,
  parseable output (`replies`, `history`, `inbox`, `who`).
