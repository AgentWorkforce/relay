# Relay orchestration reliability diagnosis and repair prompt

You are the lead reliability engineer for Agent Relay's multi-agent orchestration stack. Diagnose and fix the failures below across these sibling repositories:

- `relay` (start here)
- `../cloud`
- `../relayfile` only when the root cause crosses the mount/sync boundary

The objective is not to make unit tests green. The objective is to prove, from clean Daytona sandboxes, that Cloud workflow scheduling, fleet sandbox provisioning, Relayfile mounting, MCP/message injection, agent release, and sandbox reclamation work together without flakes or orphaned resources.

## Safety and repository rules

1. Read every applicable `AGENTS.md` before changing a repository. Run the repository discovery/checkpoint tooling it requires when available.
2. Work from `origin/main` in isolated feature branches/worktrees. Never push directly to `main`. Push feature branches and open PRs. Merge only through a PR after the exact baseline fails, the checkout-packed candidate is installed in clean sandboxes and passes, normal CI is green, two fresh independent reviewers sign off, and the repository-required Veto diff review is GREEN. If any gate is unavailable or inconclusive, leave the PR open. Publishing a package, deploying Cloud, rotating credentials, or creating a release still requires explicit human approval.
3. Preserve unrelated dirty changes. Keep changes in the repository that owns the behavior; use companion branches when a contract must change in more than one repository.
4. Never print tokens, API keys, Relay workspace credentials, or child-process environments. Redact logs before retaining evidence.
5. Name and label every sandbox created by this investigation. Record the Daytona inventory and CPU baseline before the run. Delete only investigation-owned sandboxes, and prove the ending resource count returns to baseline.
6. Use cheap agents for bounded implementation and test work. Keep one lead responsible for the cross-repository state machine, evidence, and cleanup. Independent signoff agents must not share the implementer's context.
7. A skip, missing toolchain, timeout, OOM, generic HTTP 500, or unknown provisioning outcome is not a pass.

## Reproduced baseline (2026-09-04)

Relay checkout: `e87f186938d125811c74341d4371f4f021115b01`

Cloud checkout: `e21fab7a7e8a30411ab323c26a0c56fa2a6b60ba`

Daytona snapshot: `relay-orchestrator-sdk-11.8.2-relayfile-v0.10.50-runtime-4.1.52`

Daytona CLI/API reported a version mismatch: CLI `0.205.1`, API `0.210.0`.

### Exhaustive Relay Fleet board

Do not replace the evidence below with a smaller smoke test. The repeatable
Relay-only board is defined by:

- `tests/relayflows/cleanroom/fleet-daytona.matrix.json` (95 operations);
- `scripts/verify-features/fleet-daytona.mjs` (operator-host runner, evidence,
  cleanup, and campaign aggregation);
- `workflows/verify-fleet-daytona.ts` (supervision and independent signoff);
- `tests/fixtures/verify-fleet-daytona.test.ts` (static safety and coverage
  contracts).

Run `npm run verify:fleet-daytona:validate` and
`npm run verify:fleet-daytona:dry-run` before live work. A live attempt is
`npm run verify:fleet-daytona`; aggregate at least two completed attempts with:

```bash
node scripts/verify-features/fleet-daytona.mjs aggregate \
  --nonce <campaign-nonce> \
  --attempts <attempt-1-nonce>,<attempt-2-nonce>
```

The exploratory aggregate `relayfull-campaign-0904` reported RED: 37 apparent
stable passes, 33 stable failures, 20 mixed operations, and three incomplete
workspace-policy mutations. The attempt totals were 48 pass / 41 fail / 1
blocked / 3 safety-skipped and 45 pass / 41 fail / 4 blocked / 3
safety-skipped. These numbers describe the retained artifacts, not a controlled
reliability result. Both attempts were sealed individually, but they used
different runner hashes, dirty source trees, an already crowded shared Relay
workspace, and Relay 11.8.2 node images while the matrix required 11.10.2. The
current hardened aggregator must reject that pair. Both `node-tail-agent`
records were also false positives: they timed out with empty broker stdout and
only a Daytona version warning on stderr. Do not quote “37 stable passes” as a
current product or verifier claim.

#### Clean qualification blockers reproduced on 2026-09-05

A new checkout-built 95-operation board (`fleetdiag-20260905-a1`) stopped at
the baseline after exactly 60 seconds. `agent list` subsequently succeeded in
about seven seconds but emitted roughly 2.8 MB for approximately four thousand
historical identities. The old runner retained only the tail of bounded output
without recording truncation; its permissive JSON walker could therefore
interpret malformed/truncated JSON as an empty set. This is an evidence
integrity bug. Qualification must fail on truncated or malformed JSON, use
`agent list --status online` only for the live clean-state assertion, and use
bounded exact `agent get <name>` queries for nonce-derived ownership and
cleanup. Never hash or preserve an entire ambient historical identity roster.

There is no supported automation-safe lifecycle for the disposable canonical
Cloud workspace required by the board:

- `agent-relay workspace create` creates a Relaycast-only `rw_` workspace;
  Cloud resolution returns 404 because it has no canonical app-workspace UUID.
- Cloud CLI tokens cannot use the browser-session `createAppWorkspace` route.
  Browser creation also changes `users.lastWorkspaceId`.
- The existing delete route accepts Relay `rw_` identifiers, not the canonical
  app UUID row created by the browser flow, so exact teardown is impossible.

Add an explicitly scoped ephemeral app-workspace API and CLI that creates the
canonical UUID plus bound Relay workspace without switching the user's default,
returns credentials through a reveal-once private-file contract, supports an
expiry, and provides idempotent cascade deletion with proof that Fleet,
Daytona, Relayfile, Relaycast, registry, and agent resources are gone. The board
must run twice in separate ephemeral workspaces and prove the operator's
default workspace/store is unchanged.

Release qualification also has no end-to-end candidate selector today. The
Fleet CLI and Cloud ensure path select the production snapshot; a verifier-side
`--sandbox-snapshot` argument is intentionally fail-closed until a tightly
authorized, non-production selector is implemented. Do not make arbitrary
production snapshot names user-selectable. Bind the selector to a candidate
manifest digest and a dedicated qualification credential or stage.

Relayfile Cloud has an independent provenance blocker. Cloud currently routes
every workspace through one stage-global `RELAYFILE_URL`; its canonical and
`rw_` registry rows contain no data-plane deployment identity. Relayfile Cloud
has no control-plane operation that provisions or binds one workspace to a
specific candidate deployment/version and returns a non-secret routing
attestation. Consequently a manifest can claim `relayfileCloudSha` while the
mount actually exercises production. Add a qualified candidate-deployment
attestation, exact `rw_` binding, and idempotent purge/reconciliation against
that same target; persist the binding in Cloud's ephemeral lifecycle ledger.
Until this exists, `cloud workspace create --relayfile-cloud-deployment <id>`
is a hard capability blocker, not a flag that may merely record an unused ID.

An independent review of the first candidate-snapshot workflow found these
release blockers: name conflicts were treated as successful builds; smoke did
not assert exact source/build-input identity; promotion consumed mutable names
rather than the qualified manifest/digest; feature-ref dispatch could push to
main; overlapping SSM/pin writes could split state; base images and global CLIs
floated; Relayfile provenance was self-hashed after download; and Relayfile
prereleases could not be supplied as approved artifacts. Candidate build and
promotion must be separate: qualify one immutable full/lite artifact pair,
then promote those exact IDs by verified artifact digest without rebuilding.
The revised candidate implementation statically binds the Cloud source SHA,
Relayfile source SHA and binary hash, exact package versions, complete npm
closure lockfiles, digest-pinned bases, the full/lite snapshot IDs, and the
GitHub artifact digest. Its focused tests and source-only checks pass. No live
candidate snapshot has yet been built and smoked in Daytona, so it remains
implementation evidence rather than end-to-end qualification. Promotion also
correctly remains blocked before selector mutation because an atomic full/lite
selector transaction does not yet exist.

The globally installed Relayflow launcher was also not an acceptable proof
runtime: it bundled an older harness driver, stopped startup polling after ten
503 responses, could leak a broker when spawn assignment never completed,
ignored `AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST` unless passed through
`run({ relay: { env } })`, did not retry workspace-create 503, and returned
process exit zero for a failed workflow unless the workflow script explicitly
threw on `result.status`. Every scheduled/release workflow must use the local
lockfile runtime, pass relay options explicitly, and fail the parent process on
any non-completed real run.

#### Relayflow runtime blockers reproduced on 2026-09-05

The first refreshed diagnosis used Relayflows 1.0.1 and failed before step 1
with a bare hosted `Service Unavailable`. The runner's documented
`AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST=1` path suppressed channel creation but
still spawned a broker, while the current Relay broker unconditionally called
Relaycast during initialization. Pin both `@relayflows/cli` and
`@relayflows/core` to exact 1.1.4 and verify both loaded versions before a run;
do not accept a globally installed or nested mismatched launcher.

Version 1.1.4 supplies a `local-process` sandbox provider and the current
30-step, 25-wave diagnosis dry-run validates cleanly, but two more startup defects were
reproduced:

- restricted agent permissions unconditionally trigger Relayfile provisioning;
  the provisioner calls a hosted workspace-creation route that does not exist
  and returns 404 even when the workflow declares no Relayfile integration or
  mount. `RELAY_CLOUD_PROVISIONING_DONE=1` bypasses this for the read-only
  file-coordinated diagnosis, but is not an acceptable general fix. Add an
  explicit no-Relayfile-provisioning contract that preserves filesystem policy
  enforcement, and integration-test it without a hosted dependency;
- `local-process` replaces `HOME` with a new temporary directory. That is useful
  write isolation but silently hides the operator's authenticated GitHub,
  Claude, and Codex configuration. The preflight then flaked across repository
  issue queries and repair agents reported `Not logged in`. Scheduled CI must
  inject narrowly-scoped `GH_TOKEN`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`
  explicitly; the local provider needs a first-class, allowlisted credential
  projection that does not expose the operator's full home or credentials to
  artifacts.

With hosted Relayfile provisioning bypassed and host authentication available,
run `diagnosis-20260905-live7` completed after about 139 minutes. It inspected
484 open issues and 400 recent merges, produced a 30-bug ledger, retained 222
unknowns, and emitted all 143 required coverage rows. Every row remained
`BLOCKED`, both fresh signoff agents rejected the result, and final acceptance
failed closed because `BLOCKED_NO_COMMIT.md` existed. This is useful diagnosis
evidence, not a clean sandbox or product pass. The rejected signoffs found
source drift, unsealed generated reproduction dependencies, incomplete
reproductions, context/static-root mismatch, post-review artifact mutation,
weak blocker-state parsing, and a false Relay-version-to-commit binding.

The repaired diagnostic harness must preserve these invariants:

- recursively seal every retained artifact and generated reproduction
  dependency, rejecting symlinks and mutation after review;
- bind context, static gates, coverage, reviews, and final acceptance to the
  same source manifest. Runtime `.agentworkforce/trajectories/` changes may be
  excluded from the content digest, but the directory must remain tracked;
- require exactly 143 unique, schema-validated coverage rows: 12 state-machine
  transitions, 23 injected faults, 13 acceptance gates, and all 95 Fleet
  operations. Every row must map bidirectionally to a bug or unknown;
- treat every unresolved `CRITICAL` or `HIGH` bug as a promotion blocker,
  including `CONFIRMED`, `IN_PROGRESS`, and `BLOCKED`, not only a literal
  `OPEN` status;
- verify that any claimed release commit actually contains the claimed package
  version, and distinguish current-checkout tests from candidate-checkout
  tests instead of calling either one `mainline`;
- never let a fresh reviewer repair its own failed final gate. Coverage has an
  explicit author/gate/repair/final-gate loop, while seal and acceptance are
  deterministic fail-fast steps.

The cleanroom command recorder also had a cross-chunk evidence bug: retaining
only the last 8 KiB could discard an earlier secret marker or failure while a
later benign tail passed. The hardened recorder now counts bytes, omits the
entire captured stream when the cap is exceeded, records truncation, and fails
both the command and corpus attempt. Preserve the multibyte/early-secret
regression test and never restore tail-only evidence.

#### Fresh ACL review blockers reproduced on 2026-09-05

The second ACL candidate received a RED independent review for redundant and
ambiguous PUT behavior, production tsconfig aliasing, unsafe diagnostic-code
acceptance, missing success-body validation, and unstable RelayAuth identity
creation. A subsequent candidate fixed those local findings and passed focused
Core/orchestrator/build gates, but a new fresh review still returned RED with
six blockers:

1. A stable identity name is not an atomic idempotency boundary. Concurrent
   callers can both pass the D1 projection lookup and create different random
   IDs; a committed Durable Object create followed by projection failure is
   also invisible to the next lookup. Add an authoritative exact-name or
   deterministic-key upsert and prove concurrent and projection-failure
   convergence to exactly one identity.
2. After an ambiguous ACL PUT, stale readback still allows a later outer retry
   to issue a second PUT. Once any write might have committed, stay in
   confirmation-only GET polling unless the protocol proves non-acceptance.
3. Launch diagnostic base messages can retain raw or double-encoded URL path,
   query, or userinfo credentials even when `config.url` is sanitized. Apply
   the same bounded decode/reconstruction policy to message URLs or replace the
   base with a generic HTTP-context error.
4. The full Web suite fails three delegated-token tests because their fixtures
   still return obsolete GET-shaped 200 responses to PUT. Model the canonical
   202 write response plus committed confirmation GET and restore the full
   suite, rather than weakening response validation.
5. Stable-name recovery stops after the newest 300 identities. Prefer the
   authoritative exact-name operation; otherwise scan to cursor exhaustion
   under the shared deadline with cursor-cycle protection.
6. A RelayAuth token endpoint 204 becomes a raw retryable `TypeError`. Validate
   endpoint response objects before dereference and report a typed,
   non-retryable response error.

#### Candidate snapshot and ephemeral workspace state on 2026-09-05

The latest uncommitted candidate snapshot work binds Cloud, Relay, and Relayfile
producer repository/run/attempt/workflow/source/artifact digests; uses a
digest-pinned tools bundle; aligns both Relayflows packages at exact 1.1.4;
verifies in-image paths, hashes, versions, and noninteractive sudo; and adds a
separate cold plus two-concurrent 258 MiB acceptance workflow with cleanup
proof. Its focused gates pass, but fresh review remains RED: Relayfile producer
trust is still caller-defined, exact snapshot IDs are checked and then replaced
by mutable names, ambiguous creation and fail-fast parallel smoke can orphan
resources, retry delete mishandles a structured 404, Git smoke omits HTTPS
clone/fetch, ordinary non-PR smoke can silently skip Relayfile, and Docker/E2B
fallback identity lacks a source SHA. This is implementation evidence only
until those findings are repaired, independently re-reviewed, and a clean
runner builds and proves the exact declared artifacts in Daytona.

Relay now contains a candidate two-artifact package producer contract: a manual,
main-only workflow requires a unique unpublished prerelease and creates a
payload attestation for the seven exact Relay protocol/source packages plus a
separate envelope bound to the platform artifact digest and payload-file
SHA-256. Relay issue #1663 records why this must not run on every ordinary main
push: a stable version that already exists on npm makes the unpublished check
red by construction. The qualification manifest schema is version 4 and binds
that Relay producer alongside fixed Cloud snapshot, Cloud snapshot-acceptance,
and Relayfile Cloud producers.

Command help remains availability evidence only. The runtime effect gate now
consumes the raw downloaded manifest, deployment-attestation, and acceptance
bytes; validates their hashes itself; requires the requested and observed
immutable Daytona snapshot ID; validates one cold and two genuinely overlapping
258 MiB Fleet auto-mounts with exact marker, request-level bulk/zero-point,
cgroup CPU/RSS, and cleanup evidence; and binds two canonical ephemeral
workspaces to the qualified Relayfile Cloud source, deployment, attestation, and
credential-free HTTPS endpoint identity. Each workspace deletion must identify
the exact app and Relay workspace in every cascade phase, carry a server
operation ID and verification time, complete inside 120 seconds, and be
followed by an authenticated GET that returns 404. Successful help text,
aggregate zero counts without target identity, and caller-supplied digest
strings must never qualify a release.

No Relay package producer run, package publication, candidate snapshot build,
or complete Daytona qualification has yet been performed. Cloud issue #3349 is
still a hard blocker because the final qualification evidence has no atomic
write-once store. Cloud issue #3351 is still a hard blocker because there is no
attested Relayfile deployment resolver, persisted create idempotency and
uncertain-response reconciliation, TTL reaper/cascade, non-switching app
workspace creation, or absolute-expiry credential contract. Cloud PR #3352
only makes the current API fail closed with typed HTTP 501 before creation when
any proposed ephemeral/candidate-binding field is present; it is a safety
prerequisite, not the full feature.

Fleet `set-model` also remains unproved. The current broker receipt proves queue
admission only (`accepted: true`, `pending: true`); it does not prove that the
provider applied the model or expose the effective model. Relay issue #1658
requires a request ID/generation, a typed provider acknowledgement with the
effective model, and a queryable terminal state. The Fleet qualification gate
must continue to fail unless it receives an applied receipt; headless/native
providers without such support are unsupported, not implicit passes.

An earlier isolated Cloud/Relay lifecycle candidate had focused tests for a
TTL-bound canonical UUID plus `rw_` binding, 0600 fsynced reveal-once credential
file, and cascade deletion. It was not merged and is not current Cloud behavior.
Do not claim the Relaycast workspace key is globally reveal-once: current
owner-authorized legacy resolve/join/mount paths may return it, so a durable
secret handle/envelope plus deny/redaction coverage is still required. A
committed create followed by a lost response can orphan one workspace and create
another unless the server persists the caller's idempotency key and provides a
bounded reconciliation lookup. Qualification cleanup may use a safely returned
ID or private credential file, but it cannot manufacture ownership after an
unknown POST outcome.

The stable failures were: topology/snapshot parity; `fleet spawn` via node
alias, automatic owned placement, and session reference; Fleet Claude, Gemini,
Aider, Goose, and Grok providers; root Relayfile mount; `fleet release
--delete-agent`; Fleet config; post-ready steer on node A; `node up` while
running and after down; direct Codex native, task-exit, and exit-after-task;
direct Claude, Gemini, Droid, Aider, Goose, Grok, Cursor, Pi native, and
DeepAgents native providers; attach passthrough; message hold, flush, and auto;
direct node-agent release; and final agent-identity reconciliation.

The flaky operations were: node A provisioning and initial sentinel; targeted
Fleet spawn by `--node`; Fleet `--no-confirm` and metadata/channel/model/cwd;
Fleet Codex and OpenCode providers; scoped and no-mount sandbox paths; owned
sandbox reclamation; exact reader acknowledgement; direct Codex auto on A and
PTY; attach view and drive; same-name reclamation; and workflow logs, follow,
sync dry-run, and sync. A flake remains a product failure until repeated clean
runs meet the acceptance threshold.

`fleet enable`, `fleet disable`, and `fleet inherit` were not mutated because
none of the discoverable workspace IDs was both valid and demonstrably
disposable. Run them only when
`VERIFY_FLEET_DISPOSABLE_WORKSPACE=1` and
`VERIFY_FLEET_EXPECTED_WORKSPACE_ID` exactly matches the resolved active
workspace. Capture and restore the initial override even when the probe fails.

The representative root mount failed in three independent automated attempts
at 265.3s, 264.1s, and 273.2s with the same 503 initial-sync-readiness failure.
A scoped mount passed one hardened attempt at 102.9s and an independent
no-mount sandbox passed at 82.6s. This is strong isolation of the root mount
size/readiness boundary, not proof of its exact internal CPU-burning handler.
Both hardened attempts deleted every exact owned Daytona sandbox and restored
the Daytona baseline. Agent identity cleanup missed its 120-second SLO in both
attempts; exact delayed recovery eventually removed all four identities, and a
3,995-record parsed roster census found none remaining. Preserve both facts:
there was no final leak, but release/reconciliation still failed its contract.

Use
`.workflow-artifacts/verify-fleet-daytona/relayfull-campaign-0904/campaign.json`
for per-operation classifications and timing distributions when it is present
on the operator host. Use
`tests/relayflows/cleanroom/FLEET_DAYTONA_MANUAL_2026-09-04.md` as the durable,
redacted summary. Never commit raw credentials or unredacted provider output.

At one inventory point there were 212 retained sandboxes: 125 started, 87 stopped, and exactly 250 started CPUs in use. This made a normal two-CPU provision fail at the account ceiling. Many retained `fleet-ensure-*` and verification nodes were still started long after their work should have ended.

A fresh 2026-09-05 Relay fleet inventory returned 3,290 node records: 145
reported live, 3,145 offline, 354 named `fleet-ensure-*`, and 110 of those
`fleet-ensure-*` records still live. The live version distribution was 110 on
broker 11.8.2, two on 11.8.3, only one on 11.10.2, plus 32 implicit/SDK nodes.
`finn-mini` reported 11.8.3 while the candidate line was 11.10.2. This is both
an operational cleanup problem and a qualification provenance problem. Issue
#1455 now carries the evidence. Use exact nonce-owned lookups; never treat a
spawn on a stale broker as proof of the current candidate.

Two cheap Agent Relay workers dispatched and confirmed on live nodes then went
offline without sending their required evidence receipt. Treat this as the
same spawn/receipt recurrence tracked in issue #1563: dispatch/confirmation is
not task completion, and a silent offline worker earns zero proof credit.

### Cloud workflow scheduler failure

- Full workflow run `17c8f8d7-8b96-4cd2-9c01-34b55abd9414` accepted a 7.59 MB code upload, then remained `pending` with no Daytona sandbox for 76 minutes until manually cancelled.
- Zero-agent control run `29adc3c5-7caa-4ea7-af82-3c7ed22d4024` behaved the same way and was manually cancelled.
- The unit contracts for durable enqueue, the launch worker, DLQ terminalization, and stuck-run reaping passed. In particular, the reaper tests say a never-claimed queued launch should terminalize after 30 minutes. Production behavior contradicted those tests.

This points first to deployed route/queue/consumer/reaper wiring or configuration, not merely the isolated job algorithms.

#### Follow-up diagnosis and production changes (2026-09-04)

Subsequent AWS evidence narrowed the `pending`/`sandboxId: null` signature. Cloud issue #3262 was initially reported as a never-claimed job, but CloudWatch proved the job was claimed (`attempts: 1`) and failed seven seconds after submission with a bare HTTP 400. Failures in the same window included `relayfile ACL PUT /.relayfile.acl timed out after 15000ms`, making Relayfile workspace/ACL provisioning the leading upstream dependency hypothesis rather than a dead queue consumer.

Two Cloud fixes then merged and deployed to production:

- Cloud PR #3314 (`dd9221f58a521542e33aec62b39916de68249027`) classifies permanent HTTP 4xx launch failures as terminal and retains redacted method/path/body diagnostics. Production deploy run `33815192018` completed at 2026-09-03 22:55 UTC.
- Cloud PR #3315 (`b76e107d0f4f31bf549dd17e576553dd3e5abdf6`) releases generic retryable launch claims back to `queued` before returning the message to SQS. Production deploy run `33842815893` completed at 2026-09-04 06:10 UTC. Its pre-fix production reproduction `a3a0385f-6c05-4d9a-961a-603fddeb211b` was claimed and then hit `relayfile ACL read failed with status 500`. The 40-minute database lease outlived the 16-minute SQS visibility timeout, so redelivery observed an active lease, acknowledged the duplicate as a no-op, and deleted the only queue message, leaving the run stranded.

Treat those merges as repaired failure handling, not an end-to-end pass. They do not prove that Relayfile ACL provisioning is reliable, that the large initial mount no longer exceeds the Durable Object CPU budget, or that production now completes and reclaims a RelayFlow sandbox. Begin with new post-2026-09-04 06:10 UTC zero-agent and one-agent runs from `origin/main` at or after `b76e107d0`. On a transient Relayfile/provider 5xx, prove that the launch job returns to `queued` and is reclaimed. On a permanent 4xx, prove that the run becomes terminal with a redacted actionable endpoint/body. A fresh silent `pending` result remains a failure even if the two unit fixes are present.

Keep four stages distinct in evidence and remediation:

1. Run/job persistence, enqueue, delivery, and claim.
2. Outer Daytona sandbox creation and readiness.
3. Relayfile initial seed/mount inside the outer sandbox.
4. Per-step agent sandbox provisioning and release.

The two baseline runs with no Daytona sandbox failed in stages 1-2 or their boundary; the 258 MB Relayfile Durable Object CPU failure is stage 3. Do not collapse both into a generic scheduler or generic sandbox failure.

### Cloud image failures

- `/usr/local/bin/relay-sandbox-entrypoint --smoke` failed immediately because `/opt/relay-smoke` did not exist.
- A clean `npm ci` in the Cloud checkout was OOM-killed in the stock two-GB sandbox, including a retry with `NODE_OPTIONS=--max-old-space-size=1536`.
- The image did not contain Cargo/Rust or Swift. Installing Rust allowed the release broker binary to build, but `cargo test --workspace --all-targets` was OOM-killed even with `CARGO_BUILD_JOBS=1`.
- Pure image/entrypoint/pin/patch contract tests passed (32 tests), which did not detect the missing runtime smoke directory.

### Relay clean-checkout results

- The clean-room catalog validated 29 feature categories, 194 feature IDs, and eight lanes.
- An operator-host scope collection found 183 open issues and 224 recent
  functional merges to route into those lanes. No immutable scope artifact was
  retained with this branch, so rerun collection before relying on those live
  counts.
- Two broad Vitest batches passed 930 tests total, with five provider-backed tests skipped for missing credentials.
- The native broker integration run hung in `lockfile.test.js` and left at least ten persistent broker processes. `SIGTERM` did not stop them; cleanup required `SIGKILL`.
- Python SDK: 287 passed, two skipped, four failed. Three failures invoke the removed top-level `agent-relay run`; one expects `sessionId` to be absent but receives `sessionId: None`.
- The Python editable install fails unless a broker binary has first been staged at the package's expected path; the clean-room setup did not stage it.
- OpenCode plugin setup attempted to install the nonexistent npm peer package `opencode@>=0.1.0` and failed with E404. Running the plugin tests from existing root dependencies passed 28 tests.
- The Gemini extension checks passed. Swift could not run because the stock image has no Swift toolchain.
- Two integration CLI assertions still expect removed top-level `swarm --dry-run` and `workflows list` commands.

### Real `fleet spawn --sandbox` failure and isolation result

The checkout-built CLI was used, not a global replacement.

Default Relayfile-enabled command:

```bash
node packages/cli/dist/cli/index.js fleet spawn codex \
  --name cleanroom-luna-<unique> \
  --task 'Reply exactly RELAY_SANDBOX_OK, then exit.' \
  --sandbox \
  --sandbox-name relay-cleanroom-cli-<unique> \
  --model gpt-5.6-luna \
  --confirm-timeout 180000
```

The request created a Daytona sandbox but timed out with an unknown provisioning outcome. Cloud registered no fleet node, launched no broker, and launched no agent. Only `relayfile-mount` remained alive. Its redacted log established the failure sequence:

1. WebSocket upgrade returned HTTP 500, so the mount fell back to polling.
2. It traversed workspace root `/`: 1,305 entries, 851 files, 454 directories, about 258 MB.
3. After about 115 seconds, the Durable Object exceeded its CPU time limit and was reset.
4. Initial sync paused before readiness.
5. The CLI/Cloud timeout path did not delete the newly-created sandbox.

The same command with `--no-sandbox-relayfile` succeeded. The node enrolled, broker `11.8.2` became live, Codex launched on `gpt-5.6-luna`, and the initial task produced `RELAY_SANDBOX_OK`. A real `steer` DM was injected into the PTY; the agent replied `INJECTION_OK` through both DM and channel records. That proves the isolated node, model, MCP configuration, Relay message delivery, PTY injection, and agent reply path can work.

Relayfile issue #455 and its open fixes are necessary but not sufficient for this failure. PR #457 (`fix/455-state-json-single-writer`) makes `mount --once` continue until bootstrap reconciliation completes and prevents two writers from clobbering `.relay/state.json`. PR #459 (`proof/455-sandbox-e2e`) proves the v0.10.50 baseline exits 75 at 2,000 files while the #457 candidate eventually completes 5,685 files. That candidate took about 31 minutes for the scoped Relay repository, so it proves resumability, not acceptable readiness latency or bounded Durable Object work. Do not claim the 258 MB root-mount failure fixed merely because #457/#459 pass.

The Relayfile Cloud data plane deployed as `fba79e90` already performs Worker-side R2 body reads and rejects an oversized atomic JSON export with a 128 MiB preflight. A 258 MB root mount should therefore fall back to paginated `fs/tree` plus concurrent `fs/file` requests. Capture the exact endpoint and Durable Object request that consumes the CPU budget; separately measure export preflight, tree pagination, metadata lookups, R2 body reads, and concurrent background writes. Do not attribute the reset to the export body without request-level evidence.

In the Go client, the exact summary `bootstrap paused due to transient read error(s)` is emitted only after an HTTP failure in a per-file `ReadFile` batch. A `ListTree` failure returns separately with `traversal_failed=true`. If a fresh reproduction emits that exact summary after the Durable Object reset, use it as evidence for the `/fs/file` metadata path; if the earlier wording was a paraphrase, keep endpoint attribution UNKNOWN until instrumented evidence identifies it.

The avoidable pressure is known even while the exact CPU-burning handler is not: the root mount creates an 851-file N+1 path with up to 16 concurrent `/fs/file` requests against one coordinator Durable Object. Each request repeats token/revocation verification and ancestor ACL resolution; the Worker loads ordinary R2 bodies only after the Durable Object returns metadata. Immediate containment is an explicit `/relayflows/<run-id>/**` mount root. The structural repair should use bounded `/fs/bulk-read` batches (at most 32 paths and an aggregate byte cap), one bounded internal bulk-metadata operation, and request-local ACL-marker caching for tree/export/bulk processing. Reducing concurrency to at most eight and backing off 429/503/reset responses is useful containment but is not proof that root mounting scales.

An initial Relayfile Cloud admission patch exposed a real ordinary-promise bug:
the Workspace Durable Object called asynchronous route handlers inside a
synchronous `try/finally`, so it released the inflight slot before a handler
settled and asynchronous rejections escaped its error path. Awaiting the
handler fixes that case, but independent review rejected it as a complete CPU
repair: export and writeback return streaming `Response` bodies whose later
pulls perform SQL/R2 work after the handler promise resolves, so admission is
still released before expensive stream consumption, cancellation, or failure.
Unknown asynchronous exceptions also currently risk returning their raw
message. The fix needs runtime-level tests for ordinary, streamed, canceled,
rejected, and WebSocket-handshake lifetimes plus a generic public 500 and
protected sanitized telemetry.

A later admission candidate holds leases through body EOF/cancellation and
passes focused 237-test, full 1,061-test, Workerd, typecheck, infrastructure,
and formatting gates. Fresh review nevertheless found that discarded GitHub
credential, inline-content, oversize writeback, bulk-fanout, and status-only
response bodies could occupy all nine background slots. The candidate now
cancels every unreturned body and a direct reproducer admits the next request
immediately, but it still needs a different fresh reviewer. Do not call this
fixed until that review passes and live backpressure behavior is measured.

Fresh origin-main worktrees independently confirmed the bulk-read gap:
Relayfile mount still fans checkpoint files into as many as sixteen `/fs/file`
calls, while Relayfile Cloud's public `/fs/bulk-read` caps at 100 paths but
performs sequential per-path internal metadata calls. The required repair is a
typed client batch of no more than 32 paths with explicit-unsupported-only
fallback, plus one internal metadata operation per storage shard, bounded R2
concurrency and aggregate bytes, and a request-local ACL marker cache. Its real
gate must seed the 851-file/454-directory/about-258-MiB fixture through
SQLite, R2, and HTTP/Workerd and run one cold plus two concurrent mounts; a
microbenchmark or mocked handler is not an acceptable replacement.

The first Cloud ACL retry candidate was likewise rejected after independent
review despite its focused tests passing. Its 30-second clock did not cancel or
bound RelayAuth token minting; RelayAuth error bodies remained unbounded and
insufficiently redacted; typed ACL `retryable`/safe-code fields were not
consumed by launch classification, so an exhausted retryable CAS conflict could
become terminal; and its status allowlist diverged from the required
transport/408/429/5xx policy. The shared deadline and diagnostic contract must
cover token mint, headers, bodies, backoff, GET, PUT, and ambiguous-write
readback as one operation.

The hosted terminal attach endpoint separately returned HTTP 503 `database_overloaded` and did not retry, even though the error carried a retry interval.

`fleet release --delete-agent` stopped Codex and the node reported zero agents, but the Cloud-owned Daytona sandbox remained started. It had `autoStopInterval: 0` and `autoDeleteInterval: 1440` (24 hours). This is a direct contributor to quota exhaustion.

## Required diagnosis

Build one explicit cross-repository state machine and trace every transition with a stable correlation ID:

```text
request accepted
  -> run / launch job persisted
  -> durable enqueue acknowledged
  -> queue delivery observed
  -> consumer claim persisted
  -> Daytona create requested
  -> sandbox ownership persisted
  -> optional Relayfile mount ready
  -> node enrolled and heartbeat live
  -> agent spawn confirmed
  -> message injected and read/response observed
  -> agent released
  -> node and sandbox reclaimed
```

For each transition, identify:

- owning repository, deployed component, queue/binding, IAM permission, configuration flag, database row and status fields;
- timeout and retry policy;
- idempotency key and duplicate-delivery behavior;
- terminal failure state and user-visible error;
- compensating cleanup action and who owns it;
- structured log/metric/alert that proves the transition happened.

Trace the two pending run IDs through the API route, launch-job row, SQS or signed queue bridge, worker subscription, DLQ, and reaper schedule. Determine whether the job was never enqueued, enqueued to the wrong queue/stage, never delivered, rejected/decryption-failed before claim, or left behind because the reaper was not deployed or not scheduled. Do not infer from unit tests; obtain deployment/runtime evidence.

Trace the fleet sandbox request through Cloud's ensure endpoint, Daytona create, Relayfile initial sync, node enrollment, and response timeout. Confirm why the API returned a generic 500 at the CPU ceiling and why the Relayfile timeout returned an unknown outcome without compensation.

## Required repairs

1. **Pending-run boundedness:** an accepted workflow must leave `pending` within a documented SLO. It either reaches a live provisioning/running state or becomes terminal with a redacted, actionable failure. No job may remain pending indefinitely.
2. **Durable wiring:** make enqueue, claim, retry, DLQ, and reaper wiring testable against the deployed-stage configuration. Add startup/canary checks that fail when a queue has no consumer or the reaper schedule is absent.
3. **Transactional sandbox ownership:** persist sandbox ownership as soon as create returns. Every timeout, cancellation, bootstrap failure, mount failure, duplicate request, and client disconnect must converge on one idempotent cleanup/reconciliation path.
4. **Relayfile ACL reliability:** replace the partial PUT/429-only retry with one bounded GET→compare-and-set state machine. Retry safe transient GET/PUT timeouts, network resets, 429s, and 5xx responses with jitter and `Retry-After`; fail permanent 4xx immediately. Re-read after an ambiguous PUT and prove the desired ACL before retrying so timeout recovery cannot lose or duplicate principals. Use one overall deadline rather than multiplying 15-second request timeouts across nested retry loops.
   Keep the abort deadline active through response-body consumption, not merely until response headers arrive. Preserve numeric status on permanent failures so the launch worker can classify them correctly. Redact and bound any Relayfile response body before constructing an error because launch-worker logging and failure comments occur before the later terminal-error redactor.
5. **Relayfile readiness:** do not make a large full-tree traversal consume the synchronous ensure request budget. Make Fleet/RelayFlow callers supply a dedicated scoped subtree; give the older direct POST `/sandbox` route the same `relayfilePaths` contract or require an explicit `mountAllRelayfile: true` acknowledgement before `/` is mounted. Fix the WebSocket HTTP 500. Replace per-file bootstrap hydration with bounded bulk-read/bulk-metadata operations, cache common ACL marker lookups within a request, bound and checkpoint traversal, expose progress, and return a typed mount failure. A mount failure must not strand a sandbox. Preserve #457's resumable `--once` behavior, but enforce a separate readiness SLO. Do not raise the Durable Object CPU or JSON export limits as the fix.
6. **Release semantics:** define the lifecycle of a node created exclusively for `fleet spawn --sandbox`. Releasing its last agent must delete or stop/reclaim that owned sandbox within a short SLO, unless the caller explicitly requests retention. Never leave a zero-agent sandbox started for 24 hours by default.
7. **Quota behavior:** add a preflight or typed provider-capacity error with requested/current/limit values. A quota failure must create no database ghost, node, agent, or sandbox. Generic HTTP 500 is unacceptable.
8. **Attach resilience:** retry bounded transient 429/503/database-overloaded terminal-session creation according to `Retry-After`, without duplicating a session.
9. **Image contract:** make the shipped smoke entrypoint self-contained and verify `/opt/relay-smoke` exists in the built image. Either size the image/sandbox so documented clean installs and native tests work, or split build/test snapshots and declare their resource/toolchain requirements explicitly.
10. **Test drift:** fix stale CLI expectations, Python packaging/CLI drift, `sessionId` parity, OpenCode peer installation, Swift provisioning, and broker integration cleanup. A timed-out test must terminate every descendant broker without requiring manual `SIGKILL`.
11. **Observability:** all accepted operations must expose phase, correlation ID, timestamps, retry count, owned resource IDs, and final cleanup status. Add alerts for old pending runs, never-claimed jobs, zero-agent started fleet sandboxes, and cleanup retries exhausted.

## Deterministic tests to add

Add tests at the lowest useful layer and at least one real E2E for each critical chain:

- route persistence succeeds but enqueue fails;
- enqueue succeeds but consumer never claims;
- duplicate enqueue/delivery and worker restart;
- provider quota/rate-limit/timeout before and after sandbox creation;
- client disconnect or request timeout while provisioning continues;
- ACL GET and PUT timeout/network/429/5xx recovery, ambiguous PUT read-after-write, permanent 4xx rejection, and shared-deadline exhaustion;
- Relayfile WebSocket failure, oversized tree, traversal checkpoint/retry, and Durable Object reset;
- cancellation racing create/mount/enrollment;
- release during spawn and release of the final agent;
- cleanup API failure followed by reconciliation;
- stale pending reaper and never-claimed launch job against the deployed wiring;
- terminal attach 503 with `Retry-After`;
- stock image smoke entrypoint;
- process-group cleanup after broker test timeout.

Tests must assert both the product result and negative space: no extra sandbox, no live worker, no active identity, no pending job, no credential in argv/logs, and no leftover process.

## Final acceptance run

Use at least two newly-created, labeled Daytona sandboxes from the intended production snapshot. Record exact commit and image digests. Do not reuse a developer machine's HOME, Relay state, node_modules, Cargo cache, or credentials except narrowly-scoped test credentials.

The final evidence must show:

1. Stock `/usr/local/bin/relay-sandbox-entrypoint --smoke` passes.
2. Clean installs/builds for the declared lane image pass without OOM, or the workflow selects a documented higher-resource/toolchain image.
3. A zero-agent Cloud workflow and a one-agent workflow both leave pending within the SLO, execute, expose logs, and reach the correct terminal state.
4. `fleet spawn --sandbox` with an explicit Relayfile subtree succeeds for a representative repository, confirms the agent, proves an excluded sentinel outside the scope is absent, delivers a real injected DM, and receives an MCP reply.
   The evidence must include successful ACL convergence and the exact scoped mount roots, entry count, bytes, request count, CPU/wall time, and readiness duration. Assert that no root export/tree request occurred.
5. The `--no-sandbox-relayfile` control also passes.
6. A deliberately oversized or failing Relayfile mount returns a typed terminal failure and automatically deletes its sandbox.
7. Agent release is confirmed, the fleet inventory reports zero live agents, and every investigation-owned sandbox is deleted/reclaimed within the SLO.
8. Repeating the critical lifecycle at least five times produces no mixed result and no same-name/idempotency failure.
9. The clean-room Relayflow runs at `full` profile, retains immutable per-lane evidence, and reports RED/YELLOW for real failures or gaps rather than manufacturing GREEN.
10. Two fresh independent reviewers inspect the diff and evidence. Run repository-required diff/security/secrets/CI gates before handoff.

Run the full-root scale proof as a separate scheduled gate in a disposable workspace matching 1,305 entries, 851 files, 454 directories, and about 258 MiB declared size. One cold mount and two concurrent cold mounts must reach `bootstrap == null`, match the expected manifest, emit no 429/500/CPU reset, and reclaim every process and sandbox. The ordinary scoped Fleet gate does not prove full-root scalability.

Deliver a root-cause table, state-machine diagram, companion issue/PR/branch list,
exact commands and test counts, before/after resource inventory, redacted logs,
and remaining risks. Push only feature branches. Merge only through PRs that meet
every proof/review/CI/Veto gate above; otherwise leave them open with the precise
blocker. Stop before deployment, package publication, credential rotation, or a
release cut unless the human explicitly authorizes that external change.
