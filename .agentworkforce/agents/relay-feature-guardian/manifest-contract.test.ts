import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Feature = { id: string; cli?: string; mcp?: string; mcp_prompt?: string; location?: string };
type Category = { features?: Feature[] };
type Manifest = {
  version: string;
  verification: { document: string; categories: Record<string, string> };
  categories: Record<string, Category>;
};

const manifestPath = new URL('../../features/manifest.yaml', import.meta.url);
const proceduresPath = new URL('../../features/verify/procedures.md', import.meta.url);
const manifest = parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const procedures = readFileSync(proceduresPath, 'utf8');
const features = Object.values(manifest.categories).flatMap((category) => category.features ?? []);

describe('feature manifest contract', () => {
  it('maps every category to a detailed verification procedure', () => {
    expect(manifest.version).toBe('1.1');
    expect(manifest.verification.document).toBe('.agentworkforce/features/verify/procedures.md');

    for (const category of Object.keys(manifest.categories)) {
      const procedure = manifest.verification.categories[category];
      expect(procedure, `${category} needs a verification procedure`).toMatch(/^[a-z0-9-]+$/);
      expect(procedures).toContain(`## ${procedure}`);
    }
  });

  it('has unique feature ids and a concrete CLI, MCP, or prompt surface', () => {
    const ids = features.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of features) {
      expect(feature.id).toMatch(/^[a-z0-9-]+$/);
      expect(Boolean(feature.cli || feature.mcp || feature.mcp_prompt || feature.location)).toBe(true);
    }
  });

  it('covers every public Commander leaf command', () => {
    const commands = features.flatMap((feature) => (feature.cli ? [feature.cli] : []));
    const expected = [
      'relay node up',
      'relay node down',
      'relay node status',
      'relay node metrics',
      'relay node deadletters',
      'relay node redeliver',
      'relay node tail',
      'relay node agent list',
      'relay node agent spawn',
      'relay node agent new',
      'relay node agent release',
      'relay node agent set-model',
      'relay node agent attach',
      'relay node agent message flush',
      'relay node agent message hold',
      'relay node agent message auto',
      'relay node workflow run',
      'relay node workflow logs',
      'relay node workflow sync',
      'relay version',
      'relay update',
      'relay uninstall',
      'relay status',
      'relay telemetry enable',
      'relay telemetry disable',
      'relay telemetry status',
      'relay cloud login',
      'relay cloud logout',
      'relay cloud session',
      'relay cloud whoami',
      'relay cloud connect',
      'relay cloud enroll',
      'relay cloud run',
      'relay cloud schedule',
      'relay cloud schedules',
      'relay cloud status',
      'relay cloud logs',
      'relay cloud sync',
      'relay cloud cancel',
      'relay cloud worker register',
      'relay cloud worker start',
      'relay cloud worker status',
      'relay cloud worker logs',
      'relay reflex on',
      'relay reflex off',
      'relay reflex status',
      'relay workspace active',
      'relay workspace create',
      'relay workspace list',
      'relay workspace set_key',
      'relay workspace join',
      'relay workspace switch',
      'relay agent register',
      'relay agent list',
      'relay agent add',
      'relay agent remove',
      'relay channel create',
      'relay channel list',
      'relay channel join',
      'relay channel leave',
      'relay channel invite',
      'relay channel set_topic',
      'relay channel archive',
      'relay message post',
      'relay message list',
      'relay message reply',
      'relay message get_thread',
      'relay message search',
      'relay message dm send',
      'relay message dm list',
      'relay message dm send_group',
      'relay message reaction add',
      'relay message reaction remove',
      'relay message inbox check',
      'relay message inbox mark_read',
      'relay message inbox get_readers',
      'relay message file upload',
      'relay integration subscribe',
      'relay integration unsubscribe',
      'relay integration webhook create',
      'relay integration webhook list',
      'relay integration webhook delete',
      'relay integration webhook trigger',
      'relay integration webhook create-inbound',
      'relay integration webhook list-inbound',
      'relay integration webhook delete-inbound',
      'relay integration subscription create',
      'relay integration subscription list',
      'relay integration subscription get',
      'relay integration subscription delete',
      'relay capabilities register',
      'relay capabilities list',
      'relay capabilities delete',
      'relay skills add',
      'relay mcp',
      'relay fleet nodes',
      'relay fleet spawn',
      'relay fleet release',
      'relay fleet config',
      'relay fleet enable',
      'relay fleet disable',
      'relay fleet inherit',
      'relay fleet status',
    ];

    for (const command of expected) {
      expect(
        commands.some((documented) => documented.startsWith(command)),
        `${command} is missing`
      ).toBe(true);
    }
    expect(commands).not.toContain('relay metrics');
    expect(commands).not.toContain('relay deadletters');
    expect(commands).not.toContain('relay redeliver [id]');
  });

  it('covers every static MCP tool registered by the server', () => {
    const tools = new Set(features.flatMap((feature) => (feature.mcp ? [feature.mcp] : [])));
    const expected = [
      'create_workspace',
      'set_workspace_key',
      'register_agent',
      'list_agents',
      'query_nodes',
      'add_agent',
      'spawn',
      'remove_agent',
      'create_channel',
      'list_channels',
      'join_channel',
      'leave_channel',
      'invite_to_channel',
      'set_channel_topic',
      'archive_channel',
      'post_message',
      'list_messages',
      'reply_to_thread',
      'get_message_thread',
      'send_dm',
      'list_dms',
      'send_group_dm',
      'add_reaction',
      'remove_reaction',
      'search_messages',
      'check_inbox',
      'mark_message_read',
      'get_message_readers',
      'list_actions',
      'invoke_action',
      'submit_result',
    ];
    expect([...tools].sort()).toEqual(expected.sort());
  });
});
