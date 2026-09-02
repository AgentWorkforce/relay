# Brief — attach-input-replay-0902 (finn-mini, codex)

From: `chief`. Date: 2026-09-02. Raised by Khaliq from live use.
cwd: `~/relay-attach-0902`, a worktree of `relay` on
`fix/attach-input-replay-0902` off `origin/main` @ `daf8a7c7c`. It was made for
you so you never touch the shared `~/Projects/AgentWorkforce/relay` checkout,
which is on someone else's branch. **Stay in your worktree.**

## The symptom, in Khaliq's own screenshot

While drive-attached to `awscf-wave1-0902b` **on a different node**:

> `[drive] input stream reconnected after 1 attempt(s) — awscf-wave1-0902b is
> still attached and usable. Keystrokes typed during the outage were dropped,
> not queued; retype them.); reconnecting…`

He says **this keeps happening, specifically on cross-node attach.** It is a
daily-driver problem: he is steering agents and silently losing input.

## Two separable defects. Do not conflate them.

**Defect A — the input stream drops at all.** Root-cause why the remote attach
transport disconnects, and why it appears specific to `--node` (remote) attach
rather than local. Start at `packages/cli/src/cli/lib/attach-remote-node.ts` and
`attach-fleet-node.ts`, and follow the socket to the relaycast terminal route.
Candidates worth pricing before you pick one: an idle/keepalive timeout on the
websocket, a NodeDO liveness alarm cycling the DO underneath the session, an
intermediary timeout. **Note `relaycast-cloud#89` — "jitter the NodeDO liveness
alarm so node DOs stay alive" — may be the same underlying cause; read it before
theorising.** If A turns out to live in relaycast-cloud rather than relay, say
so and stop: that is a different repo and a different fix.

**Defect B — the keystrokes are dropped rather than replayed.** This one is
squarely in `packages/cli/src/cli/lib/attach-input-recovery.ts`. Around
`:393` the reopen path calls `setStream(replacement)` and logs success — nothing
ever buffered what the user typed while the stream was down.

**The subtlety that makes B non-trivial, and you must preserve it.** The same
function deliberately refuses to forward input when the reopened stream is not
the same worker:

> *"input stream reopened but it is not the same worker (…). Refusing to forward
> input — your keystrokes would go somewhere you did not attach to."*

That refusal is correct and it is why a naive input queue is **worse than the
current data loss**: replaying a buffer into an unverified stream can type a
human's keystrokes into the wrong agent. So the fix is: **buffer during the
outage, and replay only after `verifyIdentity()` returns ok** — never on the
`rejected` or `exhausted` paths, where the buffer must be discarded and the user
told plainly what was discarded. Bound the buffer, and decide deliberately what
happens on overflow; say what you chose and why.

Also consider whether replay should be automatic at all for a *drive* stream, or
whether the safe design shows the user the buffered text and asks. Argue it; do
not just pick.

## Proof standard

- A **must-fire / must-not-fire pair** for B: a test where input typed during a
  simulated outage is replayed to the *same* verified worker, and a test where a
  reopened stream that fails identity verification **discards** the buffer and
  forwards nothing. The second test is the one that matters.
- The existing `attach-input-recovery.test.ts` is your starting point; a new
  test must fail before your change and pass after. "Must fail before" proves
  novelty, not relevance — also show it fires on the real path.
- For A, name the mechanism with a measurement, not a plausible story. If you
  can only reproduce it intermittently, say so and give the reproduction rate.

## Constraints

- **You never merge**, and you never deploy. Khaliq owns the merge gate; report
  to `chief` and I escalate.
- **Do not restart any node or fleet-node service.** A node restart kills every
  agent on it, and sf-mini currently holds three including live migration work.
- Never `git stash`; you have your own worktree, so there is no reason to.
- Verify by exit code and by re-reading state. An empty result is not a passing
  result. A negative from a shell one-liner needs a positive control.
- If A and B turn out to want different PRs, open them separately. B is
  independently valuable and shippable even if A is a relaycast-cloud problem.

## Step 0

Environment report, then tell me which of A and B you can reproduce and how,
before you write a fix. Getting B tested and fixed is worth more today than a
speculative A.

## Reporting

1. Append dated sections to `~/relay-attach-0902/CHIEF-STATUS.md` (append only).
2. DM `chief` one short line pointing at it. Keep DMs short — long messages
   splice and silently lose their middle.
