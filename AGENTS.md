# Git Workflow Rules

## NEVER Push Directly to Main

**CRITICAL: Agents must NEVER push directly to the main branch.**

- Always work on a feature branch
- Commit and push to the feature branch only
- Let the user decide when to merge to main
- Do not merge to main without explicit user approval

```bash
# CORRECT workflow
git checkout -b feature/my-feature
# ... do work ...
git add .
git commit -m "My changes"
git push origin feature/my-feature
# STOP HERE - let user merge

# WRONG - never do this
git checkout main
git merge feature/my-feature
git push origin main  # NO!
```

This ensures the user maintains control over what goes into the main branch.

## Changelog

Curate `[Unreleased]` in `CHANGELOG.md` as you land PRs. The root changelog is
the cross-package, user-facing release narrative for Relay. It follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and Semantic
Versioning.

An empty post-release changelog starts with `[Unreleased]`. The first pending
user-visible change must set the heading to `[Unreleased - Patch]`,
`[Unreleased - Minor]`, or `[Unreleased - Major]` according to its SemVer
impact. The pending release level is monotonic (`Patch < Minor < Major`):
raise the heading when a higher-impact change arrives; never lower it for a
later lower-impact change, and leave it unchanged for another change at the
same level. When a release is cut, move the pending entries under the released
version and restore an empty `[Unreleased]` heading with no release level.

Changelog entries should be concise and impact-first. Prefer one short bullet
per user-visible change: name the command, API, schema, or package touched and
the practical effect. Drop issue/PR links, internal review notes,
implementation backstory, release-only entries, and "foundation for..." phrasing
unless that text clearly explains the shipped impact.

Use Keep a Changelog sections (`Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, `Security`), plus `Breaking Changes` and `Migration Guidance` when a
SemVer-major change needs explicit callouts. Do not use generated perspective
sections such as "Product Perspective", "Technical Perspective", or "Releases".
Do not add web-only changes to the changelog. Omit unpublished or withdrawn
versions as release headings; move their shipped user-visible changes into the
corrected published release.

Do not add `relay-feature-guardian` changes to the changelog. It is an internal
Slack feature-check agent (`.agentworkforce/agents/relay-feature-guardian/`),
not a user-facing Relay surface, so its fixes never belong in the release
narrative. The release workflow also skips these commits automatically.

## .trajectories Must Be Tracked

**CRITICAL: Never add `.agentworkforce/trajectories/` to `.gitignore`.**

The `.agentworkforce/trajectories/` directory must remain tracked in git. It contains trajectory records from the `trail` tool that provide valuable context for future agents and humans about past decisions, reasoning, and work history.

<!-- prpm:snippet:start @agent-workforce/trail-snippet@1.1.2 -->

# Trail

Record your work as a trajectory for future agents and humans to follow.

## Usage

If `trail` is installed globally, run commands directly:

```bash
trail start "Task description"
```

If not globally installed, use npx to run from local installation:

```bash
npx --yes agent-trajectories start "Task description"
```

## When Starting Work

Start a trajectory when beginning a task:

```bash
trail start "Implement user authentication"
```

With external task reference:

```bash
trail start "Fix login bug" --task "ENG-123"
```

## Recording Decisions

Record key decisions as you work:

```bash
trail decision "Chose JWT over sessions" \
  --reasoning "Stateless scaling requirements"
```

For minor decisions, reasoning is optional:

```bash
trail decision "Used existing auth middleware"
```

**Record decisions when you:**

- Choose between alternatives
- Make architectural trade-offs
- Decide on an approach after investigation

## Recording Reflections

Periodically step back and synthesize progress:

```bash
trail reflect "Workers aligned on auth approach, API layer progressing well" \
  --confidence 0.8
```

With focal points and adjustments:

```bash
trail reflect "Frontend and backend duplicating validation logic" \
  --focal-points "duplication,ownership" \
  --adjustments "Reassigning validation to backend team" \
  --confidence 0.7
```

**Record reflections when you:**

- Have received several updates and need to synthesize the big picture
- Notice workers or tasks diverging from the plan
- Want to course-correct before continuing
- Are coordinating multiple agents and need to assess overall progress

Reflections differ from decisions: decisions record a specific choice,
reflections record a higher-level synthesis of what's happening and whether
the current approach is working.

## Completing Work

When done, complete with a retrospective:

```bash
trail complete --summary "Added JWT auth with refresh tokens" --confidence 0.85
```

After completing work, compact the finished trajectory or merged PR into a
durable summary. When the compacted summary is sufficient, discard the raw
source trajectories so `.trajectories/index.json` and list output stay focused:

```bash
trail compact --discard-sources
# or after a PR merge:
trail compact --pr 42 --discard-sources
```

`--discard-sources` removes the source trajectory JSON/Markdown/trace files and
updates the index. Use it after confirming the compacted artifact is the record
you want to keep.

**Confidence levels:**

- 0.9+ : High confidence, well-tested
- 0.7-0.9 : Good confidence, standard implementation
- 0.5-0.7 : Some uncertainty, edge cases possible
- <0.5 : Significant uncertainty, needs review

## Abandoning Work

If you need to stop without completing:

```bash
trail abandon --reason "Blocked by missing API credentials"
```

## Checking Status

View current trajectory:

```bash
trail status
```

## Listing and Viewing Trajectories

List all trajectories:

```bash
trail list
```

View a specific trajectory:

```bash
trail show <trajectory-id>
```

Export a trajectory (markdown, json, timeline, html):

```bash
trail export <trajectory-id> --format markdown
```

## Compacting Trajectories

After a PR merge, compact related trajectories into a single summary and prune
raw source trajectories when the summary should replace them:

```bash
trail compact --pr 42 --discard-sources
```

Compact by branch (finds trajectories with commits not in the specified base branch):

```bash
trail compact --branch main --discard-sources
```

Compact by specific commits:

```bash
trail compact --commits abc123,def456 --discard-sources
```

Compaction consolidates decisions and creates a grouped summary. Adding
`--discard-sources` makes the compacted artifact the durable record by removing
the raw trajectories and their index entries.

## Why Trail?

Your trajectory helps others understand:

- **What** you built (commits show this)
- **Why** you built it this way (trajectory shows this)
- **What alternatives** you considered
- **What challenges** you faced

Future agents can query past trajectories to learn from your decisions.

<!-- prpm:snippet:end @agent-workforce/trail-snippet@1.1.2 -->

# Relayflows

Journal-backed flows for the `flows` CLI (`@relayflows/sdk` 2.x). Every v1
`@relayflows/core` `WorkflowBuilder` flow has been migrated; `workflows/` is
gone.

| Source                                 | Flow name                      | Entry point                      |
| -------------------------------------- | ------------------------------ | -------------------------------- |
| `flows/ci/pr-proof.flow.ts`            | `relay.ci.pr-proof`            | `flows deploy` (hosted listener) |
| `flows/verify/fleet-daytona.spec.ts`   | `relay.verify.fleet-daytona`   | `npm run verify:fleet-daytona`   |
| `flows/verify/cleanroom.spec.ts`       | `relay.verify.cleanroom`       | `npm run verify:cleanroom`       |
| `flows/verify/features.spec.ts`        | `relay.verify.features`        | `npm run verify:features`        |
| `flows/diagnose/orchestration.spec.ts` | `relay.diagnose.orchestration` | `npm run diagnose:orchestration` |
| `flows/audit/feature-manifest.spec.ts` | `relay.audit.feature-manifest` | `npm run audit:feature-manifest` |

`tests/relayflows/cleanroom/` drives `flows/verify/cleanroom.spec.ts`; its
README still names the deleted `workflows/verify-cleanroom.ts`.

Each flow has a matching `:check` script that generates its spec and runs
`flows check` on it. That is the v2 replacement for v1's `DRY_RUN=1`: it
validates the graph without executing it. v2 has no dry-run execution mode.

## Naming

Flow names are dot-namespaced as `relay.<domain>.<name>`, mirroring the
directory under `flows/`. Dots rather than slashes is a constraint, not a
preference: `flows build` seals a bundle as `<name>@sha256:<digest>` and
validates the name against `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, so a
`relay/ci/pr-proof` name cannot be built or deployed at all.

Deterministic steps cannot be named in TypeScript. `f.run(...)` has no id
parameter, so the journal labels them positionally (`run-1`, `run-2`, …) in
source order. Only `f.agent(name, …)` carries a name through — so name those
well, and keep a comment above each `f.run` saying what it is.

## Why most flows are generated specs, not `.flow.ts`

Only `pr-proof` is authored directly against `@relayflows/surface`. The others
emit a v2 `FlowSpec` as JSON, because three things they depend on are reachable
only from the data dialect:

1. **Steps longer than 15 minutes.** `f.run`'s `timeout` is capped at 15
   minutes (`compile.ts`, `lease_exceeded`), and the cap is enforced at run —
   `flows check` does not catch it. A spec's `timeoutMs` is uncapped.
2. **Agent `permissions`.** `AgentOptions` has no permissions field;
   `AgentStepSpec` does.
3. **Named deterministic steps.** The v1 names are the vocabulary the runners,
   their evidence, and the tests already use.

The hybrid that would have avoided this — `use:` plus `f.dispatch` — is
accepted by `flows check` and then refused at run (`unsupported_header: use`).

`flows/spec-builder.ts` holds the v1-to-v2 translation, so the flows that were
mostly large shell bodies keep their authoring calls byte-identical and only
what they build changed. Put new translation decisions there, not in a flow.

Lifecycle that wrapped `wf.run()` lives in a runner now, because a generated
spec is executed by the `flows` CLI: `flows/verify/run-features.ts` and
`flows/audit/run-feature-manifest.mjs` own their prepare/verdict/cleanup
brackets and their 0/1/2 exit codes, which answer "did verification pass"
rather than "did the run succeed".

## OpenCode needs the adapter

v2 runs only raw Claude/Codex executables; anything else is refused as
`cli_unsupported` unless it identifies with the `relayflows-agent-cli-v1`
contract. `scripts/flows/opencode-agent-cli.mjs` implements that contract, and
every OpenCode agent points at it. Do not resubstitute Claude for an OpenCode
reviewer — a third-party model reviewing Relay's own evidence is the property
those steps exist to test.

It requires `opencode auth login`: v2 spawns adapters with a closed environment
allowlist (PATH, HOME, TMPDIR, …), so an ambient `OPENCODE_API_KEY` never
crosses and the credential must be on disk under HOME.

## What v1 features do not survive the port

| v1 feature                            | v2 status                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------- | --- | ------------------------------------ |
| `.timeout(ms)`                        | `budget.maxWallclockMs` on a spec; `{ budget: { wallclock } }` header in TS     |
| `retries: n`                          | `maxIterations: n + 1` on a spec step; no TypeScript knob                       |
| `timeoutMs` on an agent step          | No equivalent — bounded only by the flow budget and worker lease                |
| `failOnError: false`                  | `<command>                                                                      |     | true`; a later explicit gate decides |
| `verification: file_exists`           | The `artifact_exists` named gate                                                |
| `verification: exit_code` on an agent | A `subprocess_gate` stating the check it implied                                |
| `permissions`                         | Spec steps only, and coarser: no read/write split, deny list, or exec allowlist |
| `.onError(...)`                       | Default and only behaviour: a failed step fails the run                         |
| `.maxConcurrency(n)`                  | Nothing; the kernel schedules the DAG                                           |
| `.pattern('dag'\|'pipeline')`         | Nothing; `dependsOn` is the only ordering                                       |
| `.channel(...)` (relaycast)           | No equivalent                                                                   |
| `.idleNudge(...)`                     | No equivalent                                                                   |
| `preset` / `role` / `interactive`     | No equivalent                                                                   |
| `repoReads`                           | No equivalent                                                                   |

Because `permissions` lost its read/write split and deny list, the runners' own
seals and write-once provenance captures — not the sandbox policy — remain what
prove evidence was not mutated. One behavioural change to know about: a crashed
cleanroom lane agent now fails the run instead of being judged by `gate-<lane>`,
since v2 has no `failOnError: false` for agent steps.

## Deploying pr-proof

```sh
flows deploy flows/ci/pr-proof.flow.ts \
  --repo AgentWorkforce/relay \
  --on github:events=pull_request \
  --approver <github-handle> \
  --agents claude

flows deployments          # list hosted listeners
flows undeploy <id>        # remove one
```

There is no webhook to register: the GitHub App installation is the ingress,
and each matching pull request launches a run with `{ approver, issue, event }`
as input, in a fresh branch of the repository.

## Resident lead

The resident `relay` agent is this repo's lead. Reports to **chief**
(Will → chief → relay; no engineering department is seated yet). One
writer: the resident is sole writer of this repo while online; delegates
use worktrees off origin/main (others — including Khaliq and bots — work
this repo in parallel). Session start: this file, `git log --oneline -15`,
relay inbox. ACK / progress / DONE with evidence on every assignment.
Publishing (npm, crates, GitHub releases) is gated on chief green-light.

### Standing board (2026-07-29 — delete entries as they close)

- Telemetry identity-leak cluster: merged as PR #1363; CLI stayed 11.2.0
  (no release cut yet — release-train needs chief green-light).
- Secrets fix train (issue #1379): PR A = #1380 (CLI output/error masking,
  key off argv) + required companion relayfile#380 which must merge and
  release FIRST (relayfile scrapes raw secrets from CLI output and error
  text). PR B (Rust file modes) and PR C (--mcp-config argv→file; must
  also update .claude/rules/mcp-injection.md) are unstarted — full spec
  in #1379. #1380 unblocks the fleet-wide credential rotation.
- Open issue batch: #1378 (fresh `node up` silently mints a workspace),
  #1381 (teams.json per-agent model pinning gap; `claude:opus` doc syntax
  is dead), #1382 (attach pairs broker URL/key from different sources;
  delete chief's orgchart env-unset workaround when fixed), #1383
  (non-Error rejections render as `[object Object]`).
- Also pending: 64 dependabot alerts on main (1 critical); skills repo
relay-team/relay-pipeline/relay-fanout SKILL.mds still instruct printing
raw observer URLs — unsatisfiable once #1380 lands.
<!-- PRPM_MANIFEST_START -->

<skills_system priority="1">
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills (loaded into main context):

- Use the <path> from the skill entry below
- Invoke: Bash("cat <path>")
- The skill content will load into your current context
- Example: Bash("cat .openskills/backend-architect/SKILL.md")

Usage notes:

- Skills share your context window
- Do not invoke a skill that is already loaded in your context
  </usage>

<available_skills>

<skill activation="lazy">
<name>writing-relayflows</name>
<description>Use when authoring a Relayflows flow (@relayflows/surface / @relayflows/sdk, the v2 journal-based engine, CLI `flows`) in TypeScript or YAML/JSON. Covers the run/llm/agent ladder, human/dispatch/done, verification gates, cli/model resolution, flows.json, and flows check/run/resume refusal shapes. Not for the older @relayflows/core WorkflowBuilder (chained .pattern(&apos;dag&apos;)/.agent()/.step() calls) — see writing-agent-relay-workflows / migrating-persona-to-relayflow instead.</description>
<path>.openskills/writing-relayflows/SKILL.md</path>
</skill>

</available_skills>
</skills_system>

<!-- PRPM_MANIFEST_END -->
