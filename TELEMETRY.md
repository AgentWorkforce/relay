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

Agent Relay uses an anonymous, hashed machine ID to correlate events. No personally identifiable information is collected.

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

**Option 3: Configuration file**

Create or edit `~/.agent-relay/telemetry.json`:
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

To check if telemetry is currently enabled:

```sh
agent-relay telemetry status
```
