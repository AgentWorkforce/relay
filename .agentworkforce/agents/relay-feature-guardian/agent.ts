/**
 * relay-feature-guardian handler.
 *
 * Hourly cron tick:
 *   1. Load feature progress from memory
 *   2. Pick the next unchecked feature (ordered by criticality)
 *   3. Generate a concise quiz question via ctx.llm
 *   4. Post to Slack with @mentions for Will and Khaliq
 *   5. Persist updated progress
 *
 * Features are sourced from the Relay feature manifest. After the full list
 * is covered, the cycle resets so the process repeats weekly.
 */
import { defineAgent, type WorkforceCtx } from '@agentworkforce/runtime';
import { input } from '@agentworkforce/delivery';
import { slackClient } from '@relayfile/relay-helpers';

// ── feature catalog ──────────────────────────────────────────────────────────
// Extracted from .agentworkforce/features/manifest.yaml, ordered by criticality
// then verify_tier so critical/low-tier features get checked first each cycle.
interface Feature {
  id: string;
  name: string;
  cli: string;
  desc: string;
  tier: number;
  criticality: 'critical' | 'hot' | 'standard';
  mcp?: string;
}

const RELAY_FEATURES: Feature[] = [
  // ── critical: broker ───────────────────────────────────────────────────────
  { id: 'broker-up', name: 'Start Broker', cli: 'relay node up --background', desc: 'Start the local broker daemon in the background', tier: 1, criticality: 'critical' },
  { id: 'broker-status', name: 'Broker Status', cli: 'relay status', desc: 'Check whether the broker is running and show agent/queue stats', tier: 1, criticality: 'critical' },
  { id: 'broker-down', name: 'Stop Broker', cli: 'relay node down', desc: 'Stop the running broker daemon', tier: 2, criticality: 'critical' },
  { id: 'broker-metrics', name: 'Broker Metrics', cli: 'relay metrics', desc: 'Show resource usage for broker and its agents', tier: 2, criticality: 'critical' },
  { id: 'broker-deadletters', name: 'Dead Letter Queue', cli: 'relay deadletters', desc: 'List terminally-failed message deliveries retained in the broker', tier: 2, criticality: 'critical' },
  { id: 'broker-redeliver', name: 'Redeliver Messages', cli: 'relay redeliver [id]', desc: 'Requeue dead-letter messages through the normal delivery path', tier: 2, criticality: 'critical' },

  // ── critical: agent management ─────────────────────────────────────────────
  { id: 'agent-register', name: 'Register Agent', cli: 'relay agent register <name>', desc: 'Register a new agent and print its auth token as JSON', tier: 2, criticality: 'critical' },
  { id: 'agent-list', name: 'List Agents', cli: 'relay agent list', desc: 'Show all agents in the workspace with status', tier: 2, criticality: 'critical' },
  { id: 'agent-remove', name: 'Remove Agent', cli: 'relay agent remove <name>', desc: 'Remove an agent from the workspace', tier: 2, criticality: 'critical' },
  { id: 'agent-add', name: 'Add Agent (interactive)', cli: 'relay agent add', desc: 'Add an agent to the workspace interactively', tier: 2, criticality: 'critical' },
  { id: 'agent-capabilities', name: 'List Capabilities', cli: 'relay capabilities', desc: 'Show available agent capabilities in the workspace', tier: 2, criticality: 'critical' },

  // ── critical: channel messaging ────────────────────────────────────────────
  { id: 'channel-create', name: 'Create Channel', cli: 'relay channel create <name>', mcp: 'create_channel', desc: 'Create a new messaging channel', tier: 3, criticality: 'critical' },
  { id: 'channel-list', name: 'List Channels', cli: 'relay channel list', mcp: 'list_channels', desc: 'Show all channels in the workspace', tier: 3, criticality: 'critical' },
  { id: 'channel-join', name: 'Join Channel', cli: 'relay channel join <name>', mcp: 'join_channel', desc: 'Join an existing channel as the current agent', tier: 3, criticality: 'critical' },
  { id: 'channel-leave', name: 'Leave Channel', cli: 'relay channel leave <name>', mcp: 'leave_channel', desc: 'Leave a channel', tier: 3, criticality: 'critical' },
  { id: 'channel-invite', name: 'Invite to Channel', cli: 'relay channel invite <channel> <agent>', mcp: 'invite_to_channel', desc: 'Invite another agent to a private channel', tier: 4, criticality: 'critical' },
  { id: 'channel-set-topic', name: 'Set Channel Topic', cli: 'relay channel set_topic <channel> <topic>', mcp: 'set_channel_topic', desc: 'Update the topic of a channel', tier: 3, criticality: 'critical' },
  { id: 'channel-archive', name: 'Archive Channel', cli: 'relay channel archive <name>', mcp: 'archive_channel', desc: 'Archive a channel (soft delete, reversible)', tier: 3, criticality: 'critical' },

  // ── critical: message posting & retrieval ──────────────────────────────────
  { id: 'message-post', name: 'Post Message', cli: 'relay message post <channel> <text>', mcp: 'post_message', desc: 'Send a message to a channel as the current agent', tier: 3, criticality: 'critical' },
  { id: 'message-list', name: 'List Messages', cli: 'relay message list <channel>', mcp: 'list_messages', desc: 'Retrieve message history from a channel', tier: 3, criticality: 'critical' },
  { id: 'message-reply', name: 'Reply to Message', cli: 'relay message reply <messageId> <text>', mcp: 'reply_to_message', desc: 'Reply to a message, creating or extending a thread', tier: 3, criticality: 'critical' },
  { id: 'message-get-thread', name: 'Get Thread', cli: 'relay message get_thread --message-id <id>', mcp: 'get_thread', desc: 'Retrieve all messages in a thread', tier: 3, criticality: 'critical' },
  { id: 'message-search', name: 'Search Messages', cli: 'relay message search --query <text>', mcp: 'search_messages', desc: 'Full-text search across channel messages', tier: 3, criticality: 'critical' },
  { id: 'message-inbox-check', name: 'Check Inbox', cli: 'relay message inbox check', mcp: 'check_inbox', desc: 'Check for unread messages directed at the current agent', tier: 3, criticality: 'critical' },
  { id: 'message-inbox-mark-read', name: 'Mark Message Read', cli: 'relay message inbox mark_read --message-id <id>', mcp: 'mark_message_read', desc: 'Mark a specific message as read', tier: 3, criticality: 'critical' },
  { id: 'message-inbox-get-readers', name: 'Get Readers', cli: 'relay message inbox get_readers --message-id <id>', mcp: 'get_readers', desc: 'List all agents that have read a message (read receipts)', tier: 4, criticality: 'critical' },

  // ── critical: direct messages ──────────────────────────────────────────────
  { id: 'dm-send', name: 'Send DM', cli: 'relay message dm send <agent> <text>', mcp: 'send_dm', desc: 'Send a direct message to another agent; response includes conversationId', tier: 4, criticality: 'critical' },
  { id: 'dm-list', name: 'List DM Conversation', cli: 'relay message dm list <conversationId>', mcp: 'list_dm_conversation', desc: 'List messages in a DM conversation (requires conversationId from dm send)', tier: 4, criticality: 'critical' },
  { id: 'dm-send-group', name: 'Send Group DM', cli: 'relay message dm send_group <text> --to <agent>', mcp: 'send_group_dm', desc: 'Start or send to a group DM conversation', tier: 4, criticality: 'critical' },

  // ── critical: MCP server ───────────────────────────────────────────────────
  { id: 'mcp-server-start', name: 'MCP Server', cli: 'relay mcp', desc: 'Start the MCP server on stdio; exposes all messaging tools to Claude Code, Cursor, etc.', tier: 2, criticality: 'critical' },

  // ── critical: local agents ─────────────────────────────────────────────────
  { id: 'local-agent-spawn', name: 'Spawn Agent', cli: 'relay node agent spawn <provider> --name <agent-name>', desc: 'Launch an AI agent process attached to the local broker', tier: 2, criticality: 'critical' },
  { id: 'local-agent-new', name: 'Spawn and Attach', cli: 'relay node agent new <provider> --name <agent-name>', desc: 'Spawn an agent and immediately attach your terminal to it', tier: 2, criticality: 'critical' },
  { id: 'local-agent-release', name: 'Release Agent', cli: 'relay node agent release <name>', desc: 'Gracefully stop a running local agent', tier: 2, criticality: 'critical' },
  { id: 'local-agent-list', name: 'List Local Agents', cli: 'relay node agent list', desc: 'Show all agents currently running on the local broker', tier: 2, criticality: 'critical' },
  { id: 'local-agent-hold', name: 'Hold Agent Messages', cli: 'relay node agent message hold <name>', desc: 'Pause message delivery to an agent (queue them)', tier: 2, criticality: 'critical' },
  { id: 'local-agent-flush', name: 'Flush Agent Messages', cli: 'relay node agent message flush <name>', desc: 'Immediately deliver all queued messages to a held agent', tier: 2, criticality: 'critical' },
  { id: 'local-agent-auto', name: 'Resume Agent Messages', cli: 'relay node agent message auto <name>', desc: 'Resume automatic message injection for an agent', tier: 2, criticality: 'critical' },
  { id: 'local-agent-attach', name: 'Attach to Agent', cli: 'relay node agent attach <name>', desc: 'Interactively connect terminal to a running agent (drive/view/passthrough)', tier: 2, criticality: 'critical' },
  { id: 'local-agent-set-model', name: 'Switch Agent Model', cli: 'relay node agent set-model <name> <model>', desc: 'Change the AI model a running agent uses', tier: 2, criticality: 'critical' },
  { id: 'local-agent-tail', name: 'Tail Broker Events', cli: 'relay node tail [--agent <name>]', desc: 'Stream live broker events, optionally filtered to one agent', tier: 2, criticality: 'critical' },

  // ── critical: local workflows ──────────────────────────────────────────────
  { id: 'local-workflow-run', name: 'Run Local Workflow', cli: 'relay node workflow run <file>', desc: 'Execute a local TypeScript workflow file against the local broker', tier: 2, criticality: 'critical' },
  { id: 'local-workflow-list', name: 'List Workflow Runs', cli: 'relay node workflow list', desc: 'List recent workflow runs on the local broker', tier: 2, criticality: 'critical' },
  { id: 'local-workflow-status', name: 'Workflow Run Status', cli: 'relay node workflow status <runId>', desc: 'Show status and logs of a specific workflow run', tier: 2, criticality: 'critical' },
  { id: 'local-workflow-stop', name: 'Stop Workflow Run', cli: 'relay node workflow stop <runId>', desc: 'Terminate a running workflow', tier: 2, criticality: 'critical' },

  // ── hot: reactions ─────────────────────────────────────────────────────────
  { id: 'reaction-add', name: 'Add Reaction', cli: 'relay message reaction add --message-id <id> --emoji <emoji>', mcp: 'add_reaction', desc: 'Add an emoji reaction to a message', tier: 3, criticality: 'hot' },
  { id: 'reaction-remove', name: 'Remove Reaction', cli: 'relay message reaction remove --message-id <id> --emoji <emoji>', mcp: 'remove_reaction', desc: 'Remove an emoji reaction from a message', tier: 3, criticality: 'hot' },

  // ── hot: webhooks & subscriptions ─────────────────────────────────────────
  { id: 'webhook-list', name: 'List Webhooks', cli: 'relay integration webhook list', desc: 'List registered webhooks in the workspace', tier: 3, criticality: 'hot' },
  { id: 'webhook-create', name: 'Create Webhook', cli: 'relay integration webhook create <url> --event <event>', desc: 'Register a webhook URL to receive event payloads', tier: 3, criticality: 'hot' },
  { id: 'webhook-delete', name: 'Delete Webhook', cli: 'relay integration webhook delete <id>', desc: 'Remove a registered webhook', tier: 3, criticality: 'hot' },
  { id: 'subscription-list', name: 'List Subscriptions', cli: 'relay integration subscription list', desc: 'List active event subscriptions in the workspace', tier: 3, criticality: 'hot' },

  // ── hot: node aliases ─────────────────────────────────────────────────────
  { id: 'node-up', name: 'Node Up', cli: 'relay node up', desc: 'Start this node\'s local broker (use --background to run as daemon)', tier: 1, criticality: 'hot' },
  { id: 'node-down', name: 'Node Down', cli: 'relay node down', desc: 'Stop the local broker for this node', tier: 2, criticality: 'hot' },
  { id: 'node-status', name: 'Node Status', cli: 'relay node status', desc: 'Show broker status for this node', tier: 1, criticality: 'hot' },
  { id: 'node-metrics', name: 'Node Metrics', cli: 'relay node metrics', desc: 'Show broker metrics for this node', tier: 2, criticality: 'hot' },
  { id: 'node-deadletters', name: 'Node Dead Letters', cli: 'relay node deadletters', desc: 'Show dead letters on this node\'s broker', tier: 2, criticality: 'hot' },

  // ── hot: setup & health ────────────────────────────────────────────────────
  { id: 'cli-version', name: 'Show Version', cli: 'relay version', desc: 'Show current relay CLI version', tier: 1, criticality: 'hot' },
  { id: 'telemetry-status', name: 'Telemetry Status', cli: 'relay telemetry status', desc: 'Show whether anonymous telemetry is enabled or disabled', tier: 1, criticality: 'hot' },
  { id: 'telemetry-enable', name: 'Enable Telemetry', cli: 'relay telemetry enable', desc: 'Enable anonymous usage telemetry', tier: 1, criticality: 'hot' },
  { id: 'telemetry-disable', name: 'Disable Telemetry', cli: 'relay telemetry disable', desc: 'Disable anonymous usage telemetry', tier: 1, criticality: 'hot' },

  // ── hot: reflex (automations) ──────────────────────────────────────────────
  { id: 'reflex-on', name: 'Enable Reflex', cli: 'relay reflex on <trigger>', desc: 'Activate a reflex automation trigger', tier: 2, criticality: 'hot' },
  { id: 'reflex-off', name: 'Disable Reflex', cli: 'relay reflex off <trigger>', desc: 'Deactivate a reflex automation trigger', tier: 2, criticality: 'hot' },
  { id: 'reflex-status', name: 'Reflex Status', cli: 'relay reflex status', desc: 'Show which reflex triggers are active', tier: 2, criticality: 'hot' },

  // ── standard: fleet ───────────────────────────────────────────────────────
  { id: 'fleet-status', name: 'Fleet Status', cli: 'relay fleet status', desc: 'Show status across all fleet nodes', tier: 2, criticality: 'standard' },
  { id: 'fleet-spawn-task', name: 'Fleet Spawn Task', cli: 'relay fleet spawn-task <task>', desc: 'Spawn a task across fleet nodes', tier: 2, criticality: 'standard' },
  { id: 'fleet-list', name: 'Fleet List', cli: 'relay fleet list', desc: 'List all registered fleet nodes', tier: 2, criticality: 'standard' },

  // ── standard: workspace ───────────────────────────────────────────────────
  { id: 'workspace-list', name: 'List Workspaces', cli: 'relay workspace list', desc: 'List all stored workspaces', tier: 1, criticality: 'standard' },
  { id: 'workspace-active', name: 'Active Workspace', cli: 'relay workspace active', desc: 'Show the currently active workspace (requires cloud auth)', tier: 5, criticality: 'standard' },
  { id: 'workspace-create', name: 'Create Workspace', cli: 'relay workspace create <name>', desc: 'Create a new workspace (requires cloud auth)', tier: 5, criticality: 'standard' },

  // ── standard: cloud ───────────────────────────────────────────────────────
  { id: 'cloud-login', name: 'Cloud Login', cli: 'relay cloud login', desc: 'Authenticate with the Agent Relay cloud service', tier: 5, criticality: 'standard' },
  { id: 'cloud-logout', name: 'Cloud Logout', cli: 'relay cloud logout', desc: 'Sign out of the cloud service', tier: 5, criticality: 'standard' },
  { id: 'cloud-whoami', name: 'Cloud Who Am I', cli: 'relay cloud whoami', desc: 'Show the currently authenticated cloud user and workspace', tier: 5, criticality: 'standard' },
  { id: 'cloud-deploy', name: 'Cloud Deploy', cli: 'relay cloud run <file>', desc: 'Deploy and run a workflow in the cloud', tier: 5, criticality: 'standard' },
  { id: 'cloud-schedule', name: 'Cloud Schedule', cli: 'relay cloud schedule <file>', desc: 'Schedule a workflow to run in the cloud on a cron', tier: 5, criticality: 'standard' },
  { id: 'cloud-session', name: 'Cloud Session', cli: 'relay cloud session', desc: 'Show current cloud session details', tier: 5, criticality: 'standard' },

  // ── standard: SDK integration ─────────────────────────────────────────────
  { id: 'sdk-agent-relay', name: 'SDK: AgentRelay Client', cli: 'import { AgentRelay } from "@agent-relay/sdk"', desc: 'Core TypeScript SDK client for connecting agents to the relay', tier: 3, criticality: 'standard' },
  { id: 'sdk-workflow-builder', name: 'SDK: Workflow Builder', cli: 'import { workflow } from "@relayflows/core"', desc: 'Builder API for defining typed multi-agent workflows', tier: 2, criticality: 'standard' },

  // ── standard: MCP tools (individual) ──────────────────────────────────────
  { id: 'mcp-list-channels', name: 'MCP: list_channels', cli: 'relay mcp', mcp: 'list_channels', desc: 'MCP tool: list all channels in the workspace', tier: 2, criticality: 'standard' },
  { id: 'mcp-post-message', name: 'MCP: post_message', cli: 'relay mcp', mcp: 'post_message', desc: 'MCP tool: post a message to a channel', tier: 2, criticality: 'standard' },
  { id: 'mcp-create-channel', name: 'MCP: create_channel', cli: 'relay mcp', mcp: 'create_channel', desc: 'MCP tool: create a new channel', tier: 2, criticality: 'standard' },
  { id: 'mcp-list-messages', name: 'MCP: list_messages', cli: 'relay mcp', mcp: 'list_messages', desc: 'MCP tool: retrieve message history from a channel', tier: 2, criticality: 'standard' },
  { id: 'mcp-send-dm', name: 'MCP: send_dm', cli: 'relay mcp', mcp: 'send_dm', desc: 'MCP tool: send a direct message to another agent', tier: 2, criticality: 'standard' },
];

// ── types ─────────────────────────────────────────────────────────────────────

interface ProgressState {
  kind: 'relay-feature-guardian:progress';
  version: 1;
  checkedIds: string[];
  cycleStartedAt: string;
  totalFeatures: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function loadProgress(ctx: WorkforceCtx): Promise<ProgressState | null> {
  const items = await ctx.memory.recall('relay-feature-guardian cycle progress', {
    tags: ['relay-feature-guardian:progress'],
    scope: 'workspace',
    limit: 5
  });
  for (const item of [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    try {
      const parsed = JSON.parse(item.content) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as ProgressState).kind === 'relay-feature-guardian:progress'
      ) {
        return parsed as ProgressState;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

async function saveProgress(ctx: WorkforceCtx, state: ProgressState): Promise<void> {
  await ctx.memory.save(JSON.stringify(state), {
    tags: ['relay-feature-guardian:progress'],
    scope: 'workspace',
    ttlSeconds: 60 * 60 * 24 * 14 // 14 days
  });
}

function pickNextFeature(checkedIds: Set<string>): Feature | null {
  // Order: critical first, then hot, then standard; within each group by tier ascending
  const ordered = [...RELAY_FEATURES].sort((a, b) => {
    const critOrder = { critical: 0, hot: 1, standard: 2 };
    const critDiff = critOrder[a.criticality] - critOrder[b.criticality];
    if (critDiff !== 0) return critDiff;
    return a.tier - b.tier;
  });
  return ordered.find((f) => !checkedIds.has(f.id)) ?? null;
}

async function generateQuizMessage(ctx: WorkforceCtx, feature: Feature, mentions: string): Promise<string> {
  const mcpNote = feature.mcp ? `\nMCP tool: \`${feature.mcp}\`` : '';
  const prompt = [
    'You are the Relay Feature Guardian, a proactive Slack bot for the Agent Relay team.',
    'Write a brief, conversational Slack message (3-5 sentences, no markdown headers) asking the team to confirm whether a specific CLI feature is working as intended.',
    'Be specific: name the feature, describe what it should do, show the CLI command, and ask if it behaves this way or if anything has drifted.',
    'End with: "React ✅ if working as expected, 🔧 if something is off, or ❓ if untested."',
    'Keep it casual and direct — this is an internal team check.',
    '',
    `Feature: ${feature.name}`,
    `CLI: ${feature.cli}${mcpNote}`,
    `What it should do: ${feature.desc}`,
    `Verify tier: ${feature.tier} (${feature.tier === 1 ? 'no broker needed' : feature.tier === 2 ? 'broker required' : feature.tier === 3 ? 'broker + agent token' : feature.tier === 4 ? 'broker + two agents' : 'cloud auth required'})`,
    `Criticality: ${feature.criticality}`
  ].join('\n');

  try {
    const output = await ctx.llm.complete(prompt, { maxTokens: 300 });
    return output.trim();
  } catch {
    // Fallback to deterministic message if LLM fails
    return [
      `🔍 *Relay Feature Check: ${feature.name}*`,
      ``,
      `\`${feature.cli}\`${mcpNote}`,
      ``,
      `This should: ${feature.desc}`,
      ``,
      `Is this working as expected right now? React ✅ if yes, 🔧 if something is off, or ❓ if untested.`
    ].join('\n');
  }
}

// ── agent definition ──────────────────────────────────────────────────────────

export default defineAgent({
  schedules: [{ name: 'hourly-check', cron: '0 * * * *', tz: 'America/New_York' }],
  handler: async (ctx, _event) => {
    const channel = input(ctx, 'SLACK_CHANNEL');
    if (!channel) {
      ctx.log('warn', 'relay-feature-guardian.no-channel', { reason: 'SLACK_CHANNEL not configured' });
      return;
    }

    // Load progress or bootstrap a fresh cycle
    const progress = await loadProgress(ctx);
    const checkedIds = new Set(progress?.checkedIds ?? []);
    const totalFeatures = RELAY_FEATURES.length;

    // Pick the next unchecked feature; reset if the cycle is complete
    let feature = pickNextFeature(checkedIds);
    if (!feature) {
      ctx.log('info', 'relay-feature-guardian.cycle-complete', { total: totalFeatures });
      checkedIds.clear(); // reset for next cycle
      feature = pickNextFeature(checkedIds);
    }
    if (!feature) {
      ctx.log('error', 'relay-feature-guardian.no-features', { reason: 'feature list is empty' });
      return;
    }

    // Build @mention string
    const userWill = input(ctx, 'SLACK_USER_WILL');
    const userKhaliq = input(ctx, 'SLACK_USER_KHALIQ');
    const mentions = [userWill && `<@${userWill}>`, userKhaliq && `<@${userKhaliq}>`]
      .filter(Boolean)
      .join(' ');
    const mentionPrefix = mentions ? `${mentions} — ` : '';

    // Generate quiz message
    const quizBody = await generateQuizMessage(ctx, feature, mentions);
    const remaining = totalFeatures - checkedIds.size - 1;
    const progressNote = `_[relay feature check · ${checkedIds.size + 1}/${totalFeatures} · ${remaining} remaining in cycle]_`;
    const message = [mentionPrefix + quizBody, '', progressNote].join('\n');

    // Post to Slack
    const slack = slackClient();
    const result = await slack.post(channel, message);
    if (!result.ts) {
      ctx.log('error', 'relay-feature-guardian.post-failed', { channel, feature: feature.id, ts: result.ts });
      return;
    }
    ctx.log('info', 'relay-feature-guardian.posted', { channel, feature: feature.id, ts: result.ts });

    // Persist updated progress
    checkedIds.add(feature.id);
    await saveProgress(ctx, {
      kind: 'relay-feature-guardian:progress',
      version: 1,
      checkedIds: [...checkedIds],
      cycleStartedAt: progress?.cycleStartedAt ?? new Date().toISOString(),
      totalFeatures
    });
  }
});
