# Slack Primitive — Design Spec

**Status**: Draft
**Date**: 2026-05-05
**Author**: design session (human + Claude)
**Related**: `packages/github-primitive` (precedent), `skills/writing-agent-relay-workflows` (recipe #4 — Escalation)

---

## 1. Why this primitive

Workflows already produce _code_ — Phase C push-back lands the diff, the github-primitive opens the PR. What workflows can't yet do well is **talk to a human in the loop**:

- Tell the human something happened ("PR #451 opened, here's the diff").
- Ask the human a question and **wait for the answer** ("Is this the right account ID? I see two candidates.").
- Surface a blocker ("Auth failed, I need someone to re-auth this connection.").

Today the answer is "post in a Slack-bridged relay channel and hope the bridge is up." That works in a sandbox where someone is watching. It does not work for cloud runs that the operator has walked away from. **The Slack primitive turns Slack into a first-class transport for workflow ↔ human communication**, with the same local/cloud adapter shape as the github-primitive, so the same workflow file works on a laptop and in `agent-relay cloud run`.

This spec defines the API, runtime selection, and the two flagship verbs:

1. **`postMessage`** — fire-and-forget human notification.
2. **`askQuestion`** — block the workflow on a human reply.

Plus the cultural change it's meant to enable: **agents should ask for clarification when blocked rather than hallucinate a fix**.

## 2. What we're not building (yet)

- A general-purpose Slack bot. The primitive is **outbound from the workflow**: it posts and it waits-for-reply. Inbound message classification, slash commands, app home views, etc., are out of scope.
- Channel/user provisioning. The workflow assumes the channel and the bot user already exist.
- Threaded conversations beyond a single round-trip. `askQuestion` reads exactly one reply (configurable: first reply, first reply by a specific user, first reply matching a regex). Multi-turn dialogue with the same agent goes through the existing relay channel primitive.

## 3. Runtime selection (mirrors github-primitive)

```ts
type SlackRuntimePreference = 'local' | 'cloud' | 'auto';
```

| Runtime            | Transport                   | Auth source                      | When chosen                                            |
| ------------------ | --------------------------- | -------------------------------- | ------------------------------------------------------ |
| `local`            | Slack Web API directly      | `SLACK_BOT_TOKEN` env or config  | Operator running `agent-relay run` from a laptop       |
| `cloud`            | Nango → Slack workspace App | Nango connection (per-workspace) | `agent-relay cloud run`, workspace has Slack connected |
| `cloud` (fallback) | Relay-cloud Slack proxy     | Workspace bearer token           | `agent-relay cloud run`, no Nango Slack connection     |
| `auto`             | Detects the above in order  | —                                | Default                                                |

Same as github-primitive: **the workflow author writes one file**. `runtime: 'auto'` does the right thing on a laptop and in cloud.

### Auth resolution (cloud path)

Cloud's lambda already wires `Resource.NangoSecretKey.value` and resolves `(workspaceId, provider) → connectionId`. The Slack primitive's `cloud-runtime` reuses that resolver — no new resource binding.

For Slack, we expect the connection to be a **bot user OAuth token** (xoxb-_), not user-token (xoxp-_). Posting and reading replies both work with `chat:write`, `channels:history`, and `groups:history` scopes. The primitive validates scopes on first call and throws a typed error early if they're missing.

## 4. Public API

The shape is the same as github-primitive: a `SlackClient` for direct calls, a `SlackStepExecutor` + `createSlackStep` for declarative use inside `workflow(...)`. Most workflows use the step form.

### 4.1 Action enum

```ts
export enum SlackAction {
  PostMessage = 'postMessage',
  AskQuestion = 'askQuestion',
  UpdateMessage = 'updateMessage',
  AddReaction = 'addReaction',
  ReplyToThread = 'replyToThread',
  ResolveUser = 'resolveUser', // email/handle -> user id
  ResolveChannel = 'resolveChannel', // name -> channel id
}
```

The first two are the load-bearing ones. The rest exist to make the first two pleasant (e.g. `ResolveUser` so you can write `@khaliq` instead of `U02ABC123` in workflow source).

### 4.2 `postMessage`

```ts
createSlackStep({
  name: 'announce-pr',
  action: 'postMessage',
  params: {
    channel: '#wf-feature',           // or channel id
    text: 'PR opened: {{steps.open-pr.output.html_url}}',
    threadTs?: string,                 // reply into a thread
    mentions?: string[],               // ['@khaliq', 'U02ABC123', 'khaliq@agent-relay.com']
    blocks?: SlackBlock[],             // optional rich blocks
    unfurl?: boolean,                  // default true
  },
  output: { mode: 'data', path: 'ts' }, // message timestamp for follow-ups
})
```

Notes:

- **Mentions are resolved before send.** `@khaliq` is looked up via `users.lookupByEmail` or the user-cache; if not found, the message still posts but a typed `SlackPostBackError(unknown_mention)` is logged on the step output. This is the same "fail soft on cosmetic errors, fail hard on real errors" pattern as github-primitive.
- **Templating uses the existing `{{steps.X.output.path}}` chain.** No special Slack-specific templating syntax.
- **Channel may be a name (`#wf-feature`) or ID.** Names are resolved at step time.

### 4.3 `askQuestion` — the load-bearing verb

```ts
createSlackStep({
  name: 'confirm-account',
  action: 'askQuestion',
  params: {
    channel: '#wf-feature',
    text: 'I found two AWS accounts that match `prod-*`. Which one should I deploy to?\n  • acct-1234 (us-east-1, last modified 2 weeks ago)\n  • acct-5678 (us-west-2, last modified yesterday)\nReply with `1` or `2`.',

    // How long to wait before failing the step
    timeoutSeconds: 1800,           // 30 min default; required to set explicitly

    // Who is allowed to answer. Default: anyone in the channel.
    allowedReplyFrom?: string[],    // ['@khaliq']

    // What constitutes a valid reply. Default: any non-empty text.
    replyMatch?:
      | { type: 'regex'; pattern: string }
      | { type: 'choice'; choices: string[] }      // exact match against one of these
      | { type: 'any' },

    // Optional: a structured form via Slack Block Kit. When set, the
    // primitive renders a button group / select / etc. and the
    // step output is the chosen value, not the raw reply text.
    interactive?: SlackInteractiveSpec,
  },
  output: {
    mode: 'data',
    // The step output is the parsed answer:
    //   { reply: string, replierUserId: string, replyTs: string,
    //     matchedChoice?: string, matchedGroups?: string[] }
  },
})
```

Semantics:

1. The primitive posts the question, with the workflow run id appended in small text so a human can find the source run.
2. It begins polling `conversations.history` (cloud) or subscribing via Slack Events API webhook (when configured) for replies in the channel after the question's `ts`. **No global event listener** — each `askQuestion` step polls its own scope, then unsubscribes. This is important: workflows must not interfere with each other.
3. On a reply that matches `replyMatch` from a user in `allowedReplyFrom`:
   - Reaction `:eyes:` added to the question (so the human sees their answer was registered).
   - Step succeeds with the parsed reply as output.
4. On timeout: step fails with a typed `SlackPostBackError(human_no_response, timeoutSeconds)` so the workflow's `onError` handler can decide whether to retry, escalate again, or hard-fail.
5. The primitive **never** falls back to a default answer. Silence is failure.

#### Why `askQuestion` is the hard part

Posting is trivial. Waiting on a human is the load-bearing piece. It introduces three constraints the rest of the SDK doesn't have:

- **Workflows must be allowed to block on external input.** The runner already supports long-running steps (verification gates, sandbox bootstraps), so this is reusing existing plumbing — not inventing new lifecycle.
- **The step must be resumable.** If the workflow crashes between posting the question and receiving the answer, the resumed run must find the existing question (by run-id-tagged metadata in the message) and continue waiting from there, not re-ask. Implementation: stash `(questionTs, runId, stepName)` in the workflow run record before the polling loop starts; on resume, look up the row and rejoin the poll.
- **The channel's history must include the question.** This means cloud-runtime cannot use private DMs (the bot can't read DM history without `im:history` scope and that scope is rarely granted). `askQuestion` against a DM throws at validation time.

### 4.4 `replyToThread`, `updateMessage`, `addReaction`

These are utility verbs that exist so post/ask flows can be cleaned up:

- `replyToThread` — post into the thread of a prior message (e.g. announce intermediate progress on a long workflow).
- `updateMessage` — edit a posted message (e.g. update a "running…" message to "done ✅" with the PR link).
- `addReaction` — `:white_check_mark:` on the question once the workflow's downstream succeeded; `:x:` on failure.

## 5. Two recipes the skill should encourage

These go into `skills/writing-agent-relay-workflows/SKILL.md` as new chat-native coordination recipes the moment the primitive ships.

### 5.1 Announce + Done (post-result notification)

```ts
.step(createSlackStep({
  name: 'notify-pr',
  dependsOn: ['open-pr'],
  action: 'postMessage',
  params: {
    channel: '#eng-cloud',
    text: 'Workflow `{{workflow.name}}` opened {{steps.open-pr.output.html_url}}.',
    mentions: ['@khaliq'],
  },
}), { executor: slack })
```

Pair with the github-primitive's `createPR` step. Whenever a workflow ships a PR, post a one-liner in a channel humans actually watch. This is what closes the loop — without it, PRs created by cloud workflows live in a tab no one opens.

### 5.2 Ask Before You Guess (clarification)

```ts
.step('plan', {
  agent: 'lead',
  task: `... investigate the schema ...

If the migration is ambiguous in any of these ways, do NOT guess and do NOT
pick one heuristically:
  - the column to drop has data in production
  - two tables both look like candidates for the FK target
  - the index name conflicts with an existing one in a sibling repo

Use the slack primitive to ask the human:

  await slack.askQuestion({
    channel: '#wf-migration',
    text: 'I see two candidates for the FK target. Which one?',
    timeoutSeconds: 1800,
    replyMatch: { type: 'choice', choices: ['users', 'accounts'] },
  });

Resume only after you get an answer. Do not exit. Do not pick a default.
`,
})
```

The cultural rule the skill should make explicit: **guessing is worse than asking.** Agents should be told, in their task strings, to escalate via Slack when they hit ambiguity in:

- account/credential choice
- destructive operations (drops, deletes, force-pushes)
- scope conflicts ("the spec says X but the existing code does Y")
- upstream dependencies that look stale or broken

The agent posts the question, waits, and resumes from the answer. The workflow remains deterministic from the runner's point of view — only the _content_ of one step's output is human-supplied.

## 6. Failure modes & error codes

```ts
type SlackPostBackErrorCode =
  | 'auth_token_missing' // local: no SLACK_BOT_TOKEN; cloud: no Nango connection
  | 'auth_token_invalid' // 401 from Slack — token revoked or wrong env
  | 'missing_scope' // bot lacks chat:write / channels:history / etc.
  | 'channel_not_found' // name didn't resolve, or bot not invited
  | 'unknown_mention' // @-mention couldn't be resolved (soft error, logged)
  | 'human_no_response' // askQuestion hit timeoutSeconds
  | 'reply_did_not_match' // got a reply but replyMatch rejected it
  | 'reply_from_unauthorized_user'
  | 'rate_limited' // 429, with retry-after honored automatically
  | 'slack_api_error'; // catch-all, includes upstream message
```

These match the github-primitive's error-code shape so workflow `onError` handlers can discriminate on `err.code` consistently across primitives.

## 7. Implementation outline

```
packages/slack-primitive/
  src/
    index.ts            // public exports
    types.ts            // SlackAction, SlackRuntimeConfig, SlackPostBackError
    client.ts           // SlackClient — direct API
    workflow-step.ts    // SlackStepExecutor + createSlackStep
    local-runtime.ts    // Web API via @slack/web-api
    cloud-runtime.ts    // Nango proxy + relay-cloud fallback
    adapter.ts          // runtime detection + selection
    actions/
      post-message.ts
      ask-question.ts
      reply-to-thread.ts
      update-message.ts
      resolve-user.ts
      resolve-channel.ts
    __tests__/
  examples/
    end-to-end-ask-question.ts
    notify-on-pr.ts
```

Keep it 1:1 with `packages/github-primitive` so anyone who learned one can read the other in five minutes.

### Cloud-runtime token sourcing

The cloud runtime calls Nango via `nango.proxy({ providerConfigKey, connectionId, method: 'POST', endpoint: '/chat.postMessage', data: {...} })`. Slack accepts both bot-token (xoxb-\*) and user-token; the connection must be configured for bot-token in the Nango Slack integration. Unlike github-app, there's no "give me a token to use directly" semantic — Slack tokens don't rotate per-call — so the proxy form is the right shape here. (This avoids the `nango.getToken(..., true)` confusion the github-primitive had to work through.)

### Local-runtime token sourcing

```ts
const token = config.token ?? process.env.SLACK_BOT_TOKEN;
```

If neither is set and we're in `auto` mode, `local` is _not_ selected; `auto` falls through to `cloud`. The detection chain is the same as github-primitive's.

## 8. Open questions

- **DM support.** Should `askQuestion` to a DM be supported when `im:history` is granted? Probably yes, gated on scope check. Defer to v2.
- **Slack Connect / shared channels.** The primitive should treat shared channels exactly like internal ones — the bot just needs to be invited. Need to verify Nango's Slack provider exposes them correctly.
- **Audit trail.** Cloud should write every `askQuestion` exchange to the workflow run record so post-mortems can see what the agent asked and how the human answered. This is straightforward but needs schema work; out of scope for the primitive itself.
- **Default channel resolution.** If the workflow doesn't specify a channel, should the primitive default to the workspace's "wf-default" channel? I think no — the workflow author should be explicit. But cloud could surface the default as `Resource.SlackDefaultChannel.value` for convenience.
- **Question idempotency on retry.** When a step retries (e.g. `retries: 2`), the second attempt should _not_ re-ask. The primitive should check the channel for an existing question with the same `(runId, stepName)` tag and resume waiting. Mentioned above under resumability — calling out here as the same mechanism.

## 9. Acceptance criteria for v1

The primitive ships when:

1. The same workflow file runs unmodified in `agent-relay run` (local) and `agent-relay cloud run` (cloud), posting a Slack message to the configured channel in both.
2. `askQuestion` blocks the workflow for at least 30 minutes, surfaces a reply matching the configured rule, and the parsed reply is available as `{{steps.X.output.reply}}` to downstream steps.
3. Workflow resume after a sandbox restart picks up an in-flight `askQuestion` from the message metadata rather than re-asking.
4. Mismatched scopes throw `missing_scope` at first call with a hint listing the missing scopes.
5. Cloud-runtime auth uses the workspace's existing Slack Nango connection — no new SST resource bindings, no new env vars beyond what github-primitive already added.
6. The `writing-agent-relay-workflows` skill has two new recipes: **Announce + Done** and **Ask Before You Guess**.

## 10. Phasing

| Phase | Scope                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | `postMessage` + `resolveUser` + `resolveChannel`; local + cloud-Nango runtimes; example workflow that posts a PR-opened notification.                                                   |
| **B** | `askQuestion` with `replyMatch: { type: 'any' \| 'choice' }`; resumability via run-record metadata; example workflow that asks "deploy to prod?" and gates a deploy step on the answer. |
| **C** | `interactive` Block Kit forms; `addReaction`, `updateMessage`, `replyToThread`; relay-cloud fallback transport; skill-doc update with the two recipes.                                  |

A and B together are the v1 shipped surface — they're what unblocks the "agent should ask rather than guess" cultural change. C is polish that makes the primitive pleasant to use in production workflows.
