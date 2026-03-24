import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const sdkRoot = 'packages/sdk/src';
  const brokerRoot = 'src';

  const wf = workflow('sdk-channel-management')
    .description(
      'Add subscribe, unsubscribe, mute, and unmute operations to @agent-relay/sdk and the Rust broker'
    )
    .pattern('dag')
    .channel('wf-sdk-channel-mgmt')
    .maxConcurrency(5)
    .timeout(3_600_000);

  // ── Agents ──────────────────────────────────────────────────────────────

  wf.agent('architect', {
    cli: 'claude',
    role: 'SDK architect — designs protocol changes and coordinates implementation across TS and Rust',
    preset: 'lead',
    retries: 2,
  });

  wf.agent('ts-worker', {
    cli: 'codex',
    role: 'TypeScript SDK developer — implements protocol types, client methods, and facade API',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('rust-worker', {
    cli: 'claude',
    role: 'Rust developer — implements broker-side channel management in the relay-pty binary',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('integration-worker', {
    cli: 'claude',
    role: 'Integration developer — refactors ChatSession to use new SDK channel APIs',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('test-writer', {
    cli: 'codex',
    role: 'Test engineer — writes unit and integration tests',
    preset: 'worker',
    retries: 2,
  });

  // ── Phase 1: Read current source ──────────────────────────────────────

  wf.step('read-protocol-ts', {
    type: 'deterministic',
    command: `cat ${sdkRoot}/protocol.ts`,
  });

  wf.step('read-client-ts', {
    type: 'deterministic',
    command: `cat ${sdkRoot}/client.ts`,
  });

  wf.step('read-relay-ts', {
    type: 'deterministic',
    command: `cat ${sdkRoot}/relay.ts`,
  });

  wf.step('read-broker-protocol-rs', {
    type: 'deterministic',
    command: `cat ${brokerRoot}/protocol.rs`,
  });

  wf.step('read-broker-routing-rs', {
    type: 'deterministic',
    command: `cat ${brokerRoot}/routing.rs`,
  });

  wf.step('read-broker-main-rs', {
    type: 'deterministic',
    command: `sed -n '1,200p' ${brokerRoot}/main.rs`,
  });

  wf.step('read-chat-session', {
    type: 'deterministic',
    command: 'cat "/Users/khaliqgant/Projects/My Senior Dev/app/packages/desktop/chat-session.ts"',
  });

  wf.step('read-relaycast-ws-rs', {
    type: 'deterministic',
    command: `cat ${brokerRoot}/relaycast_ws.rs`,
  });

  wf.step('read-supervisor-rs', {
    type: 'deterministic',
    command: `grep -n 'channels\\|subscribe\\|mute\\|struct.*Worker\\|fn.*channel' ${brokerRoot}/supervisor.rs | head -80`,
  });

  // ── Phase 2: Design ───────────────────────────────────────────────────

  wf.step('plan', {
    agent: 'architect',
    task: `
You are designing SDK-level channel management for @agent-relay/sdk.

The goal: add subscribe, unsubscribe, mute, and unmute operations that work
post-spawn, so agents can dynamically join/leave channels and suppress PTY
injection without client-side filtering.

Semantics (from the architecture doc):
| Operation     | Channel membership | PTY injection | History access |
|---------------|-------------------|---------------|----------------|
| subscribe     | Yes               | Yes           | Yes            |
| unsubscribe   | No                | No            | No (leaves)    |
| mute          | Yes (stays)       | No (silenced) | Yes (can query)|
| unmute        | Yes               | Yes (resumes) | Yes            |

Current TypeScript protocol (SdkToBroker):
{{steps.read-protocol-ts.output}}

Current Rust broker protocol (SdkToBroker enum):
{{steps.read-broker-protocol-rs.output}}

Current SDK client:
{{steps.read-client-ts.output}}

Current SDK relay facade:
{{steps.read-relay-ts.output}}

Current broker routing:
{{steps.read-broker-routing-rs.output}}

Current broker supervisor (channel-related):
{{steps.read-supervisor-rs.output}}

Produce an implementation plan covering:

1. New SdkToBroker message types needed (subscribe_channels, unsubscribe_channels,
   mute_channel, unmute_channel) — exact payload shapes for both TS and Rust
2. New BrokerEvent types (channel_subscribed, channel_unsubscribed, channel_muted,
   channel_unmuted) — for confirming operations back to the SDK
3. Rust broker changes:
   - Where to store mute state (per-agent-per-channel in the worker/supervisor)
   - How routing.rs should check mute state before PTY injection
   - How relaycast_ws.rs should update Relaycast cloud subscriptions
4. TypeScript SDK changes:
   - New methods on AgentRelayClient (subscribe, unsubscribe, mute, unmute)
   - New methods on the Agent class in relay.ts
   - Event propagation for the new BrokerEvents
5. ChatSession refactor:
   - How handleChannelMessage() simplifies once the broker handles fanout
   - What client-side filtering can be removed
6. Exact file list with specific changes per file

Output the plan as a numbered checklist. Do NOT write any code — just the plan.
    `.trim(),
    dependsOn: [
      'read-protocol-ts',
      'read-client-ts',
      'read-relay-ts',
      'read-broker-protocol-rs',
      'read-broker-routing-rs',
      'read-broker-main-rs',
      'read-chat-session',
      'read-relaycast-ws-rs',
      'read-supervisor-rs',
    ],
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
  });

  // ── Phase 3: Parallel implementation ──────────────────────────────────

  // 3a. TypeScript protocol types + SDK client methods
  wf.step('impl-ts-protocol', {
    agent: 'ts-worker',
    task: `
Add channel management protocol types and client methods to @agent-relay/sdk.

Implementation plan:
{{steps.plan.output}}

Current protocol types:
{{steps.read-protocol-ts.output}}

Current client:
{{steps.read-client-ts.output}}

Changes to packages/sdk/src/protocol.ts:

1. Add four new variants to the SdkToBroker union type:
   - subscribe_channels: { name: string; channels: string[] }
   - unsubscribe_channels: { name: string; channels: string[] }
   - mute_channel: { name: string; channel: string }
   - unmute_channel: { name: string; channel: string }

2. Add four new variants to BrokerEvent:
   - channel_subscribed: { name: string; channels: string[] }
   - channel_unsubscribed: { name: string; channels: string[] }
   - channel_muted: { name: string; channel: string }
   - channel_unmuted: { name: string; channel: string }

Changes to packages/sdk/src/client.ts:

1. Add method: subscribeChannels(name: string, channels: string[]): Promise<void>
   - Sends { type: 'subscribe_channels', payload: { name, channels } }
2. Add method: unsubscribeChannels(name: string, channels: string[]): Promise<void>
   - Sends { type: 'unsubscribe_channels', payload: { name, channels } }
3. Add method: muteChannel(name: string, channel: string): Promise<void>
   - Sends { type: 'mute_channel', payload: { name, channel } }
4. Add method: unmuteChannel(name: string, channel: string): Promise<void>
   - Sends { type: 'unmute_channel', payload: { name, channel } }

Follow the existing patterns in client.ts for sending requests and awaiting responses.
Keep changes minimal — do not refactor existing code.
    `.trim(),
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  });

  // 3b. TypeScript relay facade (Agent class methods)
  wf.step('impl-ts-facade', {
    agent: 'ts-worker',
    task: `
Add channel management methods to the AgentRelay facade and Agent class.

Implementation plan:
{{steps.plan.output}}

Current relay facade:
{{steps.read-relay-ts.output}}

Protocol changes (already applied):
{{steps.impl-ts-protocol.output}}

Changes to packages/sdk/src/relay.ts:

1. Add to the Agent class:
   - subscribe(channels: string[]): Promise<void>
     Calls this.client.subscribeChannels(this.name, channels)
     Updates this._channels array to include new channels
   - unsubscribe(channels: string[]): Promise<void>
     Calls this.client.unsubscribeChannels(this.name, channels)
     Removes channels from this._channels
   - mute(channel: string): Promise<void>
     Calls this.client.muteChannel(this.name, channel)
   - unmute(channel: string): Promise<void>
     Calls this.client.unmuteChannel(this.name, channel)
   - get mutedChannels(): string[]
     Returns the list of muted channels (maintain a private _mutedChannels: Set<string>)

2. Add to AgentRelay class (convenience methods that take agent name):
   - subscribe(opts: { agent: string; channels: string[] }): Promise<void>
   - unsubscribe(opts: { agent: string; channels: string[] }): Promise<void>
   - mute(opts: { agent: string; channel: string }): Promise<void>
   - unmute(opts: { agent: string; channel: string }): Promise<void>

3. Wire new BrokerEvents in the event handler:
   - channel_subscribed → update Agent._channels, call onChannelSubscribed callback
   - channel_unsubscribed → update Agent._channels, call onChannelUnsubscribed callback
   - channel_muted → update Agent._mutedChannels, call onChannelMuted callback
   - channel_unmuted → update Agent._mutedChannels, call onChannelUnmuted callback

4. Add public callback hooks to AgentRelay:
   - onChannelSubscribed?: (agent: string, channels: string[]) => void
   - onChannelUnsubscribed?: (agent: string, channels: string[]) => void
   - onChannelMuted?: (agent: string, channel: string) => void
   - onChannelUnmuted?: (agent: string, channel: string) => void

Make _channels writable internally (change from readonly to private with getter).
Keep changes minimal.
    `.trim(),
    dependsOn: ['impl-ts-protocol'],
    verification: { type: 'exit_code' },
  });

  // 3c. Rust broker protocol + routing changes
  wf.step('impl-rust-broker', {
    agent: 'rust-worker',
    task: `
Add channel management to the Rust broker (agent-relay-broker binary).

Implementation plan:
{{steps.plan.output}}

Current Rust protocol:
{{steps.read-broker-protocol-rs.output}}

Current routing:
{{steps.read-broker-routing-rs.output}}

Current Relaycast WS:
{{steps.read-relaycast-ws-rs.output}}

Changes needed:

1. src/protocol.rs — Add new SdkToBroker variants:
   SubscribeChannels { name: String, channels: Vec<String> }
   UnsubscribeChannels { name: String, channels: Vec<String> }
   MuteChannel { name: String, channel: String }
   UnmuteChannel { name: String, channel: String }

   Add new BrokerEvent variants:
   ChannelSubscribed { name: String, channels: Vec<String> }
   ChannelUnsubscribed { name: String, channels: Vec<String> }
   ChannelMuted { name: String, channel: String }
   ChannelUnmuted { name: String, channel: String }

2. src/main.rs — Handle the new SdkToBroker messages in the main dispatch loop:
   - SubscribeChannels: find worker by name, append channels to worker.channels,
     send WsControl::Subscribe for the new channels, emit ChannelSubscribed event
   - UnsubscribeChannels: find worker, remove channels from worker.channels,
     emit ChannelUnsubscribed event
   - MuteChannel: find worker, add channel to a new muted_channels: HashSet<String>
     field on the worker struct, emit ChannelMuted event
   - UnmuteChannel: find worker, remove from muted_channels, emit ChannelUnmuted event

3. src/routing.rs — Update resolve_delivery_targets (or equivalent):
   - After matching a worker by channel membership, also check that the channel
     is NOT in the worker's muted_channels set
   - A muted channel means the worker stays subscribed (for history) but the message
     is NOT injected into the PTY

4. Worker struct changes (wherever workers are stored — supervisor.rs or main.rs):
   - Add field: muted_channels: HashSet<String>
   - Initialize as empty on spawn

Use anyhow::Result for error handling. Follow existing naming patterns.
Do NOT add per-agent timeouts. Keep changes surgical.
    `.trim(),
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 4: Verify files exist ───────────────────────────────────────

  wf.step('verify-ts-files', {
    type: 'deterministic',
    dependsOn: ['impl-ts-facade'],
    command: `
missing=0
for f in ${sdkRoot}/protocol.ts ${sdkRoot}/client.ts ${sdkRoot}/relay.ts; do
  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi
done
# Check that new methods exist in the files
grep -q 'subscribe_channels\\|subscribeChannels' ${sdkRoot}/protocol.ts || { echo "MISSING: subscribe_channels in protocol.ts"; missing=$((missing+1)); }
grep -q 'mute_channel\\|muteChannel' ${sdkRoot}/protocol.ts || { echo "MISSING: mute_channel in protocol.ts"; missing=$((missing+1)); }
grep -q 'subscribeChannels' ${sdkRoot}/client.ts || { echo "MISSING: subscribeChannels in client.ts"; missing=$((missing+1)); }
grep -q 'muteChannel' ${sdkRoot}/client.ts || { echo "MISSING: muteChannel in client.ts"; missing=$((missing+1)); }
grep -q 'mute\\|unmute' ${sdkRoot}/relay.ts || { echo "MISSING: mute/unmute in relay.ts"; missing=$((missing+1)); }
if [ $missing -gt 0 ]; then echo "$missing checks failed"; exit 1; fi
echo "All TypeScript files verified"
    `.trim(),
    failOnError: true,
    captureOutput: true,
  });

  wf.step('verify-rust-files', {
    type: 'deterministic',
    dependsOn: ['impl-rust-broker'],
    command: `
missing=0
grep -q 'SubscribeChannels\\|subscribe_channels' ${brokerRoot}/protocol.rs || { echo "MISSING: SubscribeChannels in protocol.rs"; missing=$((missing+1)); }
grep -q 'MuteChannel\\|mute_channel' ${brokerRoot}/protocol.rs || { echo "MISSING: MuteChannel in protocol.rs"; missing=$((missing+1)); }
grep -q 'muted_channels\\|muted' ${brokerRoot}/routing.rs || { echo "MISSING: mute check in routing.rs"; missing=$((missing+1)); }
if [ $missing -gt 0 ]; then echo "$missing checks failed"; exit 1; fi
echo "All Rust files verified"
    `.trim(),
    failOnError: true,
    captureOutput: true,
  });

  // ── Phase 5: ChatSession refactor ─────────────────────────────────────

  wf.step('read-updated-relay-ts', {
    type: 'deterministic',
    dependsOn: ['verify-ts-files'],
    command: `cat ${sdkRoot}/relay.ts`,
    captureOutput: true,
  });

  wf.step('impl-chat-session-refactor', {
    agent: 'integration-worker',
    task: `
Refactor ChatSession in packages/desktop/chat-session.ts to use the new SDK
channel management APIs instead of manual filtering and peer fanout.

Updated SDK relay facade (with new subscribe/unsubscribe/mute/unmute methods):
{{steps.read-updated-relay-ts.output}}

Current ChatSession:
{{steps.read-chat-session.output}}

Implementation plan:
{{steps.plan.output}}

Changes to packages/desktop/chat-session.ts:

1. Remove manual peer fanout in handleChannelMessage():
   - Currently iterates personaNames and sends each agent the message from other agents
   - The broker now fans out channel messages to all subscribed agents, so this is no longer needed
   - Keep the dedup cache (5-second window) since dual-path delivery still exists

2. Remove client-side persona filtering:
   - handleChannelMessage() currently checks personaNames.has(from) to filter
   - With broker-managed subscriptions, only subscribed agents receive messages
   - Remove the personaNames.has(from) guard

3. Use subscribe/unsubscribe for dynamic channel joining:
   - If agents need to join additional channels mid-session, use:
     relay.subscribe({ agent: agentName, channels: ['new-channel'] })
   - Replace any manual channel tracking with the SDK's Agent.channels getter

4. Use mute for cross-channel noise reduction:
   - When a chat session has multiple PR channels open, agents focused on one PR
     can mute the other PR channels:
     relay.mute({ agent: agentName, channel: 'review-pr-456' })
   - Add an optional muteOtherChannels parameter to startSession() that auto-mutes
     non-primary channels for each agent

5. Keep the ensureCloudChannelListener path unchanged — it's the cloud backup path
   and is independent of broker-level subscriptions.

IMPORTANT: Write the file to disk. Do NOT just output the code.
Keep changes focused on removing manual fanout and filtering.
    `.trim(),
    dependsOn: ['read-updated-relay-ts', 'verify-rust-files'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 6: Tests ────────────────────────────────────────────────────

  wf.step('read-impl-outputs', {
    type: 'deterministic',
    dependsOn: ['impl-chat-session-refactor'],
    command: `
echo "=== protocol.ts (new types) ==="
grep -A5 'subscribe_channels\\|unsubscribe_channels\\|mute_channel\\|unmute_channel\\|channel_subscribed\\|channel_unsubscribed\\|channel_muted\\|channel_unmuted' ${sdkRoot}/protocol.ts | head -60
echo "=== client.ts (new methods) ==="
grep -A8 'subscribeChannels\\|unsubscribeChannels\\|muteChannel\\|unmuteChannel' ${sdkRoot}/client.ts | head -60
echo "=== relay.ts (new methods) ==="
grep -A8 'subscribe\\|unsubscribe\\|mute\\|unmute\\|onChannel' ${sdkRoot}/relay.ts | head -80
    `.trim(),
    captureOutput: true,
  });

  wf.step('write-tests', {
    agent: 'test-writer',
    task: `
Write tests for the new channel management features.

Implementation summary:
{{steps.read-impl-outputs.output}}

Implementation plan:
{{steps.plan.output}}

Create the following test files:

1. packages/sdk/src/__tests__/channel-management.test.ts
   Unit tests for the protocol types and client methods:
   - Test subscribeChannels sends correct SdkToBroker message shape
   - Test unsubscribeChannels sends correct message shape
   - Test muteChannel sends correct message shape
   - Test unmuteChannel sends correct message shape
   - Test that channel_subscribed event updates Agent.channels
   - Test that channel_muted event updates Agent.mutedChannels

2. packages/sdk/src/__tests__/relay-channel-ops.test.ts
   Integration-style tests for the AgentRelay facade:
   - Test relay.subscribe({ agent, channels }) delegates to client
   - Test relay.mute({ agent, channel }) delegates to client
   - Test Agent.subscribe() updates local channel list on success
   - Test Agent.mute() adds to mutedChannels set
   - Test Agent.unmute() removes from mutedChannels set
   - Test onChannelSubscribed callback fires on channel_subscribed event
   - Test onChannelMuted callback fires on channel_muted event

3. tests/integration/broker/channel-management.test.ts
   Integration tests against the real broker binary (if available):
   - Spawn an agent with channels: ['ch-a']
   - Subscribe to 'ch-b', verify agent.channels includes both
   - Mute 'ch-a', send a message to 'ch-a', verify it is NOT injected into PTY
   - Unmute 'ch-a', send another message, verify it IS injected
   - Unsubscribe from 'ch-b', verify agent.channels no longer includes it

Use vitest for unit tests. Follow existing test patterns in the codebase.
IMPORTANT: Write files to disk. Do NOT just output the code.
    `.trim(),
    dependsOn: ['read-impl-outputs'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 7: Verify ───────────────────────────────────────────────────

  wf.step('typecheck-ts', {
    type: 'deterministic',
    command: 'cd packages/sdk && npx tsc --noEmit',
    dependsOn: ['write-tests'],
  });

  wf.step('check-rust', {
    type: 'deterministic',
    command: 'cargo check 2>&1 | tail -20',
    dependsOn: ['impl-rust-broker'],
  });

  wf.step('run-tests', {
    type: 'deterministic',
    command: 'cd packages/sdk && npx vitest run --reporter=verbose src/__tests__/channel-management.test.ts src/__tests__/relay-channel-ops.test.ts 2>&1 | tail -40',
    dependsOn: ['typecheck-ts'],
  });

  // ── Run ─────────────────────────────────────────────────────────────────

  const result = await wf
    .onError('continue')
    .run({
      onEvent: (e) => {
        if (e.type.startsWith('step:') || e.type.startsWith('run:')) {
          console.log(`[${e.type}] ${e.stepName ?? ''}`);
        }
      },
    });

  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);
