# Pipeline Pattern

**Sequential chaining** — steps run one after another.

## Overview

The pipeline pattern executes steps in strict sequential order. Each step must complete before the next begins. This ensures linear processing with clear phase transitions.

## When to Use

- Linear processes with strict ordering requirements
- Security audits or compliance workflows
- When each step depends on the previous step's output

## Configuration

```yaml
swarm:
  pattern: pipeline
  maxConcurrency: 1 # Enforces sequential execution
```

## Example

```yaml
version: '1.0'
name: security-pipeline
swarm:
  pattern: pipeline
  maxConcurrency: 1

agents:
  - name: scanner
    cli: codex
  - name: analyst
    cli: claude
  - name: remediator
    cli: codex
  - name: verifier
    cli: gemini

workflows:
  - name: audit
    steps:
      - name: scan
        agent: scanner
        task: 'Run security scan'

      - name: analyze
        agent: analyst
        task: 'Analyze findings'
        dependsOn: [scan]

      - name: remediate
        agent: remediator
        task: 'Apply fixes'
        dependsOn: [analyze]

      - name: verify
        agent: verifier
        task: 'Verify fixes'
        dependsOn: [remediate]
```

## Behavior

- Steps execute in defined order
- Each step waits for the previous to complete
- Output from one step flows to the next via `{{steps.NAME.output}}`
- Clear audit trail of sequential processing
