# Trajectory: Extract web into agentrelay.com, relocate router, consolidate domains

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 22, 2026 at 08:20 AM
> **Completed:** June 25, 2026 at 02:11 PM

---

## Summary

Bumped broker to relaycast v5.0.1: removed workspace-stream toggle, added Deliver{agent_id,delivery_id} + ActionInvoke{agent_id,agent_name} node-frame fields, extracted firehose spawn/release into reusable async fns, updated register-endpoint test mocks and fleet-wire fixtures. cargo build + test green (787 tests).

**Approach:** Standard approach

---

## Key Decisions

### Phase 1: extracted relay/web into ../agentrelay.com with full history via git-filter-repo; kept web/ as a subdir under a workspace root so router/ can join as a sibling

- **Chose:** Phase 1: extracted relay/web into ../agentrelay.com with full history via git-filter-repo; kept web/ as a subdir under a workspace root so router/ can join as a sibling
- **Reasoning:** git mv loses history; workspace root keeps the ../node_modules/.bin/sst CI invocation and repo-root path math in the guard scripts unchanged

### Deferred relay-side deletion of web/ and Phases 2-3 (router relocation, domain consolidation) pending the new repo deploying green

- **Chose:** Deferred relay-side deletion of web/ and Phases 2-3 (router relocation, domain consolidation) pending the new repo deploying green
- **Reasoning:** Plan sequences relay cleanup after agentrelay.com deploys; Phases 2-3 touch live cloud infra + DNS and need user-driven staged rollout with AWS/CF creds

### Web hosting: wrangler-direct OpenNext-Cloudflare (no AWS), not sst.aws.Nextjs

- **Chose:** Web hosting: wrangler-direct OpenNext-Cloudflare (no AWS), not sst.aws.Nextjs
- **Reasoning:** User wants no AWS; @opennextjs/cloudflare on a CF Worker is the framework's documented path. wrangler auto-provisions worker+assets+DNS+cert; version-based PR previews replace the AWS preview/cleanup machinery

### Bundle docs/blog content at build via require.context (lib/content-store.ts) to remove runtime fs

- **Chose:** Bundle docs/blog content at build via require.context (lib/content-store.ts) to remove runtime fs
- **Reasoning:** Cloudflare Workers stubs node:fs (unenv); the site read content/README/images from disk at render. Static-assets incremental cache serves prerendered pages; content-store fixes route handlers + cache-miss renders. fs fallback kept for vitest (vite, no require.context)

### Resolved PR 1188 Swift conflicts by keeping relaycast-backed AgentRelaySDK facade

- **Chose:** Resolved PR 1188 Swift conflicts by keeping relaycast-backed AgentRelaySDK facade
- **Reasoning:** The PR intentionally replaces the direct HostedHTTP/RelayEventTransport implementation with Relaycast. The main-side conflicting tests reference removed transport types and would not compile in the relaycast architecture; swift test passes with the relaycast facade tests.

### Resolved PR 1187 Python conflicts by preserving relaycast-sdk transport and inheriting relaycast-sdk base URL defaults

- **Chose:** Resolved PR 1187 Python conflicts by preserving relaycast-sdk transport and inheriting relaycast-sdk base URL defaults
- **Reasoning:** PR 1187 replaces the direct aiohttp transport with relaycast-sdk. Current main removed agent-relay-sdk's own hosted base-URL default, so the combined resolution keeps RelayConfig.base_url unset unless configured and only forwards base_url to AsyncRelay/WsClient when provided.

### Extracted firehose spawn/release arms into free async fns release_worker_locally + spawn_worker_from_request (params take &RelayWorkspace + captured context)

- **Chose:** Extracted firehose spawn/release arms into free async fns release_worker_locally + spawn_worker_from_request (params take &RelayWorkspace + captured context)
- **Reasoning:** v5.0.1 WsEvent dropped AgentSpawnRequested/AgentReleaseRequested variants; preserve logic verbatim for increment 2 to call from action.invoke

### Updated cli_mcp_args + delivery-read-ack test mocks from /v1/agents/spawn to /v1/agents with CreateAgentResponse body

- **Chose:** Updated cli_mcp_args + delivery-read-ack test mocks from /v1/agents/spawn to /v1/agents with CreateAgentResponse body
- **Reasoning:** v5.0.1 register_agent_token POSTs /v1/agents (CreateAgentResponse) instead of /v1/agents/spawn (spawn_agent); real SDK endpoint change, not a regression

---

## Chapters

### 1. Work

_Agent: default_

- Phase 1: extracted relay/web into ../agentrelay.com with full history via git-filter-repo; kept web/ as a subdir under a workspace root so router/ can join as a sibling: Phase 1: extracted relay/web into ../agentrelay.com with full history via git-filter-repo; kept web/ as a subdir under a workspace root so router/ can join as a sibling
- Deferred relay-side deletion of web/ and Phases 2-3 (router relocation, domain consolidation) pending the new repo deploying green: Deferred relay-side deletion of web/ and Phases 2-3 (router relocation, domain consolidation) pending the new repo deploying green
- Web hosting: wrangler-direct OpenNext-Cloudflare (no AWS), not sst.aws.Nextjs: Web hosting: wrangler-direct OpenNext-Cloudflare (no AWS), not sst.aws.Nextjs
- Bundle docs/blog content at build via require.context (lib/content-store.ts) to remove runtime fs: Bundle docs/blog content at build via require.context (lib/content-store.ts) to remove runtime fs
- agentrelay.com PR #1: web extracted with full history + fully running on Cloudflare Workers (no AWS), all routes 200 in workerd. Remaining: relay-side web/ deletion (after deploy), Phases 2-3 (router relocation, domain consolidation)
- Cutover wiring lined up: cloud#2438 (router fallback -> origin-web.agentrelay.com) and relay#1189 (remove web/ from monorepo). Both open, not merged. Merge order: deploy cloud#2438 + verify agentrelay.com, then merge relay#1189.
- Resolved PR 1188 Swift conflicts by keeping relaycast-backed AgentRelaySDK facade: Resolved PR 1188 Swift conflicts by keeping relaycast-backed AgentRelaySDK facade
- Resolved PR 1187 Python conflicts by preserving relaycast-sdk transport and inheriting relaycast-sdk base URL defaults: Resolved PR 1187 Python conflicts by preserving relaycast-sdk transport and inheriting relaycast-sdk base URL defaults
- Extracted firehose spawn/release arms into free async fns release_worker_locally + spawn_worker_from_request (params take &RelayWorkspace + captured context): Extracted firehose spawn/release arms into free async fns release_worker_locally + spawn_worker_from_request (params take &RelayWorkspace + captured context)
- Updated cli_mcp_args + delivery-read-ack test mocks from /v1/agents/spawn to /v1/agents with CreateAgentResponse body: Updated cli_mcp_args + delivery-read-ack test mocks from /v1/agents/spawn to /v1/agents with CreateAgentResponse body

---

## Artifacts

**Commits:** 54672ae1, 877b72e1, e6771b4b, 76dcdfb1, 8ada1f60, e9bf640b, e08b39ed, 39b604c5, 404535dd, 7de17e97, 0654f9db, 82691d5e, 2f25062d, 955de903, 3f293f11, 86ad9b4f, 2e39a347, 2eb86d0c
**Files changed:** 435
