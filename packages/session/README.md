# @agent-relay/session

Portable session continuity for Agent Relay. The SDK keeps one stable Relay
session ID across machines and AI harnesses while preserving the immutable
owner, current steerer, and full control-transfer audit trail.

## Install

```sh
npm install @agent-relay/session
```

Set `RELAYHISTORY_URL` to the Relayhistory deployment. The client accepts a URL
with or without the `/v1` suffix.

```sh
export RELAYHISTORY_URL=https://history.agentrelay.com
export RELAYHISTORY_TOKEN=...
```

`RELAYHISTORY_ACCESS_TOKEN` and `RELAY_AGENT_TOKEN` are supported as token
fallbacks.

Completed-session replay also joins the workspace-wide Relaycast conversation.
Set `RELAY_WORKSPACE_KEY` (or `AGENT_RELAY_WORKSPACE_KEY`) and, for a non-default
deployment, `RELAY_BASE_URL`. The `relay session replay` CLI uses the workspace
already selected for the current project when neither workspace-key variable is
set.

## Start and journal a session

```ts
import { SessionClient } from '@agent-relay/session';

const sessions = new SessionClient({ cli: 'claude', node: 'danny-mac' });
const owner = {
  userId: 'usr_danny',
  email: 'danny@example.com',
  displayName: 'Danny',
};

const session = await sessions.createSession({
  cli: 'claude',
  node: 'danny-mac',
  owner,
});

// Best effort: failures do not interrupt the harness. Pass onWriteError to
// SessionClient when the host wants logging or telemetry for failed writes.
void sessions.writeTurn({
  sessionId: session.sessionId,
  role: 'user',
  content: 'Continue the migration.',
  actor: owner,
});
```

## Resume from another harness

```ts
const sessions = new SessionClient({ cli: 'codex', node: 'dev-mac' });
const { session, turns, resume } = await sessions.resumeSession(relaySessionId);

if (resume.mode === 'native') {
  // Only selected for a Claude-origin session resumed by Claude.
  launchClaude(['--resume', resume.nativeResumeId]);
} else {
  // Codex, OpenCode, Grok, Cursor, and every cross-CLI handoff use this path.
  launchHarness({ prompt: resume.contextPrompt });
}
```

The injected prompt contains the ordered, attributed Relayhistory journal and
marks it as quoted prior context. Codex sessions are journal-only, including
Codex-to-Codex handoffs.

## Replay a completed multi-agent session

```ts
const replay = await sessions.replaySession(relaySessionId);

console.log(replay.contextPrompt);
console.log(replay.conversation.availability);
console.log(replay.conversation.retention);
```

`replaySession` joins Relayhistory turns with Relaycast messages stamped with
the same session reference, fetches every Relaycast page, and orders the joined
timeline by timestamp. Relaycast is workspace-wide, so the conversation slice
continues across nodes even though Relayhistory journals are per-node. A missing
node journal can still omit that node's private harness turns; the replay labels
that limitation and does not infer cross-node Relayhistory completeness.

Every replay prints the effective Relaycast retention boundary. `partial`,
`aged_out`, missing credentials, and unknown/query-failure results are marked
`INCOMPLETE` rather than presenting an empty conversation as proof that agents
did not communicate. The reachable conversation therefore extends only as far
back as the workspace plan's effective retention policy.

## Record steering and attribute commits

```ts
await sessions.recordSteering({
  sessionId: relaySessionId,
  actor: {
    userId: 'usr_dev',
    email: 'dev@example.com',
    displayName: 'Dev',
  },
  relayMessageId: '213570121302978560',
});

const trailers = await sessions.getGitTrailers(relaySessionId);
// Append trailers.join('\n') to the commit message.
```

Trailers include de-duplicated `Co-authored-by` identities plus stable
`Relay-Session-*`, active-actor, origin-CLI, and origin-node attribution.

## Relayhistory wire contract

The SDK uses the existing Relayhistory journal endpoints:

- `POST /v1/sessions/:sessionId/turns`
- `GET /v1/sessions/:sessionId/turns`

Creation and steering are durable system turns whose metadata carries the full
`RelaySession` snapshot. Ordinary user, assistant, and system turns use the
same ordered journal. This makes the backend journal the single source of truth
for conversation context and the identity audit trail.
