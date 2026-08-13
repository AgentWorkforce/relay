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
