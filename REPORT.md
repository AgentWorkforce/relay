# Relay #1919 investigation report

## Scope and evidence baseline

- Relay source: `origin/main` at `20ae3e3985ed598febbc3dcd503e785e2034aeb3` (CLI 13.1.5).
- Cloud source was read remotely and left unchanged: `AgentWorkforce/cloud` main at `9ccc008a568b799dd719eb44e6aac5371a946a46`.
- Issue #1919 and both lane comments were read in full.
- Open Relay PR #1672 was inspected at `79d0fbf6cfea5b25658455aa76752ec7329bd205`.
- No Fleet worker, provider sandbox, or provider API was invoked during this investigation.

## Route-selection fix

`resolveBaseUrlForSelection` previously collapsed the explicit `--base-url` value and ambient `RELAY_BASE_URL` into one `requested` value. Once Cloud had persisted the isolated route, the ambient canonical origin was therefore treated like an explicit challenge and rejected.

The fix keeps the two sources distinct:

- an explicit conflicting `--base-url` still fails closed with `The requested Relaycast base URL does not match the persisted workspace route.`;
- without the flag, a validated persisted server-selected route wins over ambient `RELAY_BASE_URL`;
- without a persisted route, explicit then ambient precedence is unchanged;
- `resolveWorkspaceTransport` continues to return the persisted route and `relaycastApiKey` together, so the origin and route-scoped credential cannot be split.

Because the change is in the shared helper, the corrected precedence applies to every workspace-scoped caller found by grep, not just `fleet release`:

- direct transport users: Fleet (including release and attach), Observer, Integration inbound-target provisioning, and Fleet node terminal attach;
- direct base-URL users: Integration recipient/cleanup, join tickets, and the shared client factory;
- shared workspace-client users: Agent, Channel, Message, Capabilities, Integration, and Fleet commands.

Agent-token calls intentionally set `ignorePersistedRelaycastTarget`; their token-selected transport behavior is unchanged.

### Red/green proof

Before changing `sdk-client.ts`:

```text
$ npx vitest run packages/cli/src/cli/lib/sdk-client.test.ts \
    packages/cli/src/cli/commands/fleet-lifecycle-integration.test.ts
Test Files  2 failed (2)
Tests       3 failed | 42 passed (45)

FAIL ... prefers a persisted isolated route over an ambient canonical base URL
Error: The requested Relaycast base URL does not match the persisted workspace route.

FAIL ... constructs the client with the persisted origin and its route-scoped credential
Error: The requested Relaycast base URL does not match the persisted workspace route.

FAIL ... reuses the persisted Cloud target across spawn, attach, message, list, and release without --base-url
Error: __exit__
```

After the shared helper change:

```text
$ npx vitest run packages/cli/src/cli/lib/sdk-client.test.ts \
    packages/cli/src/cli/commands/fleet-lifecycle-integration.test.ts
Test Files  2 passed (2)
Tests       45 passed (45)
```

The explicit-conflict and no-persisted-route cases already passed before the source change and remain regression guardrails for the required unchanged behavior. The three source-dependent cases above fail when the helper change is reverted.

### Verification

- CLI package suite (serialized): `96 passed, 1 skipped` test files; `1,992 passed, 11 skipped` tests.
- Affected-area suite: `6 passed` files; `226 passed` tests.
- `npm run typecheck`: passed.
- CLI ESLint: passed.
- Prettier check for changed files: passed.

## What `fleet release` promises for a sandbox-backed worker

Today it promises dispatch of the Relaycast agent-release action, not teardown of the backing Cloud/provider sandbox.

1. The CLI calls `workspace.agents.release(...)` and then prints the returned JSON unchanged. With `--delete-agent`, it calls the same agent release API a second time after provider-binding retirement; this deletes the Relaycast agent identity, not a Cloud sandbox ([`fleet.ts:1260-1292`](https://github.com/AgentWorkforce/relay/blob/20ae3e3985ed598febbc3dcd503e785e2034aeb3/packages/cli/src/cli/commands/fleet.ts#L1260-L1292)).
2. The SDK normalizes and immediately returns the action acknowledgement ([`relaycast.ts:290-292`](https://github.com/AgentWorkforce/relay/blob/20ae3e3985ed598febbc3dcd503e785e2034aeb3/packages/sdk/src/messaging/relaycast.ts#L290-L292)). A response with `status: dispatched` proves the action was routed, not that the inner agent, node, provider sandbox, or Cloud row is absent.
3. The CLI emits no post-dispatch warning that a sandbox may still be running or billing. It writes exactly the one JSON acknowledgement to stdout ([`fleet.ts:1292`](https://github.com/AgentWorkforce/relay/blob/20ae3e3985ed598febbc3dcd503e785e2034aeb3/packages/cli/src/cli/commands/fleet.ts#L1292), [`fleet.test.ts:5158-5205`](https://github.com/AgentWorkforce/relay/blob/20ae3e3985ed598febbc3dcd503e785e2034aeb3/packages/cli/src/cli/commands/fleet.test.ts#L5158-L5205)).

That matches the Agent37 evidence: the workaround reached the handler and the inner agent went offline, but the node kept heartbeating and both the provider instance and Cloud ledger row remained live.

## Does a sandbox teardown endpoint exist?

Yes.

- Relay's Cloud client exposes `deleteCloudFleetSandbox`, which sends `DELETE /api/v1/fleet/nodes/sandbox/:sandboxId` with the Cloud workspace and optional provider identity ([`fleet-sandbox.ts:1165-1193`](https://github.com/AgentWorkforce/relay/blob/20ae3e3985ed598febbc3dcd503e785e2034aeb3/packages/cloud/src/fleet-sandbox.ts#L1165-L1193)).
- Cloud implements that route, authorizes the exact workspace/requester, calls `deleteFleetJitSandbox`, and returns only after the deletion path reports success ([Cloud route `:95-176`](https://github.com/AgentWorkforce/cloud/blob/9ccc008a568b799dd719eb44e6aac5371a946a46/packages/web/app/api/v1/fleet/nodes/sandbox/%5BsandboxId%5D/route.ts#L95-L176)).
- `deleteFleetJitSandbox` looks up the durable Fleet-JIT row, destroys the provider sandbox, and terminalizes the row ([`sandbox-deletion.ts:355-461`](https://github.com/AgentWorkforce/cloud/blob/9ccc008a568b799dd719eb44e6aac5371a946a46/packages/web/lib/fleet/sandbox-deletion.ts#L355-L461)).

`fleet release` does not call this endpoint. In `fleet.ts`, every `deleteCloudFleetSandbox(...)` call is in sandbox provisioning/spawn compensation (verification failure, timeout, missing mount, or confirmed spawn failure). There is no call in the release command.

## Scheduled reclaimer semantics

The reclaimer is a conditional safety backstop, not part of `fleet release` and not a two-hour teardown SLA.

- The default minimum sandbox age and agent inactivity are both two hours, with three observations spaced 30 seconds apart and at most five destroys per sweep ([`jit-sandbox-reclaim.ts:280-313`](https://github.com/AgentWorkforce/cloud/blob/9ccc008a568b799dd719eb44e6aac5371a946a46/packages/web/lib/fleet/jit-sandbox-reclaim.ts#L280-L313)).
- It is a no-op unless `FLEET_JIT_SANDBOX_RECLAIM_ENABLED=true` and the workspace is in the configured allowlist ([`jit-sandbox-reclaim.ts:343-390`](https://github.com/AgentWorkforce/cloud/blob/9ccc008a568b799dd719eb44e6aac5371a946a46/packages/web/lib/fleet/jit-sandbox-reclaim.ts#L343-L390)).
- Relaycron describes it as the previously missing caller for successfully provisioned sandboxes and delegates the safety decision to Cloud ([`sweep.ts:629-640`](https://github.com/AgentWorkforce/cloud/blob/9ccc008a568b799dd719eb44e6aac5371a946a46/packages/relaycron/src/sweep.ts#L629-L640)).

The code therefore explains how a sandbox can remain live after 3.5 hours: merely crossing the two-hour defaults does not prove the feature was enabled, the workspace was allowlisted, the sandbox was eligible, all observations passed, or a sweep completed.

## Overlap with open PR #1672

PR #1672 overlaps only with the inner-worker part of release. It hardens broker process-tree termination, deregistration, error correlation, idempotency, and roster/process absence checks. At its current head, the diff changes broker Rust, harness-driver support, and Fleet/RelayFlow tests; it contains no CLI release, SDK release, Cloud sandbox client, Cloud route, or provider teardown change.

So #1672 can make an accepted agent-release action more actionable, but it does not make `fleet release` destroy a paid sandbox and does not change the meaning of the asynchronous CLI acknowledgement.

## Smallest follow-up

Opened [Relay #1922](https://github.com/AgentWorkforce/relay/issues/1922): add a stderr warning after a dispatched release stating that sandbox teardown is not performed and cost may continue, while preserving the one-JSON-document stdout contract.

This is smaller and safer than `--teardown`: the current release command does not carry an authoritative worker-to-Cloud-sandbox identity, so wiring the existing destructive endpoint requires a separate provenance and authorization design.

## PR and CI

To be updated after the PR is opened and all workflows settle.
