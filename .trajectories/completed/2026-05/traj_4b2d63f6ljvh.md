# Trajectory: Fix CI run 26263517444

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 21, 2026 at 09:47 PM
> **Completed:** May 24, 2026 at 09:45 PM

---

## Summary

Updated harness adapters so built-in coding harnesses are serializable configs, added adapter lifecycle identity/merge behavior, and refreshed docs for defining custom harnesses.

**Approach:** Standard approach

---

## Key Decisions

### Normalized Relay changelog to Burn-style release notes

- **Chose:** Normalized Relay changelog to Burn-style release notes
- **Reasoning:** The top-level changelog should track actual released versions with concise impact-oriented Added/Changed/Fixed sections; generated Product/Technical/Release scaffolding made released content look unreleased and duplicated release-only entries.

### Updated release workflow changelog generator

- **Chose:** Updated release workflow changelog generator
- **Reasoning:** Future stable releases should write the same Burn-style cross-package notes now used in CHANGELOG.md; the generator now emits standard sections and filters release-only/trajectory/review placeholders instead of Product/Technical scaffolding.

### Matched Relay AGENTS changelog guidance to Burn

- **Chose:** Matched Relay AGENTS changelog guidance to Burn
- **Reasoning:** Relay should tell agents to curate CHANGELOG.md [Unreleased] as work lands and to avoid generated Product/Technical/Releases sections, matching the Burn repo guidance adapted for Relay's single root changelog.

### Restored Keep a Changelog and SemVer contract

- **Chose:** Restored Keep a Changelog and SemVer contract
- **Reasoning:** Relay should keep the standard changelog header, agent guidance, and generated release sections aligned with Keep a Changelog while explicitly documenting Semantic Versioning.

### Use AWS managed CachingDisabled cache policy for PR previews

- **Chose:** Use AWS managed CachingDisabled cache policy for PR previews
- **Reasoning:** The failing job hit CloudFront's custom cache policy quota while SST created WebServerCachePolicy per preview stage; previews can safely trade edge response caching for quota stability while production keeps the custom OpenNext cache policy.

### Added SDK-level harness adapter registry

- **Chose:** Added SDK-level harness adapter registry
- **Reasoning:** Interactive spawns already accept arbitrary CLI strings, but workflow non-interactive execution was coupled to the built-in CLI registry and hardcoded model flags. A runtime registry plus serializable workflow harness config lets SDK/YAML callers add harnesses without Relay code changes.

### Replaced external Relaycast MCP dependency with owned Agent Relay MCP stdio server

- **Chose:** Replaced external Relaycast MCP dependency with owned Agent Relay MCP stdio server
- **Reasoning:** The MCP surface needed by spawned agents is small enough to own locally; using @relaycast/sdk directly avoids importing @relaycast/mcp internals while preserving callback resource updates and existing relaycast tool naming.

### Moved harness adapters into broker spawn path

- **Chose:** Moved harness adapters into broker spawn path
- **Reasoning:** The first pass only affected workflow subprocess execution. AgentRelay spawnPty ultimately posts to the Rust broker, so SDK-provided harness definitions now serialize on spawn requests and the broker applies binary resolution, interactive argv templates, model args, and bypass flags when launching PTY agents.

### Built-in harnesses are now data-backed adapter configs with optional lifecycle adapter identity

- **Chose:** Built-in harnesses are now data-backed adapter configs with optional lifecycle adapter identity
- **Reasoning:** This keeps codex/claude/opencode available by default while letting SDK and broker-spawned custom harnesses use the same serializable HarnessDefinition shape; adapter selects built-in lifecycle behavior when config alone is not enough.

---

## Chapters

### 1. Work

_Agent: default_

- Normalized Relay changelog to Burn-style release notes: Normalized Relay changelog to Burn-style release notes
- Updated release workflow changelog generator: Updated release workflow changelog generator
- Matched Relay AGENTS changelog guidance to Burn: Matched Relay AGENTS changelog guidance to Burn
- Restored Keep a Changelog and SemVer contract: Restored Keep a Changelog and SemVer contract
- Use AWS managed CachingDisabled cache policy for PR previews: Use AWS managed CachingDisabled cache policy for PR previews
- Preview failures are caused by active PR volume exceeding CloudFront custom cache policy quota; stale cleanup ran successfully but cannot help while open PR previews outnumber the quota. The durable fix is reusing a managed cache policy for PR stages.
- Added SDK-level harness adapter registry: Added SDK-level harness adapter registry
- Replaced external Relaycast MCP dependency with owned Agent Relay MCP stdio server: Replaced external Relaycast MCP dependency with owned Agent Relay MCP stdio server
- Moved harness adapters into broker spawn path: Moved harness adapters into broker spawn path
- Built-in harnesses are now data-backed adapter configs with optional lifecycle adapter identity: Built-in harnesses are now data-backed adapter configs with optional lifecycle adapter identity

---

## Artifacts

**Commits:** c41b133d, 28ec8236, bcc07d62, 2078bc8f, cfa9b0b9, ae28c3c3, f3f3744d, 83ab2bba, 11281768, fd09d477, 423184bb, 0d49dd41, baaef913, c148f419, f82bd2cc, 117e76d6, 2b363811, 68fddec4, bf9427dc, eefe64ba, d8973ce7, f57c3e2f, d76b0f40, 19b22846, c1cf84d3, 6c83d4bd, fa3f757f, c992acd3, 9a97be3a, 489d32cd, 9d800626, de2169fc, dc6cad51, 75771972, 4be45b44, f953d0f9, bbe4f00e, 90dc1faa, e5db219c, 66879e0c, 79311e9f, 8bcc3cfe, 3332e837, c13ee318, 5b4005ef, 6dea769a, c8299b7a, 839d0cda, e1022e4d
**Files changed:** 169
