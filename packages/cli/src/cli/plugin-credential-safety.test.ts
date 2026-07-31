import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const observerInstructionFiles = [
  'plugins/gemini-relay-extension/GEMINI.md',
  'plugins/gemini-relay-extension/commands/status/status.toml',
  'plugins/gemini-relay-extension/commands/team/team.toml',
  'plugins/gemini-relay-extension/commands/fanout/fanout.toml',
  'plugins/gemini-relay-extension/hooks/session-start.sh',
  'plugins/codex-relay-skill/SKILL.md',
] as const;

const agentFacingSkillFiles = [
  '.agents/skills/using-agent-relay/SKILL.md',
  '.claude/skills/using-agent-relay/SKILL.md',
] as const;

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function listPluginFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];

    const path = join(directory, entry.name);
    return entry.isDirectory() ? listPluginFiles(path) : [path];
  });
}

describe('shipped relay plugin credential safety', () => {
  it('does not construct observer URLs from workspace keys in shipped plugin assets', () => {
    const pluginFiles = [
      ...listPluginFiles(join(repoRoot, 'plugins/gemini-relay-extension')),
      ...listPluginFiles(join(repoRoot, 'plugins/codex-relay-skill')),
    ];

    for (const path of pluginFiles) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/agentrelay\.com\/observer\?key=/i);
    }
  });

  it('does not instruct agents to print real workspace keys or observer links', () => {
    for (const path of observerInstructionFiles) {
      const source = readRepoFile(path);
      expect(source, path).not.toMatch(/\b(?:actual key|real clickable URL)\b/i);
      expect(source, path).not.toMatch(/\bprint the observer URL\b/i);

      const credentialPrintLines = source
        .split('\n')
        .filter((line) => /\bprint\b/i.test(line) && /(?:workspace key|observer URL|ot_live_)/i.test(line));

      for (const line of credentialPrintLines) {
        expect(line, `${path}: ${line}`).toMatch(/\b(?:never|do not)\b[^\n]*\bprint\b/i);
      }
    }

    const sessionStartHook = readRepoFile('plugins/gemini-relay-extension/hooks/session-start.sh');
    expect(sessionStartHook).not.toMatch(/\bWORKSPACE_KEY\s*=/);
    expect(sessionStartHook).not.toMatch(/\$\{?WORKSPACE_KEY\b/);
  });

  it('keeps credential-printing startup commands out of mirrored agent-facing skills', () => {
    const [agentsSkill, claudeSkill] = agentFacingSkillFiles.map(readRepoFile);

    expect(agentsSkill).toBe(claudeSkill);
    expect(agentsSkill).not.toMatch(/\bagent-relay node (?:up|status)\b/);
  });
});
