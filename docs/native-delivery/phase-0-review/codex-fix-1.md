# Codex fix pass 1

Read first:

- `docs/native-delivery-migration.md`
- `.workflow-artifacts/migrate-native-delivery/phase-0-seam-20260920c/phase-contract.json`
- `.workflow-artifacts/migrate-native-delivery/phase-0-seam-20260920c/reviews/claude-review-1.md`

## Fixed

- F1: removed the shipped `RELAY_MUTATION_LOSSY_FORMAT` mutation probe from
  `format_app_server_delivery`.
- F2/F3: restored PTY backend sending to the awaited `WorkerRegistry::deliver`
  path so writer completion is observed again. The broker lib suite is now
  green, including the two tests Claude reported red.
- F5: narrowed echo normalization to CRLF-only and added a negative test proving
  bare carriage return is not treated as a line break.
- F6: removed `cat` / `cat.exe` from product `default_inject_rate_ms`. Added a
  shared test harness env helper that sets `RELAY_INJECT_RATE_MS=0` for parity
  and benchmark broker launches, making the harness choice explicit.
- F10: stopped fabricating `MAX_DELIVERY_RETRIES` attempts for retained initial
  failures. The raw no-DLQ path now records one truthful attempt while still
  marking the entry terminal for maintenance dead-lettering.
- F10 coverage: extended
  `initial_delivery_failure_stays_owned_until_dead_lettered` to assert
  `attempts == 1`, terminal `failed_attempts`, retained `last_error`, and
  removal on the maintenance retry.

## Disputed

None.

## Not fixed in this pass

See `../BLOCKED_NO_COMMIT.md`. F4, F8, F11, F7/F2 seal integrity, and F12 remain
valid and should block sealing/committing this phase.

## Evidence refreshed

All were recorded through `scripts/migrate/native-delivery-gates.mjs record`
with run id `phase-0-seam-20260920c-fix1`:

- `rust-fmt`: green
- `rust-clippy`: green
- `rust-build`: green
- `invariant-tests`: green
- `ts-typecheck`: green
- `parity-orch-to-worker`: green
- `parity-multi-worker`: green
- `parity-broadcast`: green
- `parity-continuity-handoff`: green
- `parity-stability-soak`: green
