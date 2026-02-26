# Trajectory: templates node: add workflow YAML templates and TemplateRegistry for relay-cloud PR #94

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 18, 2026 at 01:32 PM
> **Completed:** February 18, 2026 at 01:40 PM

---

## Summary

Added six built-in YAML templates plus TemplateRegistry with built-in/custom loading, shorthand resolution, overrides, and external template install. Wrote .relay/summaries/templates.md and sent summary to #swarm-impl.

**Approach:** Standard approach

---

## Key Decisions

### Modeled built-in templates using RelayYamlConfig schema

- **Chose:** Modeled built-in templates using RelayYamlConfig schema
- **Reasoning:** shared-types defines the canonical cloud relay.yaml structure and keeps templates schema-compatible

### Implemented TemplateRegistry overrides with dot-path traversal + array lookup by name/id

- **Chose:** Implemented TemplateRegistry overrides with dot-path traversal + array lookup by name/id
- **Reasoning:** supports practical overrides like agents.developer.cli and steps.plan.retries across template styles

---

## Chapters

### 1. Work

_Agent: default_

- Modeled built-in templates using RelayYamlConfig schema: Modeled built-in templates using RelayYamlConfig schema
- Implemented TemplateRegistry overrides with dot-path traversal + array lookup by name/id: Implemented TemplateRegistry overrides with dot-path traversal + array lookup by name/id
