# `node up` node-identity collision guard — findings

Branch `fix/node-up-enrollment-guard` (worktree `/tmp/relay-node-guard`).

Incident being closed: on 2026-09-19 (host `kjg-laptop`) a second
`agent-relay node up` adopted the machine-global enrollment for node
`node_223043746339667968` while broker `relay-lead-0908b` was live, and the
engine moved that node's delivery socket to the newcomer. Deliveries to the
first broker stopped for ~18 minutes with no error on either side. It happened
twice, including with an isolated `--state-dir`, because
`~/.agentworkforce/relay/fleet-enrollments.json` is machine-global and not
state-dir-scoped.

## Mechanism chosen

A **machine-global node-claim file**, one per enrolled node id, in
`~/.agentworkforce/relay/node-claims/`. Ownership of a node id **is the
exclusive creation of the next generation of its claim file**:

```
node-claims/<node-id>.<generation>.json
{ "version": 1, "node_id", "pid", "state_dir", "api_port", "broker_name",
  "process_started_at", "supervisor_pid", "supervisor_started_at",
  "status": "reserved"|"active", "claimed_at", "generation", "owner_token" }
```

Generations only ever increase and each one is created exactly once, by
`link(2)` from a fully-written temp file — atomic _and_ exclusive, so a reader
can never see a torn claim and two starts can never both win. **Nothing ever
deletes a record another process might have replaced**, which is what makes
takeover safe without a lock file. The reader of record is always the highest
generation present.

Ownership moves in two phases:

1. **Reserve** — `reserveEnrolledNode` runs in `runUpCommand` _before_
   `startBrokerWithPortFallback`, writing `status: 'reserved'` with the
   supervising CLI's pid. The broker queues `node.register` from its own
   initialization (`crates/broker/src/runtime/init.rs`), so a claim written
   after the spawn is written after the delivery socket could already have
   moved. A loser is refused having spawned nothing. This also covers
   `agent-relay up` / `local up`, which have no preflight but can be handed
   `RELAY_NODE_TOKEN` in the env.
2. **Adopt** — after `persistBrokerIdentity` verifies the child,
   `adoptNodeClaim` rewrites _our own generation_ in place with the broker's
   pid, conditional on no higher generation having appeared. A `--force`
   takeover that landed mid-start wins, and the adopting broker fails startup
   instead of putting two brokers back on one socket.

The claim records both pids (`pid` + `supervisor_pid`) and reads as **held while
either is alive**. A start's own pid is never evidence against it — a claim that
records the acquirer's pid can be re-taken — but that exemption is scoped to the
pid _as a recorded holder_ and suppresses nothing else: the orphan fences below
still run in full. (Exempting the whole check on pid equality, as round 2 did,
was unsound: a pid is not an identity, and a start handed a dead supervisor's
recycled number would have walked straight past the broker that supervisor left
registered.)

**Liveness.** Pid dead ⇒ gone. Pid alive but `ps -o lstart` differs from the
recorded birth time ⇒ gone (recycled pid, e.g. after a reboot). Anything else —
including a `ps` that cannot be run — reads as held, because refusing is
recoverable (`--force`, `node down`) while a wrong "free" verdict silently cuts
delivery. A malformed/unreadable claim reads as _unclaimed_, so a torn file can
never brick `node up` (it still raises the next generation number).

**Orphan evidence.** When every recorded pid is gone, the claim's `state_dir` is
checked for a live broker via the `connection.json` the Rust broker writes
itself — before `connect_relay`, and well before `node.register`
(`init.rs:150-200` vs `:400-415`). That is the ownership record that survives a
supervisor SIGKILLed between the spawn and the moment it could record its
broker's pid. The pid must also be identifiable as that claim's broker — by the
device and inode of the executable it is running, recorded in the claim before
the spawn (round 5); an unreadable `ps`/`lsof` ⇒ treated as a broker, i.e. err
toward guarding.

**Release.** Only the acquisition that created a generation removes it, by path,
after confirming the file still carries its `owner_token` — there is no
cross-process delete anywhere in the module. Release happens in the supervisor's
`shutdownOnce()` and in `node down`, and only once every protected process is
observed to exit **and** the state dir has no live broker.

`--force` (new, `node up` only) warns and takes the node over. `--local-only`
claims nothing. Everything else with an explicit `RELAY_NODE_ID` claims it: that
id is what `node.register` sends, so it is what can evict, and round 7 stopped
trying to predict which of the broker's credential routes (env token, cached
token, workspace-key mint) will resolve — the one that was missed was the
bypass.

Two enforcement points:

1. **Pre-start guard in `node up`** — `guardEnrolledNodeIdentity` refuses a node
   id a live claim names, printing the holder's pid, state dir, API port, broker
   name and claim time, plus three remedies (`node down --state-dir <dir>`,
   enroll a distinct node with `cloud enroll --name`, or `node up --force`).
   Nothing is spawned.
2. **Acquisition backstop in `runUpCommand`** — the reservation. A loser throws
   `NodeClaimConflictError`, which the existing startup catch turns into
   `Failed to start broker: node … already served by a live local broker …`.

## Files touched

- `packages/cli/src/cli/lib/node-claim.ts` — **new**: the claim record,
  generation scan/create/prune, `inspectNodeClaim`, `acquireNodeClaim`,
  `adoptNodeClaim`, `releaseNodeClaim`, `releaseNodeClaimsForBroker`,
  `listHeldNodeClaims`, `findLiveStateDirBroker`, `enrolledNodeIdForClaim`,
  `describeNodeClaimHolder`, `NodeClaimHoldError`,
  `inspectNodeClaimHold` (the fence, for the release path), and
  the `selfPids` scoping on `classifyNodeClaim`/`inspectClaimHold`. Imports no `child_process`
  and not the `@agent-relay/cloud` barrel (see "drift" below).
- `packages/cli/src/cli/commands/node.ts` — `--force` on `node up`, injected
  `inspectNodeClaim` dependency, `guardEnrolledNodeIdentity` refusal.
- `packages/cli/src/cli/lib/broker-lifecycle.ts` — `UpOptions.force`,
  reserve/adopt around the spawn, `spawnedBrokerPids` tracking,
  `waitForClaimHoldRelease` on the release path, release in `shutdownOnce`,
  release + `reportNodeClaimsElsewhere` in `runDownCommand`, and (round 5)
  `resolveBrokerBinary`, which records the executable the start will spawn.
- `packages/cli/src/cli/lib/node-claim.test.ts` — **new**, 62 tests.
- `packages/cli/src/cli/commands/node.test.ts` — 7 new tests (the operator-facing
  guard: refusal on a live claim, start on a dead-pid claim, unchanged first
  boot, `--force` bypass with warning, cached-token guard, no guard without a
  credential, no guard for `--local-only`, start anyway when the claim store is
  unreadable). These drive the **real** claim store via a temp `AGENT_RELAY_HOME`.
- `packages/cli/src/cli/lib/broker-lifecycle.test.ts` — 11 new tests across the
  real `runUpCommand`/`runDownCommand` paths.
- `packages/harness-driver/src/broker-process.ts`, `client.ts`,
  `broker-process.test.ts` — `waitForExit` no longer resolves the moment SIGKILL
  is sent; it reports whether an exit was actually observed, and `shutdown()`
  keeps its child handle when it was not. `terminateFailedBrokerSpawn` (round 4)
  stops and reaps the child of a `spawn()` that rejects before it can return a
  client.
- `packages/cli/README.md` — "One live broker per enrolled node".
- `CHANGELOG.md` — `[Unreleased - Patch]` → Fixed, one bullet.

`fleet.test.ts` was **not** extended: `fleet serve` is now a hidden migration
stub that only errors and points at `node up`, so it has no broker-start path to
guard. All node-lifecycle coverage lives in `node.test.ts`,
`broker-lifecycle.test.ts` and `node-claim.test.ts`.

## Verification

- `npx vitest run packages/cli packages/harness-driver packages/cloud` → 2279
  passed, 1 failed: `local-agent.test.ts > message hold and auto switch local
broker delivery mode`. Re-confirmed pre-existing: with this change's sources
  stashed it fails identically (68 passed / 1 failed either way).
- `npm run typecheck` → exit 0.
- `npm --prefix packages/cli run lint` → 0 errors; `node-claim.ts` reports no
  warnings. `prettier --check` clean on every touched file.
- Mutation checks, each confirming the new coverage bites:
  - `link()` → `rename()` in `createClaimGeneration` (i.e. a non-exclusive
    create): **4 failures**, including the six-OS-process race.
  - orphan `connection.json` evidence removed: **3 failures**.
  - `spawnedBrokerPids` dropped from the release guard: **1 failure**.

## Review round 1 (`REVIEW_VERDICT.json`) — how each blocker was closed

### [P1] Stale-lock recovery could delete another live acquisition

The lock file is **gone**. The previous design validated a stale lock's owner,
re-read the bytes, then unlinked — two separate syscalls, so one breaker could
remove a replacement lock another breaker had just taken, and both could then
enter the critical section.

Generation CAS removes the whole class: there is no destructive step to race on.
An acquisition scans, picks `max(existing) + 1`, and creates that file with
`link(2)`. A collision (`EEXIST`) means somebody else took it — re-read and
re-decide. After creating, the acquirer confirms no _higher_ generation appeared;
if one did, that start legitimately won (it read ours as takeable), so we remove
**our own** file and refuse. Exactly one generation is ever the highest, so
exactly one start owns the node.

Covered by two same-process interleaving probes that drive the competitor's
filesystem writes from inside our await points, **and** by a six-real-OS-process
race released through a shared gate file — the cross-process scheduling the
review correctly said `Promise.all` in one process cannot produce. Making the
create non-exclusive fails all four.

### [P1] Pre-adoption startup failure released ownership without observing exit

`runUpCommand` now keeps `spawnedBrokerPids`, a set fed from the
`onCandidateReady` callback and **never cleared** — the failure paths that null
`relay` out (to avoid a double `shutdown()`) no longer lose the child.
`releaseNodeClaimAfterExit` waits on every pid in the claim _and_ every spawned
pid, and then refuses to release while `findLiveStateDirBroker` still sees a
broker in the claimed state dir. Both a failed status check and a rejecting
`shutdown()` therefore keep the claim, with a warning naming
`node down --state-dir <dir> --force`.

New test: `keeps the claim when startup fails before adoption and the child
survives` drives the real `runUpCommand` with a status check that throws, a
`shutdown()` that throws, and a child that stays alive.

### [P1] Supervisor death between spawn and adoption exposed a live broker

Closed by the orphan evidence above rather than by a Rust change. A claim whose
recorded pids are all dead is only stale if its state dir has no live broker;
the broker writes `connection.json` with its own pid before it registers, so the
orphan a SIGKILLed supervisor leaves behind is discoverable from any other state
dir, by any other start. `node down` releases such a claim once it has proven
that state dir empty, so the orphan record does not become permanent litter.

New tests: `keeps a reservation held when the supervisor was killed before it
recorded the broker`, `refuses over a reservation whose supervisor died with its
broker still serving` (real `runUpCommand`), plus the negative cases (dead pid in
the connection file, pid belonging to an unrelated program).

## Review round 2 (`REVIEW_VERDICT.json`) — how each blocker was closed

Both blockers were real and both are reproduced by tests that fail on the
round-1 code. Neither needed a Rust change.

### [P1] Generation reuse broke mutual exclusion and deleted a live successor

The reviewer's interleaving is exact: generations were only unique _while a
claim was live_. `releaseNodeClaim` unlinked the last file, the stem went empty,
and the next start began at generation 1 again — so a start suspended in
`buildClaim` since before the release could wake up, create a number that had
already been reissued, pass the higher-generation check (its own file was the
highest again) and unlink the successor's generation 1 from its own stale scan.
Two live brokers, one recorded.

**A release now retires its generation number instead of freeing it.** The
record is replaced — atomically, and only on proof of `owner_token` — by a
tombstone `{version, released: true, node_id, generation, released_at}`.
`isNodeClaim` rejects it, so it reads as an unclaimed node id everywhere a claim
is read, and `readClaimGenerations` still counts it, so it keeps raising the next
number. The invariant is now statable for the whole life of the stem rather than
for the life of one claim: **a generation file is only ever removed by a process
that has already created a strictly higher one**, so `max(generation)` never
decreases and no number is issued twice. At most one spent file per node id is
on disk — the next acquisition prunes it.

Pruning superseded generations is also no longer by path alone: the scan records
each file's bytes and `pruneSupersededGeneration` re-reads before unlinking, so
a file is only removed while it still holds exactly what was classified. Under
the tombstone invariant a path cannot come back as somebody else's claim at all;
this makes the safety local instead of resting on that invariant.

New tests: `refuses a node id a successor took while this start was suspended
mid-acquire` drives the reviewer's exact sequence (a full
acquire/release/re-acquire cycle runs from inside the suspended start's own await
point) and `never reissues a generation number once it has been released` asserts
the invariant directly. Reverting the tombstone to the old `unlink` fails both.

### [P1] Supervisor death before `connection.json` permitted two registering brokers

Correct: every piece of round-1 evidence was something a process had to survive
long enough to _write_, and the reviewer's window is the one before any of it
exists. The fix is evidence the kernel keeps instead.

Each generation now has a `<stem>.<generation>.hold` sibling. The supervising
CLI creates and opens it **before** it spawns anything, and the descriptor is
passed to the broker child through `stdio` (`inheritFds`, plumbed
`runUpCommand` → `startBrokerWithPortFallback` → `CoreDependencies.createRelay`
→ `createRuntimeClient` → `HarnessDriverClient.spawn`). Descriptors are
inherited across `fork`, so:

Establishing that descriptor is a **precondition of the spawn, not a
best-effort extra**: `openNodeClaimHold` throws and `runUpCommand` refuses to
start rather than run a broker under a guarantee that is not in force. It
cleans up any partially created file and descriptor on the way out, and the
outer catch gives the reservation back, so a transient failure does not leave
the node id blocked.

- From the instant a broker child exists — paused, pre-bind, pre-publication,
  SIGSTOPped, whatever — a live process holds that file open.
- A supervisor SIGKILLed anywhere after the fork changes nothing: the child's
  copy keeps the open file description alive.
- A supervisor SIGKILLed _before_ the fork leaves no holder, and there is no
  child to register either — so the claim correctly reads stale.
- Both dying releases it immediately, with no stale-lock recovery to get wrong.

`classifyNodeClaim` consults it (`lsof -t`) before the `connection.json` orphan
check, since it is the evidence that covers the orphan's whole life. Holders are
classified the same way the connection file's pid is (round 5:
`classifyHolderProcess`, by executable identity; round 2 did this by name): an inherited descriptor is not close-on-exec, so a harness the broker
spawned inherits it too, and one left running by a SIGKILLed broker must not pin
a node id no broker is serving. The refusal names the pid that actually holds
the node, not the supervisor pid the record still carries and that was just
proven dead.

New tests, all driving real OS processes that inherit a real descriptor:
`holds a reservation whose supervisor died with the child paused before
publication` (the reviewer's case, asserting `connection.json` genuinely does not
exist), `refuses to start a second broker over a supervisor-less child`, `frees
the node id as soon as the orphaned child is gone`, `does not let an unrelated
process that inherited the descriptor pin the node`, and — over the real
`runUpCommand` — `hands the broker child a descriptor on the claim it must not
outlive`, which compares the inode the spawn was handed against the claim's own
hold file. Disabling the hold check fails the first two; unfiltering the holders
fails the fourth.

### Verification (round 2)

- `npx vitest run packages/cli packages/harness-driver packages/cloud` → 2289
  passed, 1 failed: the same pre-existing `local-agent.test.ts > message hold and
auto switch local broker delivery mode`. Re-confirmed pre-existing by stashing
  this branch's working tree and re-running that file: 68 passed / 1 failed
  either way.
- `npm run typecheck` → exit 0. `npm --prefix packages/cli run lint` → exit 0, 0
  errors; `node-claim.ts` reports no warnings. The only warning delta against the
  stashed tree is `runUpCommand`'s pre-existing complexity warning moving 104 → 107. `prettier --check` clean on every touched file.
- Mutation checks, each confirming the new coverage bites:
  - tombstone release → `unlink`: **2 failures** (both generation-reuse tests).
  - hold-descriptor check disabled in `classifyNodeClaim`: **2 failures**.
  - hold holders not filtered by `looksLikeBrokerProcess`: **1 failure**.
  - hold file not pruned with its generation: **1 failure**.
  - `shellQuote` reduced to bare quoting: **1 failure**.
- Round-1 mutation checks re-run and still biting: `link()` → `rename()` in
  `createClaimGeneration` → **4 failures** (including the six-OS-process race);
  orphan `connection.json` evidence removed → **3 failures**;
  `spawnedBrokerPids` dropped from the release guard → **1 failure**.

### What this round does NOT establish

Unchanged from round 1, and worth repeating against the reviewer's closing note:
this lane is machine-local mutual exclusion for `node up` only. It does not
touch pending persistence, withheld ACK floors, replay bookkeeping or broker
readiness/cursor handling, and it does not establish exactly-once delivery — the
Rust recovery path still explicitly allows retries of landed-but-unacknowledged
deliveries. No Rust suite or live engine delivery test was run here.

## Review round 3 (`REVIEW_VERDICT.json`) — how each blocker was closed

Both blockers were real, both are reproduced by tests that fail on the round-2
code, and neither needed a Rust change.

### [P2] Pid equality bypassed the orphan/liveness fence

`acquireNodeClaim` skipped `classifyNodeClaim` outright whenever
`current.pid === input.pid`. The reviewer's repro is exact: a reservation naming
a dead supervisor 102 with an old birth time, that supervisor's broker 103 still
live in the state dir's `connection.json`, and a new start whose recycled pid is 102. `inspectNodeClaim` answered `held` correctly, but the acquisition backstop
— which is the _only_ guard for plain `up` / `local up`, neither of which has
`node up`'s preflight — waved it through and pruned the orphan's claim.

The exemption is now scoped instead of removed. `classifyNodeClaim` and
`inspectClaimHold` take a `selfPids` set: pids in it are skipped as _recorded
holders_ (a process is not a competing broker against itself, and a start still
holding its own reservation's descriptor must not read as its own rival), and
that is all they do. The `connection.json` orphan check and the hold-descriptor
check run unchanged, so any evidence of a broker that is not this process still
refuses the start. Legitimate self-refresh survives, which the new positive
control pins.

New tests: `refuses a node whose dead supervisor left a live broker, even
holding its recycled pid` (the reviewer's sequence, with a real live process
behind `connection.json`), `refuses over a supervisor-less child while holding
the dead supervisor's recycled pid` (same start against the pre-publication
orphan, through a real inherited descriptor and real `lsof`), and `still lets a
start re-take its own claim when nothing else is serving it`.

### [P2] A hold that could not be established silently disabled crash safety

Correct, and the worst shape of failure available: `openNodeClaimHold` swallowed
every error and returned `undefined`, `runUpCommand` warned and spawned anyway.
A supervisor killed before its child published `connection.json` then left a
claim with only dead pids and no kernel evidence at all — the exact window
round 2 was written to close, reopened by any `ENOSPC`/`EACCES` on one open.

`openNodeClaimHold` now throws `NodeClaimHoldError`. Before throwing it closes
any descriptor it opened and unlinks any file it created — an abandoned fd would
keep answering `lsof` for this process's whole life, pinning a node id nothing is
serving — while a hold file it did _not_ create is left exactly as found, since
removing it would drop the fence off whatever is holding that inode. The
reservation is released by the existing `shutdownOnce()` path, so a transient
failure does not block the node id.

New tests: `refuses to spawn a broker when the ownership fence cannot be
established` (real `runUpCommand`, `ENOSPC` injected on `.hold` opens only,
asserting `createRelay` was never called and the claim was given back),
`refuses the start rather than running unfenced when the hold cannot be written`
(write-side failure: asserts no hold file survives and the node id reads stale),
and `refuses rather than reusing a hold file it did not create`.

### Verification (round 3)

- `npx vitest run packages/cli packages/harness-driver packages/cloud` → 2295
  passed, 1 failed: the same pre-existing `local-agent.test.ts > message hold and
auto switch local broker delivery mode`. Re-confirmed pre-existing this round
  by stashing only this round's source and test changes and re-running that
  file: 68 passed / 1 failed either way.
- `npm run typecheck` → exit 0.
- `npm --prefix packages/cli run lint` → `103 problems (0 errors, 103 warnings)`,
  byte-identical to the count with this round's sources stashed — no warning
  delta (`runUpCommand`'s pre-existing complexity warning moves 107 → 106).
  `prettier --check` clean on every touched file.
- Mutation checks, each confirming the new coverage bites:
  - pid-equality exemption restored in `acquireNodeClaim`: **2 failures** (both
    recycled-pid tests).
  - `openNodeClaimHold` reverted to returning `undefined` on error:
    **3 failures** (both hold-failure unit tests and the `runUpCommand` one).

## Review round 4 (`REVIEW_VERDICT.json`) — how each blocker was closed

Both blockers were real, both are reproduced by tests that fail on the round-3
code, and neither needed a Rust change.

### [P1] A suspended acquisition could win beneath a spent generation

The reviewer's interleaving is exact, and it is the case the round-2 test
missed: that test left its successor **live**, so the suspended start was
refused by the successor's claim rather than by the generation number. When
every start that raised the number has _released_, the only thing above the
suspended start is a tombstone — and the post-create fence read
`currentGeneration()`, which skips tombstones by design because a tombstone
means "node id free".

So A (scan of an empty store, suspended in `buildClaim`) could wake up after
B took and released generation 1 and C took and released generation 2, re-create
generation 1 in the gap C's pruning left, see only a tombstone above it, and
declare itself the owner — while D, which had already read tombstone 2, went on
to create generation 3. Neither prune list names the other (each scanned before
the other's file existed), so both stayed live and both could spawn.

The fence is now on the highest generation **number** on disk, not the highest
live claim: `highestGenerationNumber(after) > generation` ⇒ this start cannot be
the owner, whatever that higher file holds. If the higher generation is a live
claim, that start won and this one refuses as before. If it is only a tombstone
(or an unreadable file), the node id itself is free but _this number_ is not ours
to hold, so the acquisition drops its own file and retries above the highest one
— which is what a start scanning that same tombstone would have picked in the
first place. The invariant is now statable without reference to what the higher
record contains: **only the highest generation number ever issued for a stem can
own the node id.**

New test: `refuses to win beneath a generation that was spent while this start
was suspended` drives the reviewer's sequence with both starts real and
suspended at their own await points (A inside `buildClaim` on an empty scan, D
inside `buildClaim` after reading tombstone 2), and asserts A wins only above
generation 2, D is refused, and exactly one live claim file exists. Restoring the
`currentGeneration()` fence fails it (A returns generation 1 and D wins 3).

### [P1] Startup-factory rejection released a claim while a fenced child lived

Also exact. `releaseNodeClaimAfterExit` consulted the pids it had captured and
the state dir's `connection.json`, and `onCandidateReady` cannot fire until
`createRelay` **resolves** — so a spawn that rejects after the fork (a handshake
that never completed, `waitForApiUrl`'s SIGTERM that the child outlived) left a
broker child that no captured pid names and that has published nothing. Release
then tombstoned the claim _and unlinked the hold file_, which is worse than
leaving it: removing the name is exactly what makes `inspectClaimHold` read "no
start holds this", so the next start saw a free node id while that child could
still register.

Fixed on both sides:

- **The release now consults the fence, not just the record.** `node-claim.ts`
  exports `inspectNodeClaimHold`, and `waitForClaimHoldRelease` in
  `broker-lifecycle.ts` polls it (bounded, `lsof` per attempt) before the
  connection-file check — the same order `classifyNodeClaim` uses, because the
  descriptor is the only evidence that covers a child's whole life. Holders are
  filtered exactly as a competing start filters them, so a release never frees a
  node id another start would still read as held. This process's own descriptor
  is excluded (it is dropped only after the release decision), by `deps.pid` and
  `process.pid` both, since a test supervisor pid may differ from the pid that
  actually holds the fd.
- **A rejecting spawn now reaps its child.** `HarnessDriverClient.spawn` wraps
  everything after the fork and calls the new
  `terminateFailedBrokerSpawn(child)`, which SIGTERMs and then escalates through
  `waitForExit`, so the exit is observed rather than assumed. This is the
  "ensure spawn failures return/clean up the child with verified exit" half; the
  fence above is what makes ownership correct when even that cannot succeed.

New tests: `keeps the claim when the spawn rejects with a fenced child still
alive` drives the real `runUpCommand` with a factory that spawns a real child on
the real inherited descriptor and then rejects, with real `lsof`/`ps` behind the
probe — asserting the claim _and_ its hold file survive; `reaps the broker child
when startup never reports an API port` drives the real
`HarnessDriverClient.spawn` against a broker stand-in that never announces a
port and asserts the child is gone, not merely signalled; plus four unit tests
for `terminateFailedBrokerSpawn`.

### Verification (round 4)

- `npx vitest run packages/cli packages/harness-driver packages/cloud` → 2302
  passed, 1 failed: the same pre-existing `local-agent.test.ts > message hold and
auto switch local broker delivery mode`. Re-confirmed pre-existing this round
  by stashing only this round's source and test changes and re-running that
  file: 68 passed / 1 failed either way.
- `npm run typecheck` → exit 0. `npm --prefix packages/harness-driver run check`
  → exit 0.
- `npm --prefix packages/cli run lint` → `103 problems (0 errors, 103 warnings)`,
  the same count as round 3, and `runUpCommand`'s pre-existing complexity
  warning is unchanged at 106 (this round's logic lives in
  `releaseNodeClaimAfterExit` and `waitForClaimHoldRelease`). `node-claim.ts`
  reports no warnings. `prettier --check` clean on every touched file.
- Mutation checks, each confirming the new coverage bites:
  - post-create fence reverted to `currentGeneration()`: **1 failure** (the new
    spent-generation interleaving).
  - `waitForClaimHoldRelease` dropped from `releaseNodeClaimAfterExit`:
    **1 failure** — and it fails by releasing the claim, i.e. reproducing the
    blocker.
  - `terminateFailedBrokerSpawn` not called on a spawn rejection: **1 failure**
    (the child survives the unobserved SIGTERM).
- Round-2 tombstone mutation re-run (release → `unlink`): **3 failures** now,
  the two generation-reuse tests plus the new one.

### Not addressed, and why

The verdict's closing note reports that `origin/main` has two commits this
branch does not (#1799 and #1800), so the direct diff carries
standalone-surface/test changes none of the five CLI guard commits authored.
That is a base reconciliation (rebase or merge), not a code defect, and it is
listed in `notes` rather than `blocking` — it is left for whoever lands this, in
line with the "do not push" scope of this round.

## Review round 5 (`REVIEW_VERDICT.json`) — how the blocker was closed

The single blocker was real, is reproduced by two tests that fail on the round-4
code, and needed no Rust change.

### [P2] A supported custom broker executable bypassed the orphan fence

Exact, and it is the last place a **name** was allowed to decide ownership.
`looksLikeBrokerProcess` recognised a process only if its `ps -o args=` output
contained `agent-relay`, `relay-broker`, or the claim's complete state dir. But
`AGENT_RELAY_BIN` / `BROKER_BINARY_PATH` accept any executable path
(`packages/harness-driver/src/broker-path.ts`), and a start using the default
state dir is not passed `--state-dir` at all
(`createDefaultRelay`, `commands/core.ts`) — so a perfectly normal broker
installed as, say, `/opt/custom/broker` matched none of the three. Orphaned by a
supervisor that died before adoption, it was classified as an unrelated process:
`inspectClaimHold` discarded it, the `connection.json` fallback discarded it for
the same reason, the node id read **stale**, and the next start took it and
displaced the delivery socket of a live broker. Exactly the incident this branch
exists to close, reachable through a supported configuration.

**Ownership is now established by executable identity, and names are only ever
positive evidence.** A reservation records what it is about to run —
`broker_binary` (resolved path) and `broker_executable` (`0x<dev>:<inode>` of
that file) — before it spawns anything, so the evidence exists for the whole
life of the orphan, exactly like the hold descriptor it accompanies.
`classifyHolderProcess` then answers one of three things about a live process:

- `broker` — its `lsof -d txt` mappings include the recorded executable object,
  its argv is that binary, its argv still carries `agent-relay`/`relay-broker`/
  the state dir, **or** `ps`/`lsof` could not be consulted at all. Command lines
  are consulted only to say yes, never to say no.
- `unrelated` — the claim had something to compare against and nothing matched.
- `unidentified` — the claim records no executable (written by an older CLI, or
  by a start that could not resolve a broker binary), so the process is neither
  confirmed nor ruled out.

The two call sites part company on `unidentified`, because they differ in what
an unknown process is likely to be. A hold descriptor is only ever inherited
from a Relay start, so an unclassifiable holder **keeps** the node id guarded. A
pid read out of `connection.json` can have been recycled by anything on the
machine with no relationship to Relay, so only a positive identification guards
there — which is also what keeps the round-2 behaviour (an unrelated program
holding a recycled pid frees nothing) intact.

New tests: `holds a node whose broker runs under an operator-chosen executable
name` (real inherited descriptor, real `lsof`, a real executable under a
non-Relay filename, argv carrying neither marker — asserts `held` and that a
second `acquireNodeClaim` is refused), `finds a published broker running under
an operator-chosen executable name` (the same broker one step later, through
`connection.json`), `keeps guarding a claim that records no broker executable at
all` (the `unidentified` path), and — over the real `runUpCommand` — `records the
executable it will run as the broker, whatever that file is named`. The existing
`does not let an unrelated process that inherited the descriptor pin the node`
now runs against a claim that records a different executable, so ruling that
holder out is a determination rather than a guess about its filename.

### Verification (round 5)

- `npx vitest run packages/cli packages/harness-driver` → 1869 passed, 1 failed:
  the same pre-existing `local-agent.test.ts > message hold and auto switch local
broker delivery mode`. Re-confirmed pre-existing this round by stashing only
  this round's source and test changes and re-running that file: 68 passed / 1
  failed either way. `local-agent.ts` and its test are untouched by every commit
  on this branch.
- `npm run typecheck` → exit 0.
- `npm --prefix packages/cli run lint` → `103 problems (0 errors, 103 warnings)`,
  the same count as rounds 3 and 4; `node-claim.ts` reports no warnings.
  `prettier --check` clean on every touched file.
- Mutation check: with the executable-object comparison and the recorded-binary
  argv match both disabled — i.e. the round-4 name test — **2 failures**, both
  of the new custom-executable tests, and they fail by reading the node id as
  free while a live holder exists. That is the blocker, reproduced.

## Review round 6 (`REVIEW_VERDICT.json`) — how the blocker was closed

The single blocker was real, is reproduced by two tests that fail on the round-5
code, and needed no Rust change.

### [P2] A live startup launcher was discarded while it held the fence

Exact, and it is the same class of bug as round 5 one layer down: what round 5
fixed was ownership decided by a **name**, and what remained was ownership
decided by a file identity recorded **before** the spawn — which is not always
the file the running process maps.

`AGENT_RELAY_BIN` / `BROKER_BINARY_PATH` accept any executable, and the ordinary
shape of a custom install is a launcher: a shell script that sets something up
and runs the real binary. The claim recorded that script's device and inode
before spawning it, but the kernel never runs the script — it runs the
interpreter from the `#!` line, so `lsof -d txt` reports `/bin/sh` and `ps`
reports `/bin/sh <launcher>`, which also failed the `startsWith(binary)` test.
One `exec` later the process maps the real broker binary and argv no longer
mentions the launcher at all. With the supervisor gone and `connection.json` not
yet published, `classifyHolderProcess` returned `unrelated`, `inspectClaimHold`
dropped the live holder, `inspectNodeClaim` read **stale**, and the next
`acquireNodeClaim` won generation 2 and pruned the original fence — reopening the
double-registration/socket-eviction failure this branch exists to close. The
round-5 tests missed it because their custom executable is a symlink, whose
inode is the one the claim recorded.

Reproduced first, before anything was changed, with a real shell launcher, a
real inherited descriptor and real `lsof`/`ps`: both shapes read `stale` while
the launcher was alive and holding the descriptor. The recorded object was
`0x38:5228190` (the script) against `0x1f:7354` (`/bin/sh`) reported by `lsof`.

**Two further pieces of positive evidence close it, and nothing became a reason
to rule a process OUT.** They are deliberately redundant, because they fail in
different places:

- **The recorded executable, found in argv where an interpreter puts it**
  (`runsRecordedExecutable`). A shebang launcher does not run the file the claim
  recorded, but the kernel passes that file as an argument, so it is right there
  in `argv[1]`. Only the first two arguments are considered — `argv[0]` is the
  program and `argv[1]` is where an interpreter puts its script; anything later
  is a broker's own argument and proves nothing. The token is compared by
  `stat`ting it and matching device/inode, not by string equality, so a
  symlinked install path still matches, for the same reason the claim records an
  inode rather than a name. This needs nothing recorded after the spawn, so it
  has **no window at all** — which is why it is here even though the pid below
  also covers this case.
- **The pid of the child this start spawned** (`broker_child_pid`,
  `recordSpawnedBrokerChild`). Nothing recorded before a spawn can describe a
  process that has `exec`d into a different executable — but `execve` preserves
  the pid. The supervisor writes it in the same turn `spawn()` returns it:
  `HarnessDriverClient.spawn` calls the new `onSpawn` as the first statement
  after `spawn()` and before any `await`, plumbed through `createRelay` /
  `startBrokerWithPortFallback` alongside the `inheritFds` this fences. The
  write is a synchronous rewrite of this start's OWN generation, conditional on
  `owner_token` still matching, with no `await` between the read and the write —
  a `--force` takeover that landed during the spawn keeps its record untouched,
  and this start fails at adoption on the same evidence.

The pid is used only on the hold-descriptor path, never in
`findLiveStateDirBroker`. A holder of that descriptor can only have inherited it
from a Relay start, so a pid number there cannot have been recycled by something
unrelated; a pid read out of `connection.json` can have been, which is round 2's
finding and stays exactly as it was. It is also positive evidence about **one**
process, not a blanket exemption: a harness the broker left behind inherits the
same descriptor and is still dropped.

The release path is unaffected: `releaseNodeClaimAfterExit` waits for every
protected pid — `spawnedBrokerPids` now includes the pid from the spawn itself —
to be observed gone _before_ it consults the fence, so the recorded child pid is
already dead by the time this evidence could be read.

New tests: `holds a node whose broker is started through a launcher script`
(real launcher, real inherited descriptor, real `lsof`/`ps`, default state dir
so argv carries no Relay marker — asserts `held` and that a second
`acquireNodeClaim` is refused), `holds a node whose launcher has already exec'd
the real broker` (the same start one `exec` later, with `connection.json`
asserted absent — the supervisor-loss-before-publication case the verdict asked
for), `still frees a node whose recorded child is gone and only a helper holds
the fence` (the pid is not a blanket exemption), `leaves a takeover's claim alone
when recording a spawned child`, `records the broker child it spawned before the
handshake completes` (over the real `runUpCommand`: on disk while the claim is
still `reserved`, and carried through adoption), and
`reports the child's pid the moment it is spawned, before the handshake`
(over the real `HarnessDriverClient.spawn`, whose fixture broker is itself a
shell script that `exec`s — `$$` before the exec is the pid after it).

### Verification (round 6)

- `npx vitest run packages/cli packages/harness-driver` → 1875 passed, 1 failed:
  the same pre-existing `local-agent.test.ts > message hold and auto switch local
broker delivery mode`. Re-confirmed pre-existing this round by stashing every
  source and test change under `packages/` and re-running that file: 68 passed /
  1 failed either way.
- `npm run typecheck` → exit 0.
- `npm --prefix packages/cli run lint` → `103 problems (0 errors, 103 warnings)`,
  the same count as rounds 3-5; `node-claim.ts` reports no warnings (the argv
  and executable-object probes were extracted into `argvIdentifiesBroker` and
  `mapsRecordedExecutable` to keep `classifyHolderProcess` under the complexity
  ceiling). `prettier --check` clean on every touched file.
- Mutation checks, each confirming the new coverage bites:
  - both new evidence paths disabled: **2 failures**, the two launcher tests,
    failing by reading the node id as free while a live holder exists — the
    blocker, reproduced.
  - `runsRecordedExecutable` alone disabled: **1 failure**, the pre-exec
    launcher test.
  - the `broker_child_pid` comparison alone disabled: **1 failure**, the
    post-`exec` launcher test.
  - `recordSpawnedBrokerChild` dropped from the `runUpCommand` spawn callback:
    **1 failure**.

### Not addressed, and why

- **`origin/main` has 2 commits this branch does not** (the verdict's `notes`,
  not a blocking item). Left alone: reconciling the base is a rebase/merge
  decision for whoever lands this, and the direct diff's unrelated
  standalone-product removals are an artifact of that gap, not of this work.
- **Nits and the Rust delivery lane.** No Rust source changed this round; the
  verdict's observation that this CLI lane does not by itself prove
  exactly-once delivery is still true and still out of this branch's scope.

## Review round 7 (`REVIEW_VERDICT.json`) — how each blocker was closed

Both blockers were real, both are reproduced by tests that fail on the round-6
code, and neither needed a Rust change.

### [P1] Launcher crash safety still rested on a post-spawn pid publication

Exact. Round 6 answered the exec'd-launcher case with `broker_child_pid`,
written "in the same turn `spawn()` returns" — but no `await` is not atomicity.
A supervisor SIGKILLed between the fork and that write leaves a claim that can
never identify its own broker: the recorded executable is the launcher script,
which the running process stopped mapping the moment it `exec`d, its argv no
longer names the launcher, `connection.json` does not exist yet, and there is no
pid on the record to compare against. `classifyHolderProcess` returned
`unrelated`, `inspectClaimHold` dropped the one live holder of the node's fence,
`inspectNodeClaim` read **stale**, and a non-force second acquisition won
generation 2 and pruned the original hold file — the double
registration/socket eviction this branch exists to close, reachable through a
supported custom install.

The fix is to stop treating an unmatched holder as a determination when the
claim has no way to make one. **Ruling a holder out now needs both halves of
the evidence: the holder identified as some other executable, AND a claim that
durably recorded the child it spawned.** `broker_child_pid` is the only thing
that survives an `exec`, so until it is on disk every holder of that
generation's descriptor keeps the node guarded, exactly as an unclassifiable
holder already did (round 5's `unidentified`). Nothing but a Relay start ever
passes this descriptor on, and the bias is the module's usual one: a refusal
costs one `--force`, a wrong "free" verdict costs deliveries. The pid is still
never consulted on the `connection.json` path, where it could have been
recycled by anything (round 2).

This is a strict widening of the fence, so `--force`, `node down` and every
stale-claim path are untouched, and a claim that _does_ record its child still
drops an unrelated inheritor.

New test: `holds a node whose supervisor died before it could record the child
it spawned` — a real shell launcher that `exec`s a real binary under a non-Relay
name, a real inherited descriptor, real `lsof`/`ps`, `recordSpawnedBrokerChild`
never called, and `connection.json` asserted absent. It asserts the claim reads
`held`, names the live child's pid, refuses a second `acquireNodeClaim`, and
that the original hold file is still there afterwards. Dropping the new
condition fails it, by reading the node id as free while the broker holds it.

The existing `does not let an unrelated process that inherited the descriptor
pin the node` now records a (dead) spawned child first, which is what a
supervisor that lived long enough for its broker to spawn a harness would have
done — so it goes on pinning the same behaviour through a claim that can
actually make the determination.

### [P1] An explicit `RELAY_NODE_ID` bypassed both guards with no cached token

Also exact, and the premise the round-1 gate rested on — "this broker cannot
authenticate, so it cannot evict" — is simply false. `init.rs:903-905` preserves
an explicit id, `init.rs:356-364` wires a workspace-key `NodeTokenMinter`, and
`node_control.rs` mints and connects with nothing cached, requesting that same
node id. So a start carrying `RELAY_NODE_ID` and ordinary workspace credentials
— the shape you get when the original broker was handed an env token, which is
never persisted — claimed nothing, guarded nothing, and took the node.

`enrolledNodeIdForClaim` no longer tries to predict the broker's credential
route. **An explicit `RELAY_NODE_ID` is the identity that registers, and it is
claimed on that basis alone.** Enumerating routes (env token, cached token,
workspace mint, …) just moves the hole to the next route added; the identity is
the thing that evicts. `--local-only` registers nothing and is excluded by the
callers, as before.

The cost is a start that genuinely could not have registered — no token, no
workspace key, nothing to mint with — being refused when another broker really
does hold that id. That is one `--force`, and that start was headed for
local-only operation anyway. The whole cached-token probe
(`hasCachedNodeToken`, `nodeTokenCachePaths`, `nodeTokenCacheDirs`, and the
`sanitize_node_id_for_filename` mirror) is deleted with it: it was a partial
enumeration of exactly the thing this stops guessing at.

New tests: `guards an explicit node id the broker can mint its own token for`
and `guards an explicit node id even when the CLI can see no credential at all`
(unit), `guards a node id the broker would mint its own token for` over the real
`node up` preflight with a real claim store, and `claims a node id the broker
would mint its own token for` over the real `runUpCommand` reservation — the
acquisition backstop that is the only guard `up` / `local up` have. Restoring an
env-token gate fails all four.

### Verification (round 7)

- `npx vitest run packages/cli packages/harness-driver` → 1876 passed, 1 failed:
  the same pre-existing `local-agent.test.ts > message hold and auto switch local
broker delivery mode`. Re-confirmed pre-existing this round by stashing every
  change under `packages/` and re-running that file: 68 passed / 1 failed either
  way.
- `npm run typecheck` → exit 0.
- `npm --prefix packages/cli run lint` → `103 problems (0 errors, 103 warnings)`,
  the same count as rounds 3-6; `node-claim.ts` reports no warnings.
  `prettier --check` clean on every touched file.
- Mutation checks, each confirming the new coverage bites:
  - the unestablished-child retention dropped from `inspectClaimHold`:
    **1 failure**, the new launcher/publication-window test, failing by reading
    the node id as free while a live holder exists — the blocker, reproduced.
  - `enrolledNodeIdForClaim` re-gated on `RELAY_NODE_TOKEN`: **4 failures**, the
    two unit cases plus the `node up` and `runUpCommand` ones.

### Not addressed, and why

- **`origin/main` has 2 commits this branch does not.** Unchanged from round 4:
  reconciling the base is a rebase/merge decision for whoever lands this, and the
  direct diff's unrelated standalone-product removals are an artifact of that
  gap.
- **The Rust delivery lane.** No Rust source changed this round. The verdict's
  standing observation that this CLI lane does not by itself establish
  exactly-once delivery (`runtime/fleet.rs` still allows replay of a
  landed-but-unacknowledged delivery after restart) remains true and remains out
  of this branch's scope.

## Remaining risks

- **A shutdown can now decline to release its own claim** (round 4). If anything
  broker-shaped still holds the generation's hold descriptor — or `lsof` cannot
  answer — the claim is kept and the warning names
  `node down --state-dir <dir> --force`. That is the same bias as every other
  check here (a retained claim is recoverable, a freed one that a live child can
  still register under is the outage), and the holder filter keeps an unrelated
  process that inherited the descriptor from pinning the node. The cost is that a
  child which survives its own supervisor leaves a claim an operator has to clear
  — which is correct, because that child may be registered.
- **A start now fails outright if it cannot open its hold file** (round 3). This
  is deliberate — the alternative is a broker running under a guarantee that is
  not in force — but it does mean an unwritable or full claims directory stops
  `node up` for an enrolled node rather than degrading. The same directory has
  to be writable for the claim itself, so this adds no new dependency, only a
  new way to surface it.
- **The spawn-to-publication fence depends on `lsof`.** Holders of a hold file
  are read with `lsof -t`, and an `lsof` that cannot answer reads as _held_ —
  the same bias as the rest of the module, and `node up` already refuses to
  start at all without a usable `lsof` (it is how broker process identity is
  verified). The cost is that on a machine where `lsof` breaks, a hold file left
  by an unclean stop blocks that node id until `node up --force` or `node down`.
  A clean stop removes it with the claim.
- **The fence covers brokers this CLI spawns.** A broker started some other way
  — a raw `agent-relay-broker` invocation, or a pre-existing one that
  `preferConnect` reuses — inherits no descriptor. Neither is the
  spawn-to-publication window: a reused broker has already published, and a
  hand-started one was never fenced by a reservation to begin with.
- **Executable identity is recorded, not verified against the child** (was a
  risk in round 5; closed in rounds 6 and 7). The claim still records the binary
  the supervising CLI _resolved_, which is not what the process maps once a
  launcher script runs as its interpreter and then `exec`s the real broker — but
  that holder is identified anyway, by the recorded file appearing in argv where
  an interpreter puts it and by the child pid the start records at the spawn,
  which `execve` preserves. The window round 6 left — a start killed in the few
  syscalls between `spawn()` returning and that pid reaching disk, whose child
  has ALSO already `exec`d — is closed in round 7 by not ruling any holder out
  until that pid is on disk. What remains is not a safety gap but its price: in
  that window the node id is guarded by _anything_ holding the descriptor.
- **The spawned child pid is recorded on a best-effort write.** If the claims
  directory cannot be written at that instant, `recordSpawnedBrokerChild`
  returns the claim unchanged rather than failing the start — unlike the hold
  file, whose absence does stop a start (below). The fence is already in force
  by then (the descriptor was inherited at the spawn), and since round 7 the
  cost of losing the pid is a node id that stays guarded rather than one that
  can be taken: without it no holder of that descriptor can be ruled out, so an
  unrelated process that inherited it pins the node until `--force` or
  `node down`. Erring that way is the point; the same directory has to be
  writable for the claim itself, so a failure here means the start has already
  failed for a louder reason.
- **Cross-machine enrollment reuse is still unguarded** (explicitly out of
  scope). Two hosts sharing `~/.agentworkforce/relay` (synced home, NFS, a
  restored backup) will both claim the same node id, and neither can evaluate the
  other's pid. A real fix needs a host id in the claim plus a lease/heartbeat, or
  server-side single-registration enforcement in the engine.
- **The window between `fork` and the broker's `connection.json` write is
  closed** (was a risk; closed in round 2) by a hold descriptor the broker child
  inherits at spawn. It does still depend on `lsof`, which `node up` already
  requires for broker identity verification — see the new risk below.
- **`node down --all` does not release claims.** It kills processes by `ps`
  matching and never resolves pids to state dirs; the claims it leaves behind are
  stale (dead pids) so they do not block a later start, but they linger on disk.
- **Generation numbers are never reused** (was a risk; closed in round 2). A
  release retires its number with a tombstone instead of removing the file, so
  `max(generation)` never falls back and no suspended start can re-create a
  number that has been reissued.
- **Filename sanitization can collide.** Claims are stored under a sanitized node
  id (`[^\w.-]` → `-`, truncated to 96 chars). Two node ids that sanitize to the
  same stem share a series; that is reported as a conflict (refuse, with
  `--force` available) rather than silently overwriting the other broker's claim.
  Engine-issued ids (`node_<digits>`) never collide.
- **Two different identity questions, answered differently.** "Is this pid still
  the process the claim recorded?" is answered by `ps -o lstart` alone: the claim
  never authorizes a signal, only a refusal, so a birth time is enough to tell a
  rapid restart from a recycled pid. "Is this process the broker at all?" is
  answered by executable identity — the device and inode of its `txt` mapping
  against the broker binary the claim recorded (round 5), the same handle
  `broker-process-identity.ts` uses. A claim written by an older CLI records no
  binary; a live holder of such a claim's hold descriptor is retained rather than
  classified, which costs a refusal instead of an outage.
- **Every explicit `RELAY_NODE_ID` is claimed, credential or not** (round 7).
  The CLI no longer predicts whether the broker will authenticate as the id it
  was handed, because every route it could enumerate ends in the same
  registration and the one it missed was the bypass. A start that could not have
  registered at all is therefore refused when another broker holds that id,
  which costs one `--force`. The cached-token probe that used to make this
  determination is gone.
- **Drift between the claim dir and the enrollment store.** `node-claim.ts`
  resolves `AGENT_RELAY_HOME` itself instead of importing `cloudHome` from
  `@agent-relay/cloud`: that barrel pulls in the Cloud SSH runtime, which breaks
  the `node:child_process` module mocks in `doctor.test.ts` and is far too heavy
  for a guard. `node-claim.test.ts` pins `nodeClaimsDir()` to
  `dirname(fleetNodeEnrollmentStorePath())` so the duplication cannot drift
  unnoticed.
