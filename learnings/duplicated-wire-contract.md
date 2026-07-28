# Duplicated wire contract

**One producer serializes one payload; the consumer describes it twice by hand.
Adding a field updates one copy. Nothing breaks. The other copy is now a lie.**

## The shape of it

A producer emits a payload from a single place — one function, one serializer,
one query. Consumers in another language (or another module) hand-write a type,
schema, or struct to describe it. Then a *second* consumer surface needs the
same payload, and someone hand-writes a second description instead of pointing
at the first.

Now there are two descriptions of one runtime shape, with no mechanical link
between them. Every future field addition is a coin flip over which copies get
updated.

## Why it survives review

Nothing fails. That is the whole problem.

- **The compiler is satisfied.** Both declarations are internally valid. A type
  that omits a field the JSON actually carries is not an error — it is just a
  narrower view.
- **The tests pass.** The runtime data is correct. Only the *description* of it
  is wrong, and descriptions are not exercised at runtime.
- **The failure is asymmetric.** Consumers coming through the updated door see
  the field and are happy. Only consumers coming through the stale door hit the
  wall — and they hit it later, in different code, far from the change that
  caused it.
- **Drift accumulates silently.** Nobody notices a missing field until someone
  needs it. By then several are gone, and the gap looks like intent rather than
  rot.

## Why the obvious fix makes it worse

The natural response to "field missing from copy B" is to add the field to
copy B. That resolves the symptom and preserves the cause: two hand-maintained
copies, still unlinked, now with a fresh precedent that keeping them in sync by
hand is the way this codebase works. The next field will drift too.

**Repair the link, not the copy.** Delete the second declaration and point it at
the first. If the two genuinely cannot be unified — different ownership,
different modules, a real boundary — add a compile-time assertion that one is
assignable to the other, so the next drift fails a build instead of a user.

## How to catch it before you ship

When adding a field to a hand-written type that mirrors an external producer:

**Grep for a sibling field, not the new one.** The new field is what you are
adding; it appears nowhere else by definition. Pick a distinctive field that has
been on the payload for a while and search for it. Two hits in two files means
two declarations of one payload.

If the second hit is an inline anonymous type nested inside a larger response
type, treat that as the strongest signal — an inline shape has no name to search
for, so it is the copy that gets forgotten.

## Where it breeds

- Cross-language boundaries. A Rust producer and a TypeScript consumer share no
  compiler, so the only thing keeping them aligned is attention.
- Anywhere one payload is reachable through more than one endpoint, method, or
  response envelope. Multiple doors to one room invite one description per door.
- Generated-code gaps. If part of a contract is generated and part is
  hand-written, the hand-written part is where this lives.

## What it is not

This is not general code duplication, and "DRY" is not the useful frame. Two
similar-looking types that describe two genuinely different payloads should stay
separate; unifying those couples things that are free to diverge. The defect is
specific: **two descriptions of one runtime shape**, where only one description
is ever checked against reality.

## Worked example (relay, PR #1365)

`GET /api/spawned` and the `agents` array of `GET /api/status` are both
serialized from a single `WorkerRegistry::list` call in the broker. TypeScript
described that payload twice:

- `ListAgent` in `packages/harness-driver/src/types.ts` — used by `listAgents()`
- an inline anonymous object type inside `BrokerStatus.agents` in
  `packages/harness-driver/src/protocol.ts` — used by `getStatus()`

Adding `pending_messages` to `ListAgent` left `getStatus()` consumers unable to
reach a field the broker was demonstrably sending. Investigating showed the copy
had *already* drifted by four fields — `sessionId`, `runtime_kind`,
`native_harness_protocol_version`, `native_harness_capabilities` — none of which
anyone had noticed.

Caught by a review bot. Not by the compiler, not by the tests, not by the author.
That is the tell that this class needs a structural fix rather than more care.

Fixed by moving `ListAgent` into the wire-contract module next to `BrokerStatus`
and pointing `BrokerStatus.agents` at it, so there is one declaration.
`types.ts` re-exports it, keeping every existing import path valid.

Still outstanding: the broker also emits `workerPid`, which the unified type
does not declare — the same drift, one layer down.
