import { workflow } from '@agent-relay/sdk/workflows';

const RC = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAY = '/Users/khaliqgant/Projects/AgentWorkforce/relay';
const MSD = '/Users/khaliqgant/Projects/My Senior Dev/app/packages/desktop';

async function main() {
  const wf = workflow('relaycast-channel-mute')
    .description(
      'Add mute/unmute to Relaycast cloud (types, server, SDK) and update relay broker + MSD integration to use it'
    )
    .pattern('dag')
    .channel('wf-rc-channel-mute')
    .maxConcurrency(5)
    .timeout(3_600_000);

  // ── Agents ──────────────────────────────────────────────────────────────

  wf.agent('architect', {
    cli: 'claude',
    role: 'Designs the mute/unmute feature across relaycast types, server, SDK, and relay integration',
    preset: 'lead',
    retries: 2,
  });

  wf.agent('rc-types-worker', {
    cli: 'codex',
    role: 'Adds mute types and event schemas to @relaycast/types',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('rc-server-worker', {
    cli: 'claude',
    role: 'Adds mute/unmute API routes, engine logic, and DB schema to Relaycast server',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('rc-sdk-worker', {
    cli: 'codex',
    role: 'Adds mute/unmute methods to @relaycast/sdk-typescript AgentClient',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('relay-worker', {
    cli: 'claude',
    role: 'Updates relay broker and MSD ChatSession to use Relaycast-level mute',
    preset: 'worker',
    retries: 2,
  });

  // ── Phase 1: Read current source ──────────────────────────────────────

  wf.step('read-rc-types-channel', {
    type: 'deterministic',
    command: `cat "${RC}/packages/types/src/channel.ts"`,
  });

  wf.step('read-rc-types-events', {
    type: 'deterministic',
    command: `cat "${RC}/packages/types/src/events.ts"`,
  });

  wf.step('read-rc-schema', {
    type: 'deterministic',
    command: `cat "${RC}/packages/server/src/db/schema.ts"`,
  });

  wf.step('read-rc-channel-engine', {
    type: 'deterministic',
    command: `cat "${RC}/packages/server/src/engine/channel.ts"`,
  });

  wf.step('read-rc-channel-routes', {
    type: 'deterministic',
    command: `cat "${RC}/packages/server/src/routes/channel.ts"`,
  });

  wf.step('read-rc-channel-do', {
    type: 'deterministic',
    command: `cat "${RC}/packages/server/src/durable-objects/channel.ts"`,
  });

  wf.step('read-rc-sdk-agent', {
    type: 'deterministic',
    command: `cat "${RC}/packages/sdk-typescript/src/agent.ts"`,
  });

  wf.step('read-rc-fanout', {
    type: 'deterministic',
    command: `cat "${RC}/packages/server/src/routes/fanout.ts"`,
  });

  wf.step('read-relay-relaycast-ws', {
    type: 'deterministic',
    command: `cat "${RELAY}/src/relaycast_ws.rs"`,
  });

  wf.step('read-msd-chat-session', {
    type: 'deterministic',
    command: `cat "${MSD}/chat-session.ts"`,
  });

  wf.step('read-msd-local-server', {
    type: 'deterministic',
    command: `sed -n '1,150p' "${MSD}/local-server.ts"`,
  });

  // ── Phase 2: Design ───────────────────────────────────────────────────

  wf.step('plan', {
    agent: 'architect',
    task: `
You are designing mute/unmute for Relaycast channels at the cloud level.

Goal: An agent can mute a channel — staying a member (history access) but
the Relaycast server skips delivering new messages to that agent's DO.
Unmute resumes delivery. This replaces broker-level mute and eliminates
client-side filtering in MSD ChatSession and relay broker routing.

Current Relaycast types (channel):
{{steps.read-rc-types-channel.output}}

Current Relaycast event schemas:
{{steps.read-rc-types-events.output}}

DB schema (Drizzle ORM, SQLite):
{{steps.read-rc-schema.output}}

Channel engine (business logic):
{{steps.read-rc-channel-engine.output}}

Channel routes (Hono API):
{{steps.read-rc-channel-routes.output}}

ChannelDO (fanout actor):
{{steps.read-rc-channel-do.output}}

Fanout helpers:
{{steps.read-rc-fanout.output}}

SDK AgentClient:
{{steps.read-rc-sdk-agent.output}}

Relay broker Relaycast WS client:
{{steps.read-relay-relaycast-ws.output}}

MSD ChatSession:
{{steps.read-msd-chat-session.output}}

MSD local-server:
{{steps.read-msd-local-server.output}}

Produce an implementation plan:

1. @relaycast/types changes:
   - New fields on ChannelMemberInfo and ChannelMember (is_muted)
   - New event schemas: member.channel_muted, member.channel_unmuted
   - Add to ServerEventSchema and WsClientEventSchema unions

2. Relaycast server changes:
   a. DB schema: add is_muted column to channel_members table
   b. Channel engine: add muteChannel() and unmuteChannel() functions
   c. Channel routes: POST /v1/channels/:name/mute and /unmute (requireAgentToken)
   d. ChannelDO fanout: skip delivery to muted members
      - ChannelDO.fanOut() needs to know which members are muted
      - Option A: store muted set in DO storage alongside members
      - Option B: pass muted list from the broadcast caller
      - Choose the approach and explain why
   e. Fanout to channel and workspace for the new events

3. @relaycast/sdk-typescript changes:
   - Add channels.mute(name) and channels.unmute(name) HTTP methods
   - Add on.channelMuted and on.channelUnmuted event listeners
   - Return mute status in channels.members() response

4. Relay broker integration (in this relay repo):
   - Remove broker-level mute state from routing.rs (if added by prior workflow)
   - The broker's relaycast_ws.rs already receives all events — it just needs to
     NOT inject messages for channels the agent has muted via Relaycast
   - Or: since Relaycast now skips delivery to muted agents, the broker doesn't
     need to filter at all — Relaycast handles it

5. MSD ChatSession integration:
   - Replace manual persona filtering with relay.mute()/unmute() calls
   - Remove handleChannelMessage() persona filtering
   - Keep dedup cache for dual-path delivery

Output the plan as a numbered checklist. Do NOT write code.
    `.trim(),
    dependsOn: [
      'read-rc-types-channel', 'read-rc-types-events', 'read-rc-schema',
      'read-rc-channel-engine', 'read-rc-channel-routes', 'read-rc-channel-do',
      'read-rc-sdk-agent', 'read-rc-fanout', 'read-relay-relaycast-ws',
      'read-msd-chat-session', 'read-msd-local-server',
    ],
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
  });

  // ── Phase 3: Parallel implementation ──────────────────────────────────

  // 3a. @relaycast/types — mute types + event schemas
  wf.step('impl-rc-types', {
    agent: 'rc-types-worker',
    task: `
Add mute/unmute types and event schemas to @relaycast/types.

Implementation plan:
{{steps.plan.output}}

Current channel types:
{{steps.read-rc-types-channel.output}}

Current event schemas:
{{steps.read-rc-types-events.output}}

Changes to ${RC}/packages/types/src/channel.ts:

1. Add is_muted field to ChannelMemberInfoSchema:
   is_muted: z.boolean().optional()

2. Add is_muted field to ChannelMemberSchema:
   is_muted: z.boolean()

3. Add MuteChannelResponseSchema:
   z.object({ channel: z.string(), agent_id: z.string(), muted: z.boolean() })
   Export as type MuteChannelResponse

Changes to ${RC}/packages/types/src/events.ts:

1. Add ChannelMutedEventSchema:
   z.object({ type: z.literal('member.channel_muted'), channel: z.string(), agent_name: z.string() })
   Export as type ChannelMutedEvent

2. Add ChannelUnmutedEventSchema:
   z.object({ type: z.literal('member.channel_unmuted'), channel: z.string(), agent_name: z.string() })
   Export as type ChannelUnmutedEvent

3. Add both to ServerEventSchema discriminated union
4. Add both to WsClientEventSchema discriminated union

IMPORTANT: Write files to disk. Do NOT just output code.
    `.trim(),
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  });

  // 3b. Relaycast server — schema + engine + routes + ChannelDO
  wf.step('impl-rc-server', {
    agent: 'rc-server-worker',
    task: `
Add mute/unmute to the Relaycast server: DB schema, engine, routes, and ChannelDO fanout filtering.

Implementation plan:
{{steps.plan.output}}

Current DB schema:
{{steps.read-rc-schema.output}}

Current channel engine:
{{steps.read-rc-channel-engine.output}}

Current channel routes:
{{steps.read-rc-channel-routes.output}}

Current ChannelDO:
{{steps.read-rc-channel-do.output}}

Current fanout helpers:
{{steps.read-rc-fanout.output}}

Changes needed:

1. DB schema (${RC}/packages/server/src/db/schema.ts):
   Add to channelMembers table:
   isMuted: integer('is_muted', { mode: 'boolean' }).notNull().default(false)

2. Channel engine (${RC}/packages/server/src/engine/channel.ts):
   Add muteChannel(db, workspaceId, channelName, agentId):
   - Look up channel by workspace + name
   - Update channelMembers set is_muted = true where channelId + agentId
   - Return { channel: channelName, agent_id: agentId, muted: true }
   - Throw 404 if not a member

   Add unmuteChannel(db, workspaceId, channelName, agentId):
   - Same but set is_muted = false
   - Return { channel: channelName, agent_id: agentId, muted: false }

   Update getChannelMembers (or listMembers) to include is_muted in returned data.

3. Channel routes (${RC}/packages/server/src/routes/channel.ts):
   Add POST /v1/channels/:name/mute (requireAuth, requireAgentToken):
   - Call channelEngine.muteChannel(db, workspace.id, name, agent.id)
   - Fanout member.channel_muted event to channel
   - Update ChannelDO muted members via a new /update-muted endpoint

   Add POST /v1/channels/:name/unmute (requireAuth, requireAgentToken):
   - Call channelEngine.unmuteChannel(db, workspace.id, name, agent.id)
   - Fanout member.channel_unmuted event
   - Update ChannelDO muted members

4. ChannelDO (${RC}/packages/server/src/durable-objects/channel.ts):
   - Add mutedMembers: string[] | null field (cached set of muted agent IDs)
   - Add getMutedMembers() helper (reads from DO storage, key: 'muted_members')
   - Add POST /update-muted endpoint: receives { muted: string[] }, stores in DO
   - Modify fanOut() to skip agents in mutedMembers set:
     const muted = new Set(await this.getMutedMembers());
     const deliverTo = members.filter(id => !muted.has(id));
   - Also load muted members from D1 on cold start (same pattern as loadMembersFromDb)

IMPORTANT: Write all files to disk. Keep changes surgical — follow existing patterns.
    `.trim(),
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  });

  // 3c. @relaycast/sdk-typescript — AgentClient mute/unmute methods
  wf.step('impl-rc-sdk', {
    agent: 'rc-sdk-worker',
    task: `
Add mute/unmute channel methods to the @relaycast/sdk-typescript AgentClient.

Implementation plan:
{{steps.plan.output}}

Current SDK AgentClient:
{{steps.read-rc-sdk-agent.output}}

Types changes (already applied):
{{steps.impl-rc-types.output}}

Changes to ${RC}/packages/sdk-typescript/src/agent.ts:

1. Add to the channels object:
   mute: async (name: string): Promise<void> => {
     await this.request('POST', \`/v1/channels/\${encodeURIComponent(name)}/mute\`);
   }

   unmute: async (name: string): Promise<void> => {
     await this.request('POST', \`/v1/channels/\${encodeURIComponent(name)}/unmute\`);
   }

2. Add event listeners to the 'on' proxy:
   channelMuted: for 'member.channel_muted' events
   channelUnmuted: for 'member.channel_unmuted' events

   Follow the exact pattern used by memberJoined/memberLeft handlers.

3. Update the ChannelMemberInfo type import if needed (it should now include is_muted).

IMPORTANT: Write the file to disk. Keep changes minimal.
    `.trim(),
    dependsOn: ['impl-rc-types'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 4: Verify relaycast changes ─────────────────────────────────

  wf.step('verify-rc-types', {
    type: 'deterministic',
    dependsOn: ['impl-rc-types'],
    command: `
grep -q 'is_muted' "${RC}/packages/types/src/channel.ts" || { echo "MISSING: is_muted in channel.ts"; exit 1; }
grep -q 'member.channel_muted' "${RC}/packages/types/src/events.ts" || { echo "MISSING: member.channel_muted event"; exit 1; }
grep -q 'member.channel_unmuted' "${RC}/packages/types/src/events.ts" || { echo "MISSING: member.channel_unmuted event"; exit 1; }
echo "Types verified"
    `.trim(),
    failOnError: true,
    captureOutput: true,
  });

  wf.step('verify-rc-server', {
    type: 'deterministic',
    dependsOn: ['impl-rc-server'],
    command: `
grep -q 'is_muted\\|isMuted' "${RC}/packages/server/src/db/schema.ts" || { echo "MISSING: is_muted in schema"; exit 1; }
grep -q 'muteChannel' "${RC}/packages/server/src/engine/channel.ts" || { echo "MISSING: muteChannel in engine"; exit 1; }
grep -q '/mute' "${RC}/packages/server/src/routes/channel.ts" || { echo "MISSING: /mute route"; exit 1; }
grep -q 'mutedMembers\\|muted_members\\|update-muted' "${RC}/packages/server/src/durable-objects/channel.ts" || { echo "MISSING: muted filtering in ChannelDO"; exit 1; }
echo "Server verified"
    `.trim(),
    failOnError: true,
    captureOutput: true,
  });

  wf.step('verify-rc-sdk', {
    type: 'deterministic',
    dependsOn: ['impl-rc-sdk'],
    command: `
grep -q 'mute' "${RC}/packages/sdk-typescript/src/agent.ts" || { echo "MISSING: mute in SDK"; exit 1; }
grep -q 'unmute' "${RC}/packages/sdk-typescript/src/agent.ts" || { echo "MISSING: unmute in SDK"; exit 1; }
echo "SDK verified"
    `.trim(),
    failOnError: true,
    captureOutput: true,
  });

  // ── Phase 5: Relay + MSD integration ──────────────────────────────────

  wf.step('read-relay-routing', {
    type: 'deterministic',
    dependsOn: ['verify-rc-server'],
    command: `cat "${RELAY}/src/routing.rs"`,
    captureOutput: true,
  });

  wf.step('read-relay-protocol', {
    type: 'deterministic',
    dependsOn: ['verify-rc-server'],
    command: `cat "${RELAY}/src/protocol.rs"`,
    captureOutput: true,
  });

  wf.step('impl-relay-integration', {
    agent: 'relay-worker',
    task: `
Update the relay broker to leverage Relaycast-level mute instead of broker-level mute.

Implementation plan:
{{steps.plan.output}}

Current relay routing.rs:
{{steps.read-relay-routing.output}}

Current relay protocol.rs:
{{steps.read-relay-protocol.output}}

Current MSD chat-session.ts:
{{steps.read-msd-chat-session.output}}

Current MSD local-server.ts:
{{steps.read-msd-local-server.output}}

Since Relaycast cloud now skips delivery to muted agents in ChannelDO.fanOut(),
the relay broker no longer needs its own mute logic. Changes:

1. ${RELAY}/src/protocol.rs:
   - If MuteChannel/UnmuteChannel variants were added by a prior workflow, REMOVE them
   - The broker no longer handles mute — Relaycast cloud does

2. ${RELAY}/src/routing.rs:
   - If muted_channels filtering was added by a prior workflow, REMOVE it
   - Routing should only check channel membership, not mute state

3. ${RELAY}/packages/sdk/src/protocol.ts:
   - If mute_channel/unmute_channel were added to SdkToBroker, REMOVE them
   - Keep channel_subscribed/channel_unsubscribed broker events if present

4. ${RELAY}/packages/sdk/src/relay.ts:
   - If Agent.mute()/unmute() methods call the broker, CHANGE them to call
     the Relaycast SDK instead:
     - Agent.mute(channel) should call the @relaycast/sdk channels.mute(channel) API
     - Agent.unmute(channel) should call @relaycast/sdk channels.unmute(channel) API
   - This means the Agent class needs access to a RelayCast client
   - If this is too invasive, just remove the broker-level mute methods and
     document that mute should be called via @relaycast/sdk directly

5. ${MSD}/chat-session.ts:
   - In handleChannelMessage(): remove the personaNames.has(from) filter
   - With Relaycast-level mute, muted agents simply don't receive messages,
     so no client-side filtering is needed
   - Remove manual peer fanout loop — Relaycast ChannelDO fans out to all
     non-muted members
   - Keep the dedup cache for the dual-path (cloud + broker fallback) scenario

IMPORTANT: Write all changed files to disk. Be surgical — only remove/modify
code related to mute. Don't refactor unrelated code.
    `.trim(),
    dependsOn: ['read-relay-routing', 'read-relay-protocol', 'verify-rc-types', 'verify-rc-sdk'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 6: Typecheck ────────────────────────────────────────────────

  wf.step('typecheck-rc-types', {
    type: 'deterministic',
    dependsOn: ['verify-rc-types'],
    command: `cd "${RC}/packages/types" && npx tsc --noEmit 2>&1 | tail -20`,
  });

  wf.step('typecheck-rc-server', {
    type: 'deterministic',
    dependsOn: ['verify-rc-server', 'typecheck-rc-types'],
    command: `cd "${RC}/packages/server" && npx tsc --noEmit 2>&1 | tail -20`,
  });

  wf.step('typecheck-rc-sdk', {
    type: 'deterministic',
    dependsOn: ['verify-rc-sdk', 'typecheck-rc-types'],
    command: `cd "${RC}/packages/sdk-typescript" && npx tsc --noEmit 2>&1 | tail -20`,
  });

  wf.step('typecheck-relay', {
    type: 'deterministic',
    dependsOn: ['impl-relay-integration'],
    command: `cd "${RELAY}/packages/sdk" && npx tsc --noEmit 2>&1 | tail -20`,
  });

  wf.step('check-rust', {
    type: 'deterministic',
    dependsOn: ['impl-relay-integration'],
    command: `cd "${RELAY}" && cargo check 2>&1 | tail -20`,
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
