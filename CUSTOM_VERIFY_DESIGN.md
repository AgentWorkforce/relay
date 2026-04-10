# Custom Verification Design

## Overview

The `custom` verification type allows workflow authors to run arbitrary shell commands
(or regex patterns) as verification gates after an agent step completes. This replaces
the need for separate deterministic steps to validate agent output.

## Current Implementation Status

Custom verification is **already implemented** in the codebase:

- `packages/sdk/src/workflows/verification.ts` — `checkCustom()` function (lines 191-226)
- `packages/sdk/src/workflows/types.ts` — `VerificationCheck` interface (lines 621-625)
- `packages/sdk/src/workflows/schema.json` — `VerificationCheck` JSON schema

## How It Works

### Shell Command Mode

The `value` field contains a shell command. After the agent step completes, the command
is executed via `execSync`. The agent's output is available as `$STEP_OUTPUT` env var.

```yaml
verification:
  type: "custom"
  value: "cd nango-integrations && npx nango compile"
```

**Behavior:**
- Exit code 0 = verification passed
- Non-zero exit code = verification failed
- stderr is captured as the verification error message
- Configurable timeout via `CUSTOM_VERIFY_TIMEOUT_MS` env var (default: 30s)
- Max output buffer: 1MB

### Regex Mode

Prefix the value with `regex:` to match a pattern against the step output:

```yaml
verification:
  type: "custom"
  value: "regex:Successfully compiled"
```

**Behavior:**
- Pattern is compiled as a JavaScript `RegExp`
- Tested against the step's combined output
- Invalid regex returns a clear error message

## Retry Integration

When verification fails and `retries` is configured, the runner injects failure
context into the retry prompt (runner.ts, lines 4195-4202):

```
[RETRY - Attempt 2/3]
Previous attempt failed: Verification failed for "step-name": custom check failed - <stderr output>
Previous output (last 2000 chars):
<agent's prior output>
---
<original task>
```

This gives the agent diagnostic context from the failed verification command,
enabling it to fix the issue on retry.

## Type Definition

```typescript
// packages/sdk/src/workflows/types.ts
export interface VerificationCheck {
  type: 'output_contains' | 'exit_code' | 'file_exists' | 'custom';
  value: string;
  description?: string;
}
```

## Implementation Details

### `checkCustom(value, output, cwd)` — verification.ts

```typescript
function checkCustom(value, output, cwd): { passed: boolean; stdout?: string; error?: string }
```

1. **Regex branch** (`value.startsWith('regex:')`)
   - Strips prefix, compiles RegExp, tests against output
   - Returns `{ passed: false, error }` on mismatch or invalid regex

2. **Shell command branch** (default)
   - Runs `execSync(value, { cwd, env: { ...process.env, STEP_OUTPUT: output } })`
   - Timeout: `CUSTOM_VERIFY_TIMEOUT_MS` (default 30000)
   - stdio: pipe (captures stdout + stderr)
   - On success: `{ passed: true, stdout }`
   - On failure: `{ passed: false, error: stderr || error.message }`

### Side Effects on Failure

When custom verification fails, `runVerification()` records:
- A `verification_observed` tool side effect with `passed: false`
- A `verification_failed` coordination signal in the step's evidence record
- If `allowFailure` is false (default), throws `WorkflowCompletionError`

### Side Effects on Success

- A `verification_observed` tool side effect with `passed: true`
- A `verification_passed` coordination signal
- Returns `{ passed: true, completionReason: 'completed_verified' }`

## Callback Variant (Future / Programmatic Use)

For embedding the runner in another system where the host provides verification
logic programmatically, a callback variant is reserved:

```typescript
// Proposed extension to VerificationCheck:
interface VerificationCheck {
  type: 'output_contains' | 'exit_code' | 'file_exists' | 'custom';
  value: string;
  description?: string;
  /** Optional async callback for programmatic verification.
   *  When provided with type: 'custom', the callback is invoked instead of
   *  running the value as a shell command. */
  callback?: (output: string) => Promise<boolean> | boolean;
}
```

**Behavior:**
- If `callback` is present and `type === 'custom'`, invoke the callback
- The callback receives the step's combined output
- Return `true` = passed, `false` = failed
- The `value` field serves as a human-readable label in this mode
- Falls back to shell command execution if no callback is provided

**Note:** This callback field cannot be expressed in YAML — it's only available
when using the runner programmatically via the SDK. The JSON schema does not
include it; it lives only in the TypeScript type.

## Backwards Compatibility

- Existing workflows using `{ type: 'custom', value: '<command>' }` work unchanged
- The `value` field is always required (enforced by schema)
- Empty `value` with no callback will execute an empty command, which typically
  succeeds (exit 0) — authors should always provide a meaningful command

## Example Workflow

```yaml
workflows:
  - name: build-and-verify
    steps:
      - name: implement-feature
        agent: coder
        task: "Implement the new API endpoint"
        verification:
          type: "custom"
          value: "cd nango-integrations && npx nango compile"
          description: "Ensure Nango integration compiles"
        retries: 2
```

On failure, the coder agent receives the compile errors in its retry prompt
and can fix the issues without a separate verification step.
