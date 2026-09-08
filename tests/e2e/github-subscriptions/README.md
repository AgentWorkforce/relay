# GitHub subscription demo validation

This runner uses real GitHub fixtures and observes the receiving harness. It never sends an event nonce to the receiver outside GitHub. A successful HTTP request or a channel message is insufficient: `assert` requires the trusted webhook agent ID, exact authenticated provider semantics, correlated broker `delivery_injected`, and an exact digest response from the pinned actor ID. The observer polls channel history; the receiving agent must not poll. Fresh Claude proof workers are launched with inbox/history/search/resource-read tools disabled through repeatable `--spawn-arg` arguments; capture their tool-call names to verify that no receiver polling occurred. An existing worker must have equivalent verified restrictions before its results qualify.

Use Node 22+, `gh` authenticated for the three demo repositories, a built Relay CLI/harness driver/broker, and the reviewed Relaycast engine deployed in the intended environment. Record observed deployed revisions, not merely source or package versions. Shared Relayfile rollout remains with its incident owner. Product PRs must be approved and released normally.

Copy `config.example.json` outside the repository and choose a unique run ID/output directory. Keep credentials in `RELAY_WORKSPACE_KEY`, never in the config, command line, transcript, or committed files. Pin the real recipient's agent ID and the webhook system agent ID from authenticated roster/history reads. The chief row must reference actual `chief` on its own node; a disposable worker cannot satisfy gate 9.

```sh
node tests/e2e/github-subscriptions/run.mjs receiver-task /absolute/demo-config.json
node tests/e2e/github-subscriptions/run.mjs prepare /absolute/demo-config.json
```

`prepare` creates one clearly labelled PR per repository, each targeting its own disposable base branch. It records every acknowledged mutation immediately in `manifest.json`; it never updates main. If interrupted between a server mutation and the manifest write, reconcile the deterministic branch/PR names before retrying. Never adopt an unrelated existing fixture. Comments and reviews remain on closed disposable PRs as evidence after cleanup.

The runner can provision and update its owned subscriptions using `subscribe`, and retire them using `unsubscribe`. It refuses unowned binding replacements and verifies old resource IDs disappear. Set `brokerProjectRoot`, `receiverCwd`, `receiverCli`, `subscriptionScope` (`issue`, `pr`, or `repo`) and `spawnReceiver` explicitly. For chief, set `spawnReceiver: false`. Start `collect` before `subscribe`; it reloads channel configuration after provisioning.

```sh
node tests/e2e/github-subscriptions/run.mjs subscribe /absolute/demo-config.json
# Repeat to exercise create-first replacement and retirement of prior IDs.
node tests/e2e/github-subscriptions/run.mjs subscribe /absolute/demo-config.json
node tests/e2e/github-subscriptions/run.mjs unsubscribe /absolute/demo-config.json
```

Provision subscriptions with the built CLI from the project attached to the intended broker. Before changing anything, record `RelayfileControlPlaneClient.listBindings()` and `listWebhookSubscriptions(workspace)` and the Relaycast webhook inventory. An inventory timeout is a failed preflight, not permission to overwrite unknown configuration. The current binding key is `(provider, resolved path glob)`: subscribing to the same resource replaces its route. Use fresh fixture scopes and record the previous binding before testing an update.

For explicit context use a canonical VFS glob. `owner/repo` resolves repository scope; provider URLs are not currently accepted by the Relayfile resolver. Examples below are syntax examples; replace `123` with the owned manifest number.

```sh
# A real, confirmed harness is launched before the subscription is created.
agent-relay integration subscribe github \
  --resource '/github/repos/AgentWorkforce/relay/issues/123/**' \
  --to @ghsub-demo-worker --spawn claude --broker-connection /absolute/node/state/connection.json --cwd /absolute/fixture-workdir \
  --task "$(node /absolute/relay/tests/e2e/github-subscriptions/run.mjs receiver-task /absolute/demo-config.json)"

# PR metadata context and repository context are explicit separate scopes.
agent-relay integration subscribe github \
  --resource '/github/repos/AgentWorkforce/relay/pulls/123/**' --to @ghsub-demo-worker
```

Issue comments on a PR use GitHub's issue-comment path; do not assume a `/pulls/123/**` subscription includes `/issues/123/comments/**`. Use the resolved path and authenticated resource reference printed in evidence. For chief's full PR/CI/review matrix, record prior configuration and use the approved repository/event scopes that cover the actual producer's paths. Do not replace chief or manually invite workers to repair failed spawn membership. The owner-authorized subscription endpoint provisions the recipient's identity-bound channel. Normal channel history is not a privacy boundary.

Start the collector before launching the receiver so readiness and the first idle boundary are observed. Configure receiver and negative channels in advance. Use a separate collector on chief's node for its broker delivery evidence; the same run format supports `receiver: "chief"`. Bound each collector to 1,800 seconds, a stimulus response wait to 180 seconds, and negative observation to at least 120 seconds. Keep collectors continuous during each case; a missing interval invalidates a negative assertion.

```sh
node tests/e2e/github-subscriptions/run.mjs collect /absolute/demo-config.json
# In another terminal, after a fresh observed idle boundary:
node tests/e2e/github-subscriptions/run.mjs preflight /absolute/demo-config.json
node tests/e2e/github-subscriptions/run.mjs emit /absolute/demo-config.json relay comment
node tests/e2e/github-subscriptions/run.mjs assert /absolute/demo-config.json
# Wait for a NEW idle boundary, then repeat:
node tests/e2e/github-subscriptions/run.mjs emit /absolute/demo-config.json relay comment
```

Complete this finite acceptance schedule and attach the results to the scoreboard:

| Gate | Required run                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Three repositories, scoped must-fire and off-scope must-not-fire, create → update → unsubscribe; compare inventories and exact replaced IDs.                                                                                                                                                                                                                                                                 |
| 2    | Two successive events separated by observed idle boundaries; another after 600 seconds of uninterrupted idle; another when every real channel member is idle. No poke, DM, mention or PTY injection between events.                                                                                                                                                                                          |
| 3    | Create one pre-join event, then subscribe a new identity: no delivery row for that old message. Send ten unique events while the receiver is busy and require all ten digest actions. Test a duplicate ID at the signed ingress boundary, capacity overflow/503/retry, and inspect dead letters. Record oldest event age and latency; FIFO preserves all unique events rather than silently coalescing them. |
| 4    | Exact recipient and a nonmember negative agent; leave/rejoin, delete/recreate identity; new name must not inherit old identity subscriptions.                                                                                                                                                                                                                                                                |
| 5    | Exact hyphenated muted target, muted prefix negative, duplicate and escaped mentions, invalid authorization. These are direct message conformance tests, separate from the unmentioned GitHub wake proof.                                                                                                                                                                                                    |
| 6    | Supported local API, SDK and raw/persona fleet spawn paths with two explicit channels; independently read channel members without a manual invite.                                                                                                                                                                                                                                                           |
| 7    | Invalid cwd, early harness exit, unavailable target, retry/idempotency and generation-safe cleanup; compare before/after subscriptions, hooks and bindings, all zero additions on failure.                                                                                                                                                                                                                   |
| 8    | Explicit issue, PR and repository resource contexts with confirmed ready PID/membership; explicit workspace credentials plus ambient agent token; ambiguous prose must not broaden scope.                                                                                                                                                                                                                    |
| 9    | Actual chief: each repository × merged PR, CI conclusion, submitted review, newly created review thread. Use a separate chief collector and require chief's exact actor ID/action. Off-scope events must not arrive.                                                                                                                                                                                         |

`emit` supports `comment`, `review`, `thread`, `ci`, and `merge`. Reviews use COMMENT, including on the operator's own PR; they do not approve code. `thread` creates a root diff comment (GitHub `pull_request_review_comment.created`, no `in_reply_to_id`), which is the semantic creation of a review thread. GitHub's `pull_request_review_thread` webhook reports resolution changes, not creation. `ci` adds a minimal GitHub Actions workflow only to the fixture head, generating a real completed check. It requires workflow write permission and an enabled Actions runner. `merge` verifies both owned fixture refs and merges only into the disposable base; run it last. `--busy` permits a stimulus without a new idle boundary and marks that fact in evidence; it cannot pass an idle case.

Replay/reconnect must use only the disposable receiver. Record its generation and reconnect boundary; repeat a real stimulus after reconnection and require exactly one action for each unique event. Do not touch alpha, beta, gamma, chief's process, or the incident broker. Keep the assignment's concurrent worker limit while reviewing/testing.

```sh
node tests/e2e/github-subscriptions/run.mjs assert /absolute/demo-config.json
node tests/e2e/github-subscriptions/run.mjs cleanup /absolute/demo-config.json
```

Unsubscribe only owned resources, verify their binding/subscription/webhook IDs disappeared, restore recorded prior routes when applicable, then release only the owned receiver generation. Fixture cleanup intentionally does not delete subscriptions by guessed name or delete chief. Preserve evidence before cleanup. The runner's `capturedStimuliPass` is scoped to its captured events and **never sets nine-gate READY**. Final signoff additionally requires complete continuous observation, independent review and all nine target-environment gates.

Run assertion regression tests without credentials or outward mutations:

```sh
node --test tests/e2e/github-subscriptions/proof.test.mjs
```

For an isolated HTTP/WebSocket/broker rehearsal of invalid cwd, early process exit, two-channel membership and generation-safe release, run `local-startup.mjs` with `RELAYCAST_ENGINE_DIR` and `BROKER_BINARY_PATH` pointing to candidate builds. It uses native process fixtures, not an AI harness or real GitHub delivery, and never marks live readiness.

Subscribe-on-spawn requires the selected broker to advertise create-only identity
registration and explicit empty-channel support in `/api/session`. The CLI refuses
an older broker before launching; it also checks the effective channel list in
the spawn response. Existing confirmed local workers are reused without claiming
ownership. For new-worker cleanup, deploy the engine's correlated
`agent.deregister` acknowledgement support before upgrading the broker.

The isolated `local-startup.mjs` rehearsal reads live agent memberships, including an empty channel set, and exercises delayed pre-ready exit, same-name retry, idempotent cleanup, replacement-generation protection, and fleet action failure cleanup. The engine must support `auto_join_general: false` and acknowledged node deregistration. Registration defaults remain compatible for other clients; recovery preserves the current membership set. Cached channel metadata is not accepted as proof of isolation.

The isolated Claude rehearsal used `RELAY_INJECT_RATE_MS=0` on its disposable broker: default paced typing exceeded the initial-task deadline on the test host. Record this setting if used for the intended disposable demo broker; it is not permission to change a shared broker. Two idle responses alone do not validate default pacing.

Run the real Claude rehearsal against local candidate builds with a fresh output directory:

```sh
RELAYCAST_ENGINE_DIR=/absolute/relaycast \
BROKER_BINARY_PATH=/absolute/agent-relay-broker \
LOCAL_AI_INJECT_RATE_MS=0 \
LOCAL_AI_EXPECTED_HEAD=FULL_REVIEWED_COMMIT_SHA \
node tests/e2e/github-subscriptions/local-ai.mjs /absolute/fresh-ai-evidence
```

This starts one actual Claude worker. Keep the assignment's independent reviewer stopped until cleanup completes. It verifies two successive idle actions, a600-second idle interval, ten distinct burst events, duplicate idempotency, no pre-join replay and an actual node WebSocket reconnect. Its signed producer is synthetic; these results cannot satisfy the real GitHub or actual-chief gates. It retains broker events, source/binary and runner/helper hashes, sanitized logs, channel messages and receiver tool-call names. Missing tool evidence, history/network polling, cleanup failure or missing digest action fails the run. `LOCAL_AI_LONG_IDLE_MS` may shorten a repair rerun, but such a run is not ten-minute idle proof.

Set `LOCAL_AI_CLI=codex` for a separately labeled actual Codex proof using an existing
logged-in Codex installation. This pins the actor to `gpt-6-astra` with high reasoning,
restricts the Relay MCP server to `post_message`, and disables web search, apps,
multi-agent tools. The installed Codex code-mode host stays enabled; its tool calls
are parsed as syntax, never evaluated by the auditor, and only a single literal
digest/action call inside `text(await tools.tool(...))` is accepted. The audit requires exactly one newly created Codex
session with the disposable worker's exact cwd, retains its ID/version/transcript
hash and sanitized tool-call metadata, and rejects every tool except the prescribed
digest-only shell command and Relay `post_message`. It does not copy credentials or
change the user's Codex configuration. Unsupported transcript formats fail the audit.
Run only after the independent reviewer exits. Codex results do not establish
Claude-specific behavior; neither provider's synthetic ingress proof establishes
real GitHub delivery or actual-chief acceptance.

Owned cleanup runs independently of the broker API loop. The name and generation remain reserved until confirmed deletion; failed attempts retry up to five times at five-second intervals. A generation-guarded release retries retained cleanup. API failures identify unconfirmed cleanup and its generation; they do not claim resources are gone. Shutdown waits up to one second for pending cleanup and logs any generation still requiring reconciliation.
