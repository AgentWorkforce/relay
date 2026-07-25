# Agent Relay CLI Telemetry

Agent Relay gathers non-user-identifying telemetry data about usage of the [agent-relay](https://www.npmjs.com/package/agent-relay) CLI, the command-line tool for coordinating AI coding agents.

You can [opt out of sharing telemetry data](#how-can-i-configure-telemetry) at any time.

## Why are we collecting telemetry data?

Telemetry allows us to better identify bugs and gain visibility on usage patterns across all users. It helps us make data-informed decisions about adding, improving, or removing features. We monitor and analyze this data to ensure Agent Relay's consistent growth, stability, and developer experience. For instance, if certain errors occur more frequently, those bug fixes will be prioritized in future releases.

## What telemetry data is Agent Relay collecting?

- **Broker lifecycle events**: When the broker starts and stops, including uptime duration and total number of agents spawned during the session
- **Agent spawn/release events**: Which CLI is being used (e.g., `claude`, `codex`, `gemini`), runtime type (e.g., `pty`), release reason, and agent lifetime in seconds
- **Agent crash events**: CLI type, exit code, and lifetime (no error messages or stack traces)
- **Message metadata**: Whether a message is a broadcast, whether it has a thread (no message content is collected)
- **CLI command usage**: Which commands are being run (e.g., `init`, `spawn`, `run`)
- **Version information**: The version of Agent Relay being used
- **System information**: Operating system and CPU architecture

### Account identity (only when you are signed in to Agent Relay Cloud)

If you have run `agent-relay cloud login`, telemetry is attributed to your cloud
account instead of an anonymous machine:

- **Your cloud user ID and organization ID/slug** are attached to events, so we
  can tell how many distinct people and companies use Agent Relay — a hashed
  machine ID cannot distinguish one person on three laptops from three people.
- **Your email and name** are recorded once as account attributes (not on every
  event) so support conversations can be matched to real usage.

This identity is resolved from Agent Relay Cloud at login and stored locally at
`~/.agentworkforce/relay/cloud-identity.json`. It is also forwarded to the
hosted Relaycast gateway (as `X-Agent-Relay-User-Id` / `X-Agent-Relay-Org-Id` /
`X-Agent-Relay-Org-Slug`) so server-side usage is attributed to the same account.
These values are used for analytics only and never affect what you can access.

If you have **not** signed in, none of this is collected and Agent Relay uses
only an anonymous, hashed machine ID to correlate events. Opting out of telemetry
(below) stops identity collection along with everything else, and
`agent-relay cloud logout` deletes the local identity file.

Run `agent-relay telemetry status` to see exactly which account — or none — your
usage is attributed to.

When Agent Relay talks to Relaycast Cloud, it sends that same anonymous ID with its requests (the `X-Agent-Relay-Distinct-Id` header) so server-side usage can be attributed to an install rather than to a workspace alone. It is not sent when telemetry is disabled by any of the methods below.

**Note**: This list is regularly audited to ensure its accuracy.

## What is NOT collected?

Agent Relay takes your privacy seriously and does **not** collect:

- Message content or agent task descriptions
- File names, paths, or file contents
- Error messages or stack traces
- Environment variables or secrets
- Agent names or workspace names
- API keys or authentication tokens
- IP addresses (beyond what is inherent in network requests)
- Source code or project information

Your email address is never attached to individual telemetry events — only to
your account record, and only when you are signed in (see above).

Data is never shared with third parties.

## How can I view what is being collected?

To see telemetry events being sent, set the `RUST_LOG` environment variable:

```sh
RUST_LOG=agent_relay::telemetry=debug agent-relay broker
```

The telemetry source code can be viewed at https://github.com/AgentWorkforce/relay/blob/main/src/telemetry.rs

All telemetry operations run in the background and will not delay command execution. If there's no internet connection, telemetry will fail silently.

## How can I configure telemetry?

### Disable telemetry

You can disable telemetry using any of these methods:

**Option 1: CLI command**

```sh
agent-relay telemetry disable
```

**Option 2: Environment variable**

```sh
export AGENT_RELAY_TELEMETRY_DISABLED=1
```

Agent Relay also honors the [`DO_NOT_TRACK`](https://consoledonottrack.com) convention for opting out of telemetry across all compatible tools:

```sh
export DO_NOT_TRACK=1
```

**Option 3: Configuration file**

Create or edit `~/.agentworkforce/relay/telemetry.json`:

```json
{
  "enabled": false
}
```

### Enable telemetry

To re-enable telemetry:

```sh
agent-relay telemetry enable
```

### Check telemetry status

To check whether telemetry is enabled, and which account (if any) your usage is
attributed to:

```sh
agent-relay telemetry status
```
