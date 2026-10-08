# Fleet Muse authentication preflight

Implemented the independent layers 1 and 3 of reviewed-plan.md on the assigned
branch. Verified remote spawns check the effective login before dedup or
registration; worker provider-auth failures reuse the existing deadline-driven
release and identity-cleanup path. Readiness frames cannot override that failure.

Decisions:
- Match harness env > worker env > inherited env; follow legitimate login symlinks.
- Validate filesystem usability and non-empty JSON only, without guessing tokens.
- Keep unverified spawn behavior, emitting a warning instead of hard failure.
- Do not guess Muse terminal literals. The reviewed plan gates layer 2 on captured
  login/composer screens; this environment has no workspace key or Muse binary.
  Sanitized captures were requested, but none were available during implementation.
- Keep existing authenticated-session fixtures unchanged.

The trajectory CLI could not start a new record because an unrelated release
recovery trajectory (traj_ynyux9pee7x7) is active. This standalone record preserves
that trajectory without completing or abandoning someone else's work.

Validation and remaining acceptance gaps are recorded in the root summary.md.
