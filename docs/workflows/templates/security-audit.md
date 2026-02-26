# Security Audit Template

**Pattern:** pipeline | **Timeout:** 90 minutes | **Channel:** swarm-security-audit

## Overview

Structured security assessment pipeline from scanning through verification. Sequential phases ensure thorough coverage with proper triage before remediation.

## Agents

| Agent      | CLI    | Role                                             |
| ---------- | ------ | ------------------------------------------------ |
| lead       | claude | Owns final risk sign-off and recommendations     |
| scanner    | codex  | Performs static and dependency security scanning |
| analyst    | claude | Prioritizes findings and recommends mitigations  |
| remediator | codex  | Implements approved remediations                 |
| verifier   | gemini | Verifies fixes and residual exposure             |

## Workflow Steps

```
scan → triage → remediate → verify → report
```

1. **scan** (scanner) — Execute security scan and summarize findings
2. **triage** (analyst) — Prioritize by severity and exploitability
3. **remediate** (remediator) — Implement mitigations for approved findings
4. **verify** (verifier) — Re-test security posture
5. **report** (lead) — Produce final audit report

## Usage

```bash
agent-relay run --template security-audit --task "Audit authentication module"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from '@agent-relay/sdk/workflows';

const registry = new TemplateRegistry();
const config = await registry.loadTemplate('security-audit');
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: 'Security audit of the authentication and session management module',
});
```

## Configuration

- **maxConcurrency:** 1 (strict sequential execution)
- **onError:** fail (security audits should not skip steps)
- **errorStrategy:** fail-fast
- **Barrier:** audit-complete (waits for all phases)

## Verification Markers

- `SCAN_COMPLETE` — Scanning finished
- `TRIAGE_COMPLETE` — Findings prioritized
- `REMEDIATION_COMPLETE` — Fixes applied
- `VERIFICATION_COMPLETE` — Fixes verified
- `DONE` — Report generated
