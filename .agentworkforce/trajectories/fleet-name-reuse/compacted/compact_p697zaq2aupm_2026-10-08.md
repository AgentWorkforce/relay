# Fleet name reuse after release

Fleet release intentionally retains the Relaycast identity by default. Implemented the ticket’s accepted error-guidance option: fleet spawn agent_already_exists errors explain release <name> --delete-agent in the same workspace, including permanent deletion and provider binding retirement. Preserved structured placement evidence and existing cleanup. Added targeted and automatic regression cases plus an unrelated-error assertion. Validation completed successfully: fleet.test.ts (89 tests), npm run typecheck, CLI lint (0 errors, 109 warnings), and git diff --check. The task used a separate trajectory directory because an unrelated active trajectory already existed.

Decision: preserve identity retention; provide explicit --delete-agent remediation rather than deleting automatically.
