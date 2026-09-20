# Fresh-eyes adversarial review, round 1 — phase 0 (seam)

Reviewer: Claude (Opus 5). Read-only; no product code edited.
Branch `feat/native-delivery-phase-0-seam`, **working tree** (nothing under review is committed).
Every claim below was re-derived from the files. I did not adopt any conclusion from
`reviews/shadow-rust.md`; where I reach the same place I say so, and two of that review's
findings (F1, F2) describe a tree that has since changed and are **stale** — see Appendix A.

## What I read and ran

Read in full: the working-tree diff for all 16 modified files plus the 4 untracked additions;
`phase-contract.json`; `docs/native-delivery-migration.md`; `reviews/shadow-rust.md`; all 22
`evidence/*.json`; `evidence/mutation-proof.md`; `gate-log.txt`; `seal-implementation.json`;
`changed-files.json`. Also the call graph the seam was spliced into: `worker.rs:1454-1569`,
`runtime/worker_events.rs:620-980`, `runtime/maintenance.rs:154-205, 825`,
`runtime/fleet.rs:1782-1830, 1975-1995`, `pty_worker.rs:1150-1190, 1655-1712, 2060-2300`,
`scripts/migrate/native-delivery-gates.mjs:70-120, 330-400, 700-760`.

Ran (`CARGO_HOME=/tmp/relay-native-delivery-cargo-home`, `--offline`):

- `cargo check -p agent-relay-broker --all-targets` → **exit 0**. The tree compiles.
- `cargo test -p agent-relay-broker --lib` → **exit 1, 2 failed, 1280 passed**. Transcript in F2.

Not run: the parity suite and `tests/e2e/unlaunched` (they launch real CLIs; the doc's
testing-hazard section, doc:311-319, forbids it here). The phase exit "parity suite green,
unchanged" is therefore **not verified by me** — but see F6, which is about that gate's
own integrity and does not require running it.

## Verdict

**Do not seal.** Two independent blockers, either of which is disqualifying on its own:

1. A mutation probe is still in shipping product code, on the live app-server delivery
   path, and it can panic the broker (F1).
2. The sealed tree has never been compiled or tested. Every Rust and TypeScript evidence
   artifact in the set predates the last edits to the files it claims to cover, and the
   suite is in fact **red**, including a test the repo labels `MUST-FIRE (P1, blocker)`
   for relay#1543 (F2).

Beneath those, the seam's own contract is weaker than it reads: the coordinator is
rebuilt per call so three of the four invariants have no production effect (F4); the PTY
adapter stopped observing whether its write landed, which both broke the two tests and
made the PTY route incapable of dead-lettering (F3); echo verification was widened in a
way that can manufacture the acknowledgement rule 4 forbids (F5); and the gate that is the
phase's only exit criterion had both its timeouts and its measured product behaviour
changed in the same session it went green (F6).

---

# Findings

Ranked by severity. Each gives file:line, the failure, and the exact repair.

---

## F1 — BLOCKER. A mutation probe ships in product code, on a live delivery path, and can panic the broker

**Evidence:** `crates/broker/src/runtime/app_server.rs:279-282`

```rust
    // MUTATION: drop the addressee and truncate the body.
    if std::env::var("RELAY_MUTATION_LOSSY_FORMAT").is_ok() {
        return format!("Relay message from {}:\n\n{}", delivery.from, &delivery.body[..1]);
    }
```

`format_app_server_delivery` is not a test helper. It is called at
`crates/broker/src/runtime/app_server.rs:118`, on the app-server (opencode HTTP) delivery
path — the one route in this repo that already reaches a session relay did not launch, and
the exact route `tests/e2e/unlaunched/unlaunched-delivery.test.ts:170-173` asserts against.
The probe was evidently used to prove that test bites, and then left in.

Three separate defects:

1. **It ships.** `std::env::var` is read on every app-server delivery. Anything that sets
   `RELAY_MUTATION_LOSSY_FORMAT` in the broker's environment — a stray export, a CI matrix
   cell, a `.env` — silently truncates every message to one byte and drops the addressee.
2. **It panics.** `&delivery.body[..1]` is a byte slice on a `String`. It panics on an
   **empty body**, and it panics on any body whose first character is multi-byte UTF-8 —
   including the `✅` that this diff's own payload-fidelity case sends
   (`tests/fixtures/delivery-contract-evals.test.ts:239`). A panic here is inside the
   broker's delivery task.
3. **No gate saw it.** `app_server.rs` is absent from `changed-files.json` (F7), so
   `edit-gate`, `manifest-gate` and `targeted-gate` all ran against a file set that does
   not contain it. It is also outside `phase-contract.json`'s declared `scope`.

**Failure scenario:** broker runs with `RELAY_MUTATION_LOSSY_FORMAT` set for any reason;
`send_dm` to an app-server agent with an empty body, or a body starting with any non-ASCII
character, panics the delivery task at `app_server.rs:281`. Without the variable set, every
app-server delivery pays an `env::var` lookup for dead code that a reader will reasonably
mistake for a supported feature flag.

**Repair:** delete lines 279-282 verbatim. If a mutation probe must be re-applied later,
apply it, run the test, and `git checkout` the file — the way
`evidence/mutation-proof.md` says the four `backend.rs` mutations were handled ("the
mutation was restored before the next run"). Then re-run the unlaunched test to confirm it
still fails without the probe, and record that transcript.

---

## F2 — BLOCKER. The sealed tree is red, and every piece of evidence predates the code it certifies

**Evidence (a): the suite fails.** `cargo test -p agent-relay-broker --lib`, run by me on the
current working tree:

```text
failures:

---- runtime::tests::delivery_retry_transient_blip_stays_retryable_for_present_worker stdout ----
thread '...' panicked at crates/broker/src/runtime/tests.rs:3269:5:
assertion `left == right` failed
  left: Attempted { worker_name: WorkerName("worker-blip"), attempts: 1, event_id: EventId("evt_blip") }
 right: Noop

---- runtime::tests::timed_out_initial_handoff_still_registers_its_withheld_fleet_ack stdout ----
thread '...' panicked at crates/broker/src/runtime/tests.rs:2101:5:
a handoff that never completes must time out, not hang forever

failures:
    runtime::tests::delivery_retry_transient_blip_stays_retryable_for_present_worker
    runtime::tests::timed_out_initial_handoff_still_registers_its_withheld_fleet_ack

test result: FAILED. 1280 passed; 2 failed; 5 ignored; 0 measured; 0 filtered out
```

The second one is not an ordinary test. `crates/broker/src/runtime/tests.rs:2066-2075`
labels it:

> `relay#1543 delivery.rs:588 MUST-FIRE (P1, blocker)`

**Evidence (b): the evidence is older than the code.** Compare `evidence/*.json` `startedAt`
(UTC) against file mtimes (local PDT = UTC-7):

| Artifact | `startedAt` (UTC) | Verdict |
| --- | --- | --- |
| `rust-clippy.json` | 17:12:48Z | green |
| `rust-build.json` | 17:13:10Z | green |
| `invariant-tests.json` (`cargo test -p agent-relay-broker`) | 17:14:34Z | green |
| `rust-fmt.json` | 17:15:27Z | green |
| `ts-typecheck.json` | 18:07:41Z | green |

| File edited after those runs | mtime (UTC) |
| --- | --- |
| `crates/broker/src/delivery/pty.rs` | **18:18:17Z** |
| `crates/broker/src/pty_worker.rs` | **18:25:10Z** |
| `crates/broker/src/broker/delivery_verification.rs` | **18:28:58Z** |
| `tests/e2e/unlaunched/session-host.ts` | **19:01:12Z** |
| `tests/e2e/unlaunched/unlaunched-delivery.test.ts` | **19:04:59Z** |
| `crates/broker/src/runtime/app_server.rs` | **19:09:43Z** |

`gate-log.txt` has no `rust-build` / `invariant-tests` / `ts-typecheck` line after
17:16:29Z. The seal was taken at 19:11:59Z. So:

- The seam's own adapter (`pty.rs`) was rewritten **after** the last `cargo test`.
- Two brand-new unit tests — `check_echo_normalizes_terminal_crlf`
  (`delivery_verification.rs:353-359`) and `cat_harness_defaults_to_bulk_injection`
  (`pty_worker.rs:2892-2899`) — were added after the last `cargo test` and have no
  execution record in the artifact set. (I ran them; both pass.)
- The two new TypeScript files were added after the last `tsc` run.
- F1's mutation probe was added **2 minutes 16 seconds before the seal**, after everything.

**Evidence (c): the seal cannot detect this.** `seal-implementation.json` hashes 33 entries,
**all of them inside `.workflow-artifacts/`** — `branch.txt`, `changed-files.json`,
`context.json`, `evidence/*`, `gate-log.txt`, `phase-contract.json`, `recent-commits.txt`,
`reviews/shadow-rust.md`, `targeted-plan.json`. Not one `crates/` or `tests/` path. Its
`headSha` is `01292d184`, a commit that contains **none** of the code under review (the
whole change is uncommitted). The seal attests to the paperwork, not the work.

**Failure scenario:** the phase is sealed and handed to phase 1 as "parity green, four
invariants proven". A phase-1 agent branching from it inherits a broker whose test suite is
red, including relay#1543's blocker regression, and has no way to tell which of its own
changes caused it.

**Repair:**
1. Fix F3 (the cause of both failures), then re-run `cargo fmt --check`,
   `cargo clippy -p agent-relay-broker --all-targets`,
   `cargo test -p agent-relay-broker`, and `npm run typecheck`, and replace the stale
   evidence files.
2. Make the seal cover the product tree: hash every path in `changed-files.json`, not just
   the artifact directory, and fail the seal if any of them has an mtime newer than the
   newest gate that claims to cover it.

---

## F3 — HIGH. The PTY adapter stopped observing its write, so a dead writer now reads as a successful delivery attempt and the PTY route can never dead-letter

**Evidence:** `crates/broker/src/delivery/pty.rs:50-57`

```rust
            self.workers
                .try_send_to_worker(worker_name.as_str(), "deliver_relay", None, payload)
                .map_err(|error| DeliveryError::unavailable(error.to_string()))?;
            Ok(SendStatus::HandedOver(HandoverState::HandedOver))
```

`retry_pending_delivery` previously called `WorkerRegistry::deliver`
(`crates/broker/src/worker.rs:1554-1569`) → `send_to_worker`
(`worker.rs:1454-1496`), which **awaits the writer's completion oneshot**
(`worker.rs:1486-1493`) and returns `Err("failed writing frame to worker '<name>'")` when
the write actually fails. `try_send_to_worker` (`worker.rs:1525-1552`) resolves the moment
the frame is accepted into the bounded `command_tx` channel and passes `completion: None`.
It can only fail on `unknown worker`, an encode error, `TrySendError::Full`, or
`TrySendError::Closed` — all strictly pre-admission.

Three consequences:

1. **A wedged PTY reads as progress.** `runtime/delivery.rs:1010-1015` takes the `Ok(_)`
   arm: `attempts += 1`, **`failed_attempts = 0`**, **`last_error = None`**. That is the
   broker recording a successful handoff for a write that cannot land. It is the same
   shape as the fabrication the seam's rule 4 forbids, one layer down.
2. **The PTY route can no longer terminate.** `failed_attempts` is reset to 0 on every
   `Ok(_)`, and `Ok(_)` is now the overwhelmingly common outcome, so the retry-cap guard at
   `runtime/delivery.rs:968` (`failed_attempts >= MAX_DELIVERY_RETRIES`) is effectively
   unreachable via this path. The only surviving terminal disposition is
   `!workers.has_worker` → "recipient gone" (`:979-985`), a pre-write condition.
3. **`retry_pending_delivery` no longer awaits the write, so the retry clock starts
   earlier.** `next_retry_at = now + delivery_ack_timeout` (`:1013-1014`) is now set at
   queue admission rather than at write completion. For `Steer` mode the budget is
   `VERIFICATION_WINDOW` = 5s (`broker/delivery_verification.rs:102`); a paced injection at
   the 5 ms default (`pty_worker.rs:65`) over a few hundred atoms can exceed that. The real
   gap between a write and its resend shrinks by the duration of the write. The worker-side
   duplicate filter (`pty_worker.rs:1165`, `pending_worker_delivery_ids.insert`) still
   covers this **only while the worker holds the id pending**; it removes the id at
   `:1708`, `:2198` and `:2298`, so a resend that arrives after the worker resolved the
   delivery is injected again.

**Failure scenario (proven, not hypothesised):** `delivery_retry_transient_blip_...`
(`runtime/tests.rs:3219-3234`) kills the worker's child while keeping the handle
registered. Before this edit the write failed and the delivery stayed queued with
`failed_attempts = 1`. Now the frame is queued to a dead pipe and the broker reports
`Attempted { attempts: 1 }` with `failed_attempts = 0` and `last_error = None`. Same cause
for `timed_out_initial_handoff_still_registers_its_withheld_fleet_ack`
(`runtime/tests.rs:2077-2101`): `try_inject_pending_relay_message`'s
`timeout(retry_interval, …)` (`runtime/delivery.rs:751`) no longer has anything slow to
time out, so a handoff into a **stalled** worker returns `Ok` where relay#1543 requires
`Err`.

**Repair:** do not trade the completion observation for the pre-write/post-write
distinction — get both. Give `WorkerRegistry::deliver` a typed error that distinguishes
pre-admission failures (unknown worker, encode, queue full/closed, queue timeout) from
post-admission ones (writer reported a failed write, completion channel dropped), keep
`retry_pending_delivery` on the awaited `deliver`, and map only the post-admission variant
to `DeliveryError::committed`. If the fire-and-forget shape is genuinely wanted, then
`WorkerEvent::WriterFailed` (`worker.rs:336`, handled at `runtime/worker_events.rs:631`)
must feed the pending delivery's failure budget, and the comment at `pty.rs:52-55` that
asserts this already happens must be made true. Do not fix either red test by editing its
assertion.

---

## F4 — HIGH. The `DeliverySeam` is constructed per call and dropped, so three of the four contract invariants have no production effect

**Evidence:** `crates/broker/src/runtime/delivery.rs:997-999`

```rust
    let mut seam = crate::delivery::DeliverySeam::new();
    let mut pty_backend = crate::delivery::pty::PtyDeliveryBackend::new(workers);
```

Both are locals of `retry_pending_delivery` and die with it. `DeliverySeam`'s entire state
is `receipts: VecDeque<SendReceipt>` (`delivery/backend.rs:209`). Therefore:

- The duplicate-`delivery_id` guard at `backend.rs:226-233` — the thing
  `never_resends_on_doubt` proves and the thing contract invariant
  `never_resends_on_doubt` names — **can never fire in production**: the deque is always
  empty on entry.
- `DeliverySeam::settle` (`backend.rs:276-295`) and `recorded_route`
  (`backend.rs:297-303`) have **zero callers** outside the module. I verified:
  `grep -rn "\.settle(\|recorded_route" crates/broker/src/` returns only the definitions
  and `pty.rs:61`.
- No runtime type records the route. `PendingDelivery` (`runtime/delivery.rs:6-30`) has no
  route field; neither does `BrokerEvent::MessageDeliveryFailed`
  (`runtime/delivery.rs:1108-1116`). Contract invariant `records_route_for_each_send` is
  satisfied only inside `crates/broker/tests/delivery_seam_invariants.rs`, against
  `ScriptedBackend`.

The contract's `wiring` rule (`symbol: DeliveryBackend`, `from: runtime/delivery.rs`) is
satisfied — the trait really is on the call path — but `scripts/migrate/native-delivery-gates.mjs`
checks it with a substring match, so `PtyDeliveryBackend` alone would also have passed it.

**Failure scenario:** phase 1 adds a Codex backend that returns `InDoubt`. Its receipt is
recorded into a seam that is dropped microseconds later, so the next maintenance tick has
no memory that the message was already handed over, and the duplicate guard the phase-0
tests certify does not run. The double-delivery protection the whole phase exists to
install is absent at exactly the moment a second route appears.

**Repair:** own one `DeliverySeam` on `BrokerRuntime` for the process lifetime and pass
`&mut` into `retry_pending_delivery`. That fix requires two companions, both currently
missing: bound `receipts` (it is an unbounded `VecDeque` scanned linearly on every send —
`backend.rs:226-233`, `:283-287`, `:299-302` — a leak and an O(n) hot path once long-lived;
evict on terminal disposition), and record the route on `PendingDelivery` so settlement and
the failure event can name it. Then call `seam.settle` from the `delivery_verified` /
`delivery_ack` handling in `worker_events.rs`, which is where the PTY's real settlement
happens today and which currently bypasses the seam entirely.

---

## F5 — HIGH. Echo verification was widened to read a bare CR as a line break, which can manufacture an observation

**Evidence:** `crates/broker/src/broker/delivery_verification.rs:284-293`

```rust
pub(crate) fn check_echo_in_output(output: &str, expected: &str) -> bool {
    let clean = strip_ansi(output);
    if clean.contains(expected) {
        return true;
    }
    clean
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .contains(&expected.replace("\r\n", "\n").replace('\r', "\n"))
}
```

The `\r\n` → `\n` half is correct and is what the accompanying test covers
(`check_echo_normalizes_terminal_crlf`, `:353-359`). The `.replace('\r', "\n")` half is
different in kind: in a terminal a bare CR means *return to column 0 and overwrite*, not
*new line*. Rewriting it to `\n` synthesises text that was never simultaneously on screen.

**Failure scenario:** a TUI redraws a status line in place, emitting `…foo\rbar…`. On the
real screen the row reads `bar`; `foo` was overwritten and never co-existed with `bar`.
After this normalisation the buffer reads `foo\nbar`, so an `expected` of `"foo\nbar"`
matches and `check_echo_in_output` returns true. `pty_worker.rs:1661-1697` then emits
`delivery_ack` + `delivery_verified{verification: "echo"}` for an echo that was not
observed — which `runtime/worker_events.rs:696-750` promotes to a resolved fleet
`delivery_ack` and `MessageDeliveryConfirmed`. That is rule 4 ("never claim an
acknowledgement you did not observe") broken by the widening itself, in the phase whose
job is to install rule 4.

Aggravating: this file is absent from `changed-files.json` (F7), so no gate saw the change,
and the edit landed at 18:28:58Z, after the last `cargo test` (F2).

**Repair:** drop `.replace('\r', "\n")` from both sides and keep only the CRLF
normalisation:

```rust
    let normalize = |s: &str| s.replace("\r\n", "\n");
    normalize(&clean).contains(&normalize(expected))
```

Then add a negative test pinning the property the current code loses, e.g.
`assert!(!check_echo_in_output("foo\rbar", "foo\nbar"))`.

---

## F6 — HIGH. The phase's only exit criterion was changed, in product code and in the harness, in the same session it went green

The contract exit is *"The parity suite is green, **unchanged**, with the PTY backend behind
the new trait."* Three things happened to that gate:

**(a) Product code was changed to alter what the parity suite measures.**
`crates/broker/src/pty_worker.rs:70-82`:

```rust
fn default_inject_rate_ms(cli: &str) -> u64 {
    let cli = cli_basename(cli);
    if cli.eq_ignore_ascii_case("codex")
        || cli.eq_ignore_ascii_case("codex.exe")
        || cli.eq_ignore_ascii_case("cat")
        || cli.eq_ignore_ascii_case("cat.exe")
        || crate::readiness::is_devin_cli(cli)
```

`cat` is the CLI **every** parity and benchmark scenario spawns
(`tests/parity/broadcast.ts:34`, `multi-worker.ts`, `orch-to-worker.ts`,
`continuity-handoff.ts`, `stability-soak.ts:40`). Adding it here switches all of them from
the 5 ms paced injection (`DEFAULT_INJECT_RATE_MS`, `pty_worker.rs:65`) to a single bulk
write. The doc-comment immediately above (`:67-69`) justifies the list by Codex's
full-screen redraw behaviour, which has nothing to do with `cat`; the new entry carries no
justification. The consequence is that the paced-injection path — the one every real
non-codex CLI uses — is no longer exercised by any parity scenario, so "the same assertions
pass with the backend swapped" (doc:203-205) is no longer the claim being tested.

**(b) The failing gate's timeouts were tripled.** `tests/parity/broadcast.ts:13` introduces
`TIMEOUT_MS = 15_000` replacing a hardcoded `5000` at `:67-70`;
`tests/parity/continuity-handoff.ts:13` adds `DELIVERY_TIMEOUT_MS = 15_000` replacing
`5000` at `:50` and `:95`. `gate-log.txt` records `require-green | parity-broadcast: exit=1`
at 18:34:23Z and again at 18:35:44Z, then `GATE_PASSED` for all five at 18:48:58Z. (The
`unsub()` added inside the timer callback is a genuine listener-leak fix and is fine.)

**(c) The recorded green is a retry, and the failing attempt was not kept.**
`evidence/parity-broadcast.json` tail ends `[record] passed on attempt 2`. The runner
retries a red parity suite once (commit `1e06740ef`). Attempt 1's output is nowhere in the
artifact set, so there is no way to tell whether it failed for the same reason it failed at
18:34 and 18:35 or for a new one.

**Failure scenario:** phase 1 swaps in a native Codex backend and the parity suite goes
green. Nobody can tell whether that proves the native route is at parity, because the
baseline it is compared against is a suite that (i) runs a different injection mode than it
did before phase 0, (ii) has 3× the delivery tolerance, and (iii) records a pass on retry.

**Repair:** revert `cat`/`cat.exe` from `default_inject_rate_ms`. `RELAY_INJECT_RATE_MS`
already exists as the supported override (`pty_worker.rs:60-64`); if the harness needs bulk
injection, set `RELAY_INJECT_RATE_MS=0` in the env the parity tests pass to
`HarnessDriverClient.spawn` — that is a harness decision in harness code and leaves the
product default alone. Keep the timeout increase only with a recorded reason (they are
defensible against a 5 ms-paced `cat`, but then they are a *consequence* of the pacing and
the two changes should not both be in). Make `record` persist every attempt's transcript,
not only the winning one.

---

## F7 — MEDIUM-HIGH. Four changed files were invisible to every gate

**Evidence:** `changed-files.json` is the file `edit-gate`, `manifest-gate` and
`targeted-gate` all read. Comparing it to `git status --porcelain --untracked-files=all`:

```text
IN TREE, NOT IN changed-files.json:
   crates/broker/src/broker/delivery_verification.rs
   crates/broker/src/runtime/app_server.rs
   tests/e2e/unlaunched/session-host.ts
   tests/e2e/unlaunched/unlaunched-delivery.test.ts
```

(plus `.agentworkforce/trajectories/active/…`, which is noise.)

This is the mechanism by which F1 and F5 reached a sealed phase unreviewed: a product-code
mutation on a live delivery path and a widening of echo verification, neither seen by the
scope check, the manifest routing check, or the targeted-scenario selector.

Note also that `crates/broker/src/runtime/app_server.rs` is outside `phase-contract.json`'s
declared `scope` (`crates/broker/src/delivery/`, `crates/broker/src/broker/`,
`crates/broker/src/lib.rs`, `crates/broker/tests/`) — see F12.

**Repair:** recompute `changed-files.json` immediately before each gate rather than once at
the start of the run, and have `seal` recompute it a final time and fail if it differs from
the recorded copy.

---

## F8 — MEDIUM. The `timeout_fallback` fleet ack is still sent; the comment now claims it is not

**Evidence:** the diff edits `crates/broker/src/runtime/delivery.rs:13-17` to read

```rust
    /// Fleet (engine-facing) `delivery_ack` withheld until the worker confirms
    /// this specific PTY injection landed — echo-verified by the worker rather
    /// than timed out or acked the instant the write is merely
    /// handed to the worker. See relay#1310.
```

but the code does not hold that. On an echo timeout the worker sends **two** frames, in
this order (`crates/broker/src/pty_worker.rs:2270-2292`): first `delivery_ack` — byte-for-byte
the same frame it sends on a verified echo (`:1676-1686`, `:2149-2159`) — then
`delivery_verified{verification: "timeout_fallback"}`. The broker's `delivery_ack` handler
(`runtime/worker_events.rs:696-750`) never looks at `verification`; it calls
`confirm_pending_delivery_and_resolve_fleet_ack` (`runtime/fleet.rs:1782`) and
`enqueue_delivery_ack` (`worker_events.rs:740`), then emits `MessageDeliveryConfirmed`
(`:777-788`) and `mark_delivery_read_ack` (`:787`).

The new guard added by this diff (`worker_events.rs:864-873`, `if timeout_fallback { None }
else { clear_pending_delivery_if_event_matches(...) }`) therefore has **no effect on the PTY
flow**: by the time the `delivery_verified` frame is processed, the preceding
`delivery_ack` has already cleared the pending entry, so `pending_for_confirmation` would
have been `None` either way.

**Failure scenario:** a message is typed into an agent whose TUI does not echo it back in
the 5 s window. The engine receives a cumulative `delivery_ack` covering it. Per doc:90-91
that is exactly "claim an acknowledgement you did not observe", and per doc:38 it is the
mirror of agent-deck's cited bug. The code comment now asserts the opposite, so the next
reader will not look.

**Repair:** pick one and make the tree consistent. Either (a) carry the verification kind on
the worker's `delivery_ack` payload and have `worker_events.rs:696` withhold the fleet ack
for `timeout_fallback` (which also makes the `:864` guard meaningful) — noting this changes
fleet ack timing and needs its own parity evidence; or (b) revert the comment at
`runtime/delivery.rs:13-17` to the accurate original and record the timeout-fallback ack as
a named, written-down phase-0 exemption from rule 4, so phase 2's Claude socket backend is
not measured against a PTY baseline that quietly violates the rule it is held to.

---

## F9 — MEDIUM. ~90 assertions covering the retry-cap → dead-letter lifecycle were deleted

**Evidence:** `crates/broker/src/runtime/tests.rs:3219-3283`. The diff replaces the
retry-to-cap loop and everything after it with a single `retry_pending_delivery` call. What
is now uncovered:

- that a present-but-failing worker's delivery terminates at all (the old loop ran to
  `MAX_DELIVERY_RETRIES + 1` and asserted a terminal `Failed` at or after the cap);
- that `pending_deliveries` is emptied on terminal failure ("terminal failed deliveries are
  removed so they cannot stall silently");
- the entire `message_delivery_failed` wire shape — `kind`, `name`, `delivery_id`,
  `event_id`, `from`, `to`, `attempts`, typed `lastError`, and the explicit assertion that
  `last_error` (snake) is **absent**;
- `dead_letter_added` emission, `dead_letters.len() == 1`, and the entry's `body` and
  `attempts`.

None of that deletion is required by the change: the first-retry behaviour the new test
asserts is unchanged from before. And as F3 shows, the replacement does not even pass.

This is the repo's standing rule in `feedback_prove_tests_bite_before_claiming_green`
inverted: the test that pinned the old contract was edited until it agreed with the new
behaviour.

**Repair:** restore the deleted block as a second arm of the test. If the retry-vs-terminal
policy for a present worker on writer error is genuinely meant to change, that is a
decision, and it belongs in `decisions/` with the parity evidence to support it — not in a
test edit.

---

## F10 — MEDIUM. `insert_and_attempt_delivery` fabricates an attempt count, and none of its four new writes is asserted anywhere

**Evidence:** `crates/broker/src/runtime/delivery.rs:933-936`

```rust
        pending.failed_attempts = MAX_DELIVERY_RETRIES;
        pending.attempts = pending.attempts.max(MAX_DELIVERY_RETRIES);
        pending.last_error = Some(last_error.clone());
        pending.next_retry_at = Instant::now();
```

`pending.attempts` is not internal bookkeeping. It is emitted on the wire as
`message_delivery_failed.attempts` (`runtime/delivery.rs:1113`) and stored on the
dead-letter entry. Setting it to `MAX_DELIVERY_RETRIES` (= 10, `runtime/mod.rs:61`) reports
ten attempts for a delivery that was attempted **once**. The deleted test
(F9) asserted `attempts == MAX_DELIVERY_RETRIES` *only after a real ten-iteration loop*;
that number is now synthetic and an operator cannot distinguish a first-try failure from a
genuinely stuck worker.

Separately, the comment justifies the block by "a possible-write failure must not become
due and get handed to a route again", but on this path the only reachable
`DeliveryAttemptOutcome::Failed` is `"recipient gone"` (`runtime/delivery.rs:979-985`) — a
strictly pre-write condition where no write occurred and no doubt exists. The
possible-write cases it names (`InDoubt`, `CommittedError`) are unreachable; see F11.

Finally, the existing test for this path,
`initial_delivery_failure_stays_owned_until_dead_lettered`
(`runtime/tests.rs:3170-3215`), asserts only `pending_deliveries.len()`, `event_id` and
`body`. **None** of the four fields this diff now writes is asserted by any test.

**Repair:** set `failed_attempts = MAX_DELIVERY_RETRIES` (which is what makes the entry
terminal at `:968`) and leave `attempts` truthful. Extend
`initial_delivery_failure_stays_owned_until_dead_lettered` to assert the terminal shape:
`failed_attempts == MAX_DELIVERY_RETRIES`, `last_error` present, `attempts == 1`, and that
a subsequent `retry_pending_delivery` returns `Failed` without a second write.

---

## F11 — MEDIUM. The two branches that implement "never re-send on doubt" are unreachable and untested, and the one they route into means the opposite

**Evidence:** `crates/broker/src/runtime/delivery.rs:1002-1008` (`Ok(receipt) if InDoubt`) and
`:1024-1030` (`Err(error) if error.is_committed()`). The only backend in the slice at
`:1000` is `PtyDeliveryBackend`, which returns exactly one success value
(`SendStatus::HandedOver`, `pty.rs:57`) and exactly one error kind
(`DeliveryError::unavailable`, `pty.rs:49`, `:53`, `:56`). Neither branch can execute.
`grep -rn "InDoubt\|is_committed" crates/broker/src crates/broker/tests` confirms no test
drives either through `retry_pending_delivery`.

Worse than dead: both branches route an in-doubt delivery into
`DeliveryAttemptOutcome::Failed`, and that variant's documented meaning at
`runtime/delivery.rs:1118-1126` is the opposite of in-doubt —

> A dead-lettered delivery never actually landed, so any fleet (engine-facing) ack withheld
> pending its confirmation must be dropped rather than sent — the engine keeps its own
> record of this delivery as un-acked and **will redeliver it**.

So the first code ever written to honour "never re-send on doubt" hands a possibly-delivered
message to the one disposition that instructs the engine to send it again, and drops the
withheld ack that was the only thing holding the engine back. Rule 2 is inverted at the
exact site it was added to enforce.

**Failure scenario:** phase 1's `CodexQueueBackend` returns `InDoubt` after a `codex queue`
write whose result it could not read. `retry_pending_delivery:1002` dead-letters it; the
withheld fleet ack is dropped at `:1127-1134`; the engine redelivers; the agent receives the
message twice. Every step is doing what its own comment says.

**Repair:** give in-doubt its own terminal disposition. It is neither `Attempted` nor
`Failed`: it must remove the entry from `pending_deliveries` **and** resolve (not drop) the
withheld fleet ack, so the engine records the delivery as accounted for and does not
redeliver, while the SDK event says `in_doubt` rather than `message_delivery_failed`. Add a
`DeliveryAttemptOutcome::InDoubt` variant, and a `runtime/tests.rs` case that drives
`retry_pending_delivery` with a stub backend returning `InDoubt` and asserts (i) no second
write, (ii) the entry is gone, (iii) no `message_delivery_failed` is emitted, (iv) the
withheld ack is not dropped.

---

## F12 — MEDIUM. The manifest entry claims the whole PTY injector, and it grew one gate failure at a time

**Evidence:** `.agentworkforce/features/manifest.yaml:103-112`, the `location:` of
`delivery-backend-seam`:

```text
crates/broker/src/delivery/, crates/broker/src/lib.rs, crates/broker/src/pty_worker.rs,
crates/broker/src/runtime/delivery.rs, crates/broker/src/runtime/tests.rs,
crates/broker/src/runtime/worker_events.rs, crates/broker/tests/,
tests/benchmarks/harness.ts, tests/benchmarks/stress.ts,
tests/fixtures/delivery-contract-evals.test.ts,
tests/fixtures/targeted-feature-verification.test.ts, tests/parity/
```

`gate-log.txt` shows this list being extended in direct response to gate complaints:

```text
17:17:53Z GATE_FAILED manifest-gate … unrouted runtime files: crates/broker/src/pty_worker.rs
17:18:25Z GATE_PASSED manifest-gate phase=0 features=1
17:51:08Z GATE_FAILED targeted-gate … unmapped runtime paths: tests/benchmarks/harness.ts, …, tests/parity/stability-soak.ts
17:51:28Z GATE_PASSED targeted-gate phase=0 …
```

`pty_worker.rs` is the PTY injector — the ~7 000-line thing the seam is supposed to sit
*beside*, not the seam. Claiming it means every future change to PTY injection routes to
this one tier-6 delivery-seam feature instead of the features that actually own it
(`sdk-delivery`, `broker-redeliver`, `local-agent-spawn`, … — the neighbours doc:222-226
names). The manifest is the repo's map of what verifies what; this entry makes it wrong.

**Repair:** `location: crates/broker/src/delivery/, crates/broker/tests/delivery_seam_invariants.rs`.
Route `pty_worker.rs`, `runtime/delivery.rs`, `runtime/worker_events.rs`, `tests/parity/`
and `tests/benchmarks/` to the features that own them, adding those `location:` entries if
they are genuinely missing — which is the actual fix the `targeted-gate` failures were
pointing at.

Related, and worth a decision: `phase-contract.json`'s `scope` lists four paths;
`scripts/migrate/native-delivery-gates.mjs:77-84` enforces six, having added
`crates/broker/src/runtime/` (commit `e3bd628d0`, after `edit-gate` failed on
`runtime/delivery.rs` and `runtime/tests.rs` at 16:31:49Z) and
`crates/broker/src/pty_worker.rs` (commit `475535df0`, after `edit-gate` failed on it at
17:04:00Z and passed 38 seconds later). The contract is authoritative; the enforced scope
has drifted from it, twice, each time in response to the file it then admitted.

---

## F13 — MEDIUM. `stability-soak` cannot fail on a lost delivery or a 10× throughput collapse, and this run exhibited one

**Evidence:** `tests/parity/stability-soak.ts:91-106`

```ts
    const total = verified + failed;
    const successRate = total > 0 ? (verified / total) * 100 : 0;
    …
    console.log(`  Unaccounted:        ${sent - total}`);
    …
    const passed = successRate >= 90 && sendErrors === 0;
```

`successRate` is `verified / (verified + failed)`. A message that produces **neither** event
is "Unaccounted" — printed at `:100`, never asserted. `expectedMsgs` (`:18`) is printed at
`:21`, never asserted. So a run that silently drops 90 % of its messages still scores 100 %.

This run, from `evidence/parity-stability-soak.json`:

```text
    Duration: 60s, Rate: 5 msgs/sec
    Expected messages: ~300
  Messages sent:      30
  Actual send rate:   0.5 msgs/sec
=== Stability Soak PASSED ===
```

30 of ~300 at one tenth the target rate — i.e. each `sendMessage` round trip took ~1.8 s
against a 200 ms loop interval — and the gate the doc describes as proving "no drift or leak
over time" (doc:200) passed. I have no pre-change soak run to compare against, so I am not
claiming this diff caused the shortfall; I am claiming the gate is structurally incapable of
noticing either the shortfall or a lost message, which is what makes it useless as the
phase's drift detector.

**Repair:** add to `:106`:

```ts
    const passed =
      successRate >= 90 &&
      sendErrors === 0 &&
      sent - total === 0 &&               // every message accounted for
      sent >= expectedMsgs * 0.9;         // the rate held
```

and record the resulting baseline numbers in the artifact so phase 1 has something to
compare against.

---

## F14 — MEDIUM. Silent behaviour drift: nothing in the seam can express "this route will never tell you more", or that a route rewrote the message's framing

The prompt names two specific semantic hazards; neither has a representation in the types
this phase introduces, and the parity gates cannot catch either.

**(a) Claude cloud has no completion signal at all** (doc:70, doc:296). `SettleStatus`
(`delivery/backend.rs:167-172`) is `Acked | HandedOver | Failed(String)`. `HandedOver` is
the right shape for "delivered, not confirmed", but it is the *same* value a route returns
while it is still waiting for a signal that is genuinely coming. A `settle` poller cannot
distinguish "no completion signal exists for this route, stop asking" from "not yet". A
Claude-cloud delivery would sit in `HandedOver` indefinitely, indistinguishable from a
wedged Codex thread, and anything that eventually times such a thing out would report a
false failure for a message that arrived.

**(b) A Claude peer message arrives labelled "from another session" with slash commands
disabled** (doc:295-296, doc:129-131). `SendRequest` (`backend.rs:44-50`) carries
`delivery_id`, `body`, `worker_name`, `relay_delivery` — nothing lets a route declare that
it altered how the recipient will read the body, and nothing lets the seam refuse or warn
on a body the route will neutralise. Relay's own message bodies are formatted with a
`<system-reminder>` envelope (see the expected string in
`delivery_verification.rs:355`), and relay does inject bodies that begin with `/`. Over the
Claude socket those silently stop being commands. `SendStatus` reports the send as
`HandedOver` regardless.

**Repair:** two small type changes now, while the surface is one implementation and free to
move: add `SettleStatus::Terminal { reason }` (or a `RouteCapabilities { completion_signal:
bool }` returned alongside `TransportStatus`) so "this route will never report completion"
is a value and not an omission; and add a `framing: MessageFraming` field to `SendStatus` /
`SendReceipt` recording how the accepted route will present the body (`Verbatim`,
`PeerLabelled { commands_disabled: bool }`). Both are cheap to add before any native
backend exists and expensive to retrofit after four of them do. Record the decision either
way in `decisions/` — doc:295 asks for a per-phase semantic review, and phase 0 has not
produced one.

---

## F15 — LOW-MEDIUM. `never_acks_without_observation` cannot fail on the code under test

**Evidence:** `crates/broker/tests/delivery_seam_invariants.rs:202-232`. The test configures
`ScriptedBackend` with `settle_status = HandedOver` (`:208`) and asserts the seam returns
`HandedOver` (`:230`). `DeliverySeam::settle` (`backend.rs:276-295`) forwards the backend's
value unchanged and contains no branch that could produce `Acked`; `PtyDeliveryBackend`
(`pty.rs:61-66`) returns a constant `HandedOver`. So the assertion is a statement about the
mock's configuration. `assert_ne!(settle, SettleStatus::Acked(…))` at `:231` is implied by
the `assert_eq!` on the line above it and can never fail independently.

`evidence/mutation-proof.md`'s fourth mutation ("changed settlement to upgrade a handoff-only
result into a fabricated `Acked`") does show the test catching an *added* fabrication, which
is worth something — but it catches it in `settle`, and nothing constrains `send`, where
`ObservedAck` (`backend.rs:89-100`) is a public `String` wrapper any future backend can
construct without observing anything.

Contrast `falls_back_only_before_write:118-119` (`native.sends == 1, pty.sends == 0`), which
genuinely bites.

**Repair:** either drive `settle` through `PtyDeliveryBackend` against a real
`WorkerRegistry` so the assertion is about production code, or make the invariant structural
— construct `ObservedAck` only from a private constructor that takes observed evidence
(a matched echo span, a session-file line, a transcript offset), so a backend cannot report
`Acked` without producing the thing it observed. Delete the redundant `:231`.

---

## F16 — LOW. `settle` returns `None` for two different things, one of which is exactly what rule 3 exists to catch

**Evidence:** `crates/broker/src/delivery/backend.rs:276-295`. `None` is returned both at
`:285` (`?` on "no receipt for this delivery_id" — the message was never sent by this seam)
and at `:293` (`?` on "the recorded route's backend is not in the slice" — the message *was*
sent, over a route that is not currently available).

The second case is the contract's own trap shape: "not in the queue and not in the session
file" looks identical to "the route that has it is gone". A caller that reads `None` as
absence and re-sends is the failure the doc calls out at doc:85-87.

**Repair:** return a three-way value — `Settled(SettleStatus)` / `NoReceipt` /
`RouteUnavailable(RouteId)` — and add a test asserting a caller can tell them apart.

---

## F17 — LOW. The unlaunched e2e suite has never been run, never been typechecked, and will break `npm run test:e2e` where `opencode` is absent

**Evidence:** `tests/e2e/unlaunched/session-host.ts` (19:01:12Z) and
`unlaunched-delivery.test.ts` (19:04:59Z) postdate `ts-typecheck` (18:07:41Z), and
`unlaunched-gate` recorded `not-required` (`evidence/unlaunched-gate-final.json`, matching
`phase-contract.json`'s `"unlaunched": false`). There is no execution record for either file.

`vitest.e2e.config.ts:46` includes `tests/e2e/**/*.test.ts`, so `npm run test:e2e`
(`package.json:126`) now picks it up, and the suite is non-skippable by deliberate design
(`unlaunched-delivery.test.ts:93-98`: "Fail, never skip"). On any machine without
`opencode` at `~/.opencode/bin/opencode` and without `RELAY_UNLAUNCHED_OPENCODE_BIN`,
`beforeAll` fails and takes the file with it.

To be clear about quality: the code itself is careful and I found nothing wrong with it.
`session-host.ts:70-82` isolates all four XDG dirs, passes `--pure`, runs in a `mkdtemp`
cwd, and the header at `:13-18` correctly explains why `claude`/`codex` are *not* used —
it respects the testing hazard properly. The `--port 0` + read-the-listening-line pattern
(`:166-202`) avoids the usual port race, and the pid-lineage assertion
(`unlaunched-delivery.test.ts:154-162`) proves the claim rather than asserting it. The
problem is only that it is unexecuted, and that adding it to `tests/e2e/**` is a change to
an existing suite's pass/fail behaviour that nobody has observed.

Minor platform notes in the same files: `session-host.ts:26` hardcodes
`~/.opencode/bin/opencode` as the only fallback and never consults `PATH`;
`parentPidOf` (`:145-155`) shells out to `ps -o ppid=`, which is fine on macOS/Linux and
absent on Windows; `unlaunched-delivery.test.ts:60-62` resolves only `target/release`
while `tests/benchmarks/harness.ts:19-24` resolves debug-then-release, so the two harnesses
disagree about which binary they test.

**Repair:** run it once and attach the transcript, or gate it behind a separate
`vitest.unlaunched.config.ts` / npm script until phase 1 needs it — and say explicitly in
the phase notes that phase 0 ships it unexecuted. Add `PATH` lookup to
`resolveOpencodeBinary` and align `brokerBinary()` with `resolveBinaryPath()`.

---

## F18 — LOW. The regression gate parses its failure list out of a truncated buffer

**Evidence:** `scripts/migrate/native-delivery-gates.mjs:711` stores
`tail: output.slice(-20_000)`; `:386` derives the failure list by regexing `^\s*FAIL\s+.+$`
out of that string. `evidence/unit-tests.json` is a 3 438-test vitest run whose full output
is far larger than 20 000 characters. Vitest prints a `FAIL` line both inline as each file
finishes *and* in the trailing "Failed Tests" block, so this happened to work here — but
nothing guarantees it. A single failure with a large diff can push earlier `FAIL` headers
out of the window, and the gate would then pass having seen fewer failures than occurred.

Nothing cross-checks the parsed count against vitest's own summary. In this very artifact
they already differ in kind: the summary says `Test Files 2 failed | 189 passed`, the gate
parsed 3 entries.

The `KNOWN_FAILURES` mechanism itself (`:355-368`) is well-designed and each entry carries a
re-derivable justification — I checked, and `packages/harness-driver` and
`packages/cli/src/cli/commands` are indeed unmodified in this tree. This finding is about
the input, not the policy.

**Repair:** also capture vitest's `Test Files  N failed` / `Tests  N failed` summary line
into the evidence record and fail `regressionGate` when the parsed `FAIL` count is
inconsistent with it, or raise the slice to hold the whole run.

---

## F19 — INFO. Two PTY write paths still bypass the seam, and one of them re-sends after a possible write

The exit claims "the PTY backend behind the new trait". Two of the three PTY write paths are
not behind it. Both are pre-existing and neither is a regression, but they bound what the
phase can be said to have achieved.

- `crates/broker/src/runtime/delivery.rs:818-833` —
  `timeout(retry_interval, workers.deliver(worker_name, delivery))`. The timeout can fire
  *after* the frame is admitted; `worker.rs:1480-1485` states in so many words that an
  admitted command will still be emitted. Its caller
  (`crates/broker/src/runtime/fleet.rs:1984-1990`) sets `result.failure` and `break`s,
  leaving the message at the head of the FIFO — so the next flush writes it again. That is
  a fall-back after a possible write and a re-send on doubt, on the fleet path, unclassified
  by rule 1 and ungoverned by rule 2.
- `crates/broker/src/runtime/maintenance.rs:825` — `self.workers.deliver(...)` direct, with
  the error only logged.

**Repair:** route both through the seam (which requires F4's long-lived seam first), or
state plainly in the phase notes that phase 0 put *one* of three PTY write paths behind the
trait, so phase 1 does not assume the rules are enforced repo-wide.

---

## F20 — INFO. Smaller things, no failure scenario attached

- `SendRequest` carries the body twice: `body` (`backend.rs:47`) and
  `relay_delivery.body` (`:49`), both set from the same source at `:63-67`. The PTY backend
  reads only `relay_delivery` (`pty.rs:45-47`) and ignores `body`. Nothing keeps them equal;
  a future backend reading `body` after something mutates `relay_delivery` diverges silently.
- `HandoverState` (`backend.rs:81-86`) is a one-variant enum wrapped in a one-variant
  `SendStatus` case — `SendStatus::HandedOver(HandoverState::HandedOver)` carries no
  information.
- `SendRequest::new` (`backend.rs:53-60`) is used only by tests; production uses
  `SendRequest::relay` (`:62-69`).
- `DeliveryError::CommittedError`'s `Display` — "delivery backend error after possible
  write: {reason}" (`backend.rs:140`) — becomes the wire-visible `lastError` on
  `message_delivery_failed` via `runtime/delivery.rs:1028`. New user-facing text; existing
  assertions use `contains` so nothing breaks, but it is worth being deliberate about.
- The payload is cloned three times per attempt (`runtime/delivery.rs:999`,
  `backend.rs:64-67`, `pty.rs:45`) where the old path cloned once.
- `DeliverySeam::send` looks up the duplicate receipt with `.iter().find()`
  (`backend.rs:228`, oldest match) while `settle` and `recorded_route` use `.iter().rev()`
  (`:284`, `:300`, newest match). Harmless today because `send` returns early, but the
  inconsistency will matter once eviction lands (F4).
- `.claude/rules/rust.md` requires async functions to document cancel safety.
  `DeliverySeam::send` and `::settle` do carry cancel-safety comments
  (`backend.rs:217-220`, `:274-275`) — that rule is met. But the statement is incomplete in
  the way that matters: a caller cancelled mid-`send` leaves **no receipt at all**
  (`:253-256` records only after the backend returns), and `runtime/delivery.rs:751` is a
  live cancellation site.
- `tests/fixtures/delivery-contract-evals.test.ts` is the strongest work in this change.
  It runs all four suites the doc names rather than citing them, and its `unobservable`
  block (`:328-354`) records four properties the harness cannot see instead of writing
  checks that would pass regardless. One of those disclosures deserves to become a finding
  in its own right at some point: `inbox.ack` collapses hand-over into delivered with
  `input.state ?? 'delivered'`, which is rule 4 broken in the TypeScript delivery runner.
  Disclosed, not fixed, not gated — correct for this phase, but it must not be forgotten.

---

# Appendix A — where I differ from `reviews/shadow-rust.md`

That review is careful and most of it holds. Two of its highest-ranked findings are
**stale**, because `pty.rs` was rewritten at 18:18:17Z, after it was written:

- **Its F2** ("the PTY adapter classifies every `deliver` error as post-write") no longer
  describes the tree. `pty.rs:49`, `:53` and `:56` now return `DeliveryError::unavailable`,
  and since the adapter moved to `try_send_to_worker` — whose four failure modes are all
  strictly pre-admission — that classification is now *correct*. The fix, however, is what
  broke both tests and created F3 above.
- **Its F1** ("the committed/`InDoubt` branches are not terminal on the
  `insert_and_attempt_delivery` path") has been addressed: `runtime/delivery.rs:933-936`
  now marks the entry terminal before reinsertion. The remaining problems there are
  different and smaller — the fabricated `attempts` count and the total absence of
  coverage (F10).

Its F3 (per-call seam), F4 (timeout-fallback ack), F7 (manifest) and F9/F10 (test and
`settle` weaknesses) I re-derived independently and they stand; they appear above as F4, F8,
F12, F15 and F16.

Its section 3 (W1–W7) did not examine `crates/broker/src/runtime/app_server.rs` or
`crates/broker/src/broker/delivery_verification.rs` — the two files missing from
`changed-files.json` — which is where F1 and F5 live. That is not a criticism of the
reviewer; it is the cost of F7.

---

# Summary table

| # | Severity | Finding | Anchor |
| --- | --- | --- | --- |
| F1 | **BLOCKER** | Mutation probe in product code; panics on empty/non-ASCII body | `runtime/app_server.rs:279-282` |
| F2 | **BLOCKER** | Tree is red (2 failures, one P1 blocker); all evidence predates the code; seal covers only artifacts | `runtime/tests.rs:2101`, `:3269`; `seal-implementation.json` |
| F3 | HIGH | Dead PTY writer reads as a successful attempt; PTY route can no longer dead-letter | `delivery/pty.rs:50-57` |
| F4 | HIGH | Seam rebuilt per call; `settle`/`recorded_route` have no callers; 3 of 4 invariants test-only | `runtime/delivery.rs:997` |
| F5 | HIGH | Bare `\r` → `\n` can manufacture an echo observation | `broker/delivery_verification.rs:290` |
| F6 | HIGH | Parity gate changed in product code and harness in the session it went green; pass recorded on retry | `pty_worker.rs:74-75`; `tests/parity/broadcast.ts:13` |
| F7 | MED-HIGH | Four changed files absent from `changed-files.json`, so no gate saw them | `changed-files.json` |
| F8 | MEDIUM | Timeout-fallback fleet ack still sent; comment now claims otherwise; new guard is inert | `runtime/delivery.rs:13-17`; `worker_events.rs:864` |
| F9 | MEDIUM | ~90 assertions on the retry-cap → dead-letter lifecycle deleted | `runtime/tests.rs:3219-3283` |
| F10 | MEDIUM | Fabricated `attempts: 10` on the wire; new terminal-shape writes untested | `runtime/delivery.rs:933-936` |
| F11 | MEDIUM | In-doubt branches unreachable, and route into the disposition that makes the engine redeliver | `runtime/delivery.rs:1002`, `:1024`, `:1120-1127` |
| F12 | MEDIUM | Manifest feature claims the whole PTY injector; grew per gate failure; contract-scope drift | `manifest.yaml:110`; `native-delivery-gates.mjs:77-84` |
| F13 | MEDIUM | `stability-soak` cannot fail on lost messages or a 10× rate collapse; this run had one | `tests/parity/stability-soak.ts:91-106` |
| F14 | MEDIUM | No type can say "this route never reports completion" or "this route rewrote the framing" | `delivery/backend.rs:44-50`, `:167-172` |
| F15 | LOW-MED | `never_acks_without_observation` asserts the mock's configuration | `delivery_seam_invariants.rs:202-232` |
| F16 | LOW | `settle` returns `None` for both "never sent" and "route gone" | `delivery/backend.rs:285`, `:293` |
| F17 | LOW | Unlaunched e2e never run or typechecked; breaks `test:e2e` without `opencode` | `tests/e2e/unlaunched/*` |
| F18 | LOW | Regression gate parses failures from a 20 000-char tail with no cross-check | `native-delivery-gates.mjs:386`, `:711` |
| F19 | INFO | Two PTY write paths bypass the seam; one re-sends after a possible write | `runtime/delivery.rs:826`; `fleet.rs:1984` |
| F20 | INFO | Duplicated payload, one-variant enums, clone count, wire text, cancel-safety gap | `delivery/backend.rs` |

**F1 and F2 must be cleared before this phase can be sealed at all. F3 is the cause of F2's
red tests and must be fixed rather than asserted around. F4, F6 and F11 determine whether
phase 1 inherits a seam that does anything.**
