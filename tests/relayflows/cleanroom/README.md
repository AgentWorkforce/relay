# Relay clean-room verification campaign

This catalog drives `workflows/verify-cleanroom.ts`. It complements the fast
per-PR red/green proof in `tests/relayflows/cases/`; it does not replace it.

The campaign has three promises:

1. every feature in `.agentworkforce/features/manifest.yaml` is accounted for;
2. every open issue and recent functional/conventional merged PR selected by the
   documented title filter is routed to exactly one domain lane;
3. a missing fixture, skipped suite, coverage gap, or dirty cleanup is never a
   pass.

`full` and `soak` are Cloud-only profiles. Each lane is a separate non-interactive
agent step, so the Cloud sandbox executor gives it a fresh OS sandbox. Inside
that sandbox the lane runner creates a separate private HOME, XDG directories,
Agent Relay state directory, project directory, temporary directory, and
process group for every repeated scenario attempt. Lane setup artifacts are
shared within that one sandbox and recorded by size and SHA-256. Only explicitly
declared fixture credentials are copied into a test command. The workflow
validates the Cloud executor's reported sandbox IDs are non-local and unique
before it can report a green result; those IDs are runtime provenance, not
cryptographic attestation.

Use the released CLI to submit the checkout:

```bash
VERIFY_CLEANROOM_PROFILE=full \
  agent-relay cloud run workflows/verify-cleanroom.ts --sync-code
```

For a long flake hunt, use `VERIFY_CLEANROOM_PROFILE=soak`. For graph and
catalog development, use:

```bash
npm run verify:cleanroom:validate
DRY_RUN=1 VERIFY_CLEANROOM_PROFILE=smoke \
  relayflows run workflows/verify-cleanroom.ts
```

The smoke profile may be executed locally, but local execution is process
isolation, not a fresh OS proof. Set `VERIFY_CLEANROOM_ALLOW_LOCAL=1` explicitly
so a local result cannot be mistaken for the Cloud campaign. Local process-group
checks cannot detect a child that deliberately escapes by starting a new
session; full/soak relies on the trusted Cloud executor to tear down the entire
sandbox after a lane.

## Result semantics

- `GREEN`: every enabled scenario passed, every feature was explicitly named by
  a passing probe at its required evidence level, every scoped issue has an
  executable proof, cleanup passed, and sandbox provenance is valid. A test
  mapped only to a category is a category sample and cannot verify every feature
  in that category.
- `YELLOW`: commands may be green, but at least one feature or issue is not
  exercised deeply enough, or a declared fixture is unavailable.
- `RED`: product behavior failed or produced mixed results across repetitions.
- `INFRA_BLOCKED`: setup, evidence handoff, provenance, or cleanup failed.

The expected initial result is not necessarily green. Coverage-gap scenarios
are deliberate executable backlog: they make unproved Cloud, provider, release,
and fresh-workspace behavior visible until a real probe replaces the gap.

For a ready-to-run cross-repository repair brief, including the first manual
Daytona baseline and hard acceptance gates, use
[`DIAGNOSE_AND_FIX_PROMPT.md`](./DIAGNOSE_AND_FIX_PROMPT.md).

## Complete Fleet board

Fleet has a dedicated operator-host Relayflow because its proof environment is
itself a set of fresh Cloud sandboxes. The flow runs two sequential attempts;
each provisions at least two distinct Daytona sandboxes, registers both as live
Fleet nodes, and measures 95 operations:
every visible `fleet` leaf, all supported Fleet provider values, every `node`
leaf, all `node agent spawn` providers/runtimes/lifecycle modes, initial and
post-ready injection, remote attach, Relayfile root/scoped/no-mount behavior,
workflow execution, release, identity reconciliation, and exact sandbox cleanup.

```bash
npm run verify:fleet-daytona:validate
npm run verify:fleet-daytona:dry-run
npm run verify:fleet-daytona
```

Run the live command only from an operator host that is already authenticated to
Relay Cloud and Daytona. The runner never prints or places credentials in child
argv, stores redacted bounded output, checkpoints after every operation, and
deletes only exact sandbox IDs/names it recorded as owned. If interrupted, rerun
exact cleanup with the nonce printed by the workflow:

```bash
node scripts/verify-features/fleet-daytona.mjs cleanup \
  --nonce <run-nonce>
```

`fleet enable`, `fleet disable`, and `fleet inherit` affect a whole workspace.
They are evidence-visible safety skips unless the active workspace is disposable,
`VERIFY_FLEET_DISPOSABLE_WORKSPACE=1` is set, and
`VERIFY_FLEET_EXPECTED_WORKSPACE_ID` exactly matches the resolved Cloud workspace.
The runner captures the initial override and restores it in `finally`. `node down
--all` runs only inside an exact owned Daytona sandbox, never on the operator host.

Each attempt is sealed under
`.workflow-artifacts/verify-fleet-daytona/<nonce>-{a,b}/evidence.json`; the
aggregate is sealed under `<nonce>/campaign.json`. Product defects
produce a RED report without preventing the cheap supervisor and final fresh
Claude/Codex reviewers from auditing evidence integrity. The workflow enforces
GREEN only after both reviewers sign off on the exact two-attempt campaign.

The Relayflow performs aggregation automatically. The lower-level command for
manually collected attempts is:

```bash
node scripts/verify-features/fleet-daytona.mjs aggregate \
  --nonce <campaign-nonce> \
  --attempts <attempt-1-nonce>,<attempt-2-nonce>
```

The resulting sealed `campaign.json` classifies every operation as
`stable-pass`, `stable-fail`, `flaky`, `blocked`, `safety-skipped`, or
`inconclusive` and records timing distributions plus per-attempt cleanup status
and evidence digests. Aggregation rejects dirty source trees, different
runner/CLI/source/workspace identities, unsealed attempts, and reused Daytona
sandbox IDs. Validate the immutable result with `gate-campaign`.

The first hand-run baseline that motivated this board is recorded in
[`FLEET_DAYTONA_MANUAL_2026-09-04.md`](./FLEET_DAYTONA_MANUAL_2026-09-04.md).

## Scheduled and prerelease qualification

`.github/workflows/relay-cleanroom-qualification.yml` runs the read-only
cross-repository diagnosis nightly. It runs the same two-attempt Fleet campaign
for a prerelease, a stable release, a `relay_candidate_qualification`
repository dispatch, or a manual qualification. Nightly Fleet qualification is
enabled by setting `RELAY_NIGHTLY_QUALIFICATION_MANIFEST_JSON` to a current
immutable qualification manifest; it is otherwise skipped instead of silently
testing an unspecified build.

The diagnosis flow is itself fail-closed. Before independent review it authors
and validates exactly 143 runtime contracts: 12 state transitions, 23 injected
faults, 13 release acceptance gates, and all 95 Fleet operations. Diagnosis mode
must mark every runtime row `BLOCKED` and bind it bidirectionally to an owned,
promotion-blocking unknown; static tests and historical observations cannot
become runtime passes. The seal hashes every generated artifact and reproduction
dependency, not only the fixed report list. Runtime Trail files remain tracked
in git but are excluded from source-input hashes because the running workflow
updates them itself; a regression fixture proves that real source edits still
invalidate provenance.

The job installs and verifies the repository-pinned Relayflows CLI/core pair
(currently exact 1.1.4), uses the `local-process` backend for the host-side DAG,
and supplies only explicit CI tokens. Do not rely on a developer's authenticated
HOME: the local-process backend deliberately replaces HOME, and implicit
Relayfile provisioning for restricted agents is a tracked startup defect. The
temporary `RELAY_CLOUD_PROVISIONING_DONE=1` bypass is valid only for these
mount-free, sealed-file workflows; remove it when Relayflows exposes an explicit
no-Relayfile-provisioning contract.

`.github/workflows/relay-package-qualification.yml` is the only accepted Relay
package producer. A successful manual main-only prerelease run emits a package payload and a
second attestation artifact that seals the first artifact's GitHub digest. The
payload binds the Relay source SHA and exact SDK/config/protocol package versions;
Cloud accepts only the fixed workflow, path, event, ref, run attempt, artifact
names, digests, and file hashes. This two-artifact shape avoids the impossible
circular requirement for an artifact to contain its own GitHub digest.

Qualification manifest version 4 binds exact Relay, Cloud, Relayfile, and
Relayfile Cloud SHAs to that Relay producer run, a successful Cloud snapshot
workflow artifact, the fixed Cloud cold-plus-two-concurrent acceptance run for
the exact 851-file/454-directory/270,532,608-byte Relayfile corpus, and a successful, expiring
Relayfile Cloud candidate-deployment attestation. The job checks the GitHub run
attempts and artifact digests, exact acceptance sandbox cleanup, then checks the downloaded Relay package payload
and envelope, `qualification.json`, full snapshot manifest, baked Relay producer
closure and SDK version, Relayfile source SHA, and data-plane deployment identity.
Each board attempt receives a separate ephemeral Cloud workspace. The command
availability preflight is explicitly non-qualifying; only observed candidate
selection, two reveal-once 0600 workspace credentials, exact data-plane binding,
Fleet behavior, and verified cascade deletion count as effects. A release cannot
qualify by relabeling production: missing snapshot selection, workspace lifecycle,
candidate data-plane routing, cascade deletion, truncated evidence, cleanup, or
dual evidence signoff all fail the job.

## Reusing the system

The runner's matrix, isolation, evidence, aggregation, and review contracts are
product-neutral. Relayfile and Relayauth can add their own matrix JSON with a
feature manifest, profiles, domain lanes, commands, issue routing, and evidence
policy, then point a thin Relayflow at that matrix. The Relay regression-corpus
scenario is the only product-specific adapter and may be omitted or replaced.
The stable evidence record, Cloud run-storage handoff, repetition/flakiness
rules, reviewer contract, and final signoff stay unchanged.
