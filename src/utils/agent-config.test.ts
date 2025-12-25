import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findAgentConfig, isClaudeCli, buildClaudeArgs } from './agent-config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('agent-config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findAgentConfig', () => {
    it('returns null when no config exists', () => {
      const result = findAgentConfig('Lead', tempDir);
      expect(result).toBeNull();
    });

    it('finds config in .claude/agents/', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'lead.md'), `---
name: lead
model: haiku
description: Test agent
---

# Lead Agent
`);

      const result = findAgentConfig('Lead', tempDir);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('lead');
      expect(result?.model).toBe('haiku');
      expect(result?.description).toBe('Test agent');
    });

    it('finds config case-insensitively', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'MyAgent.md'), `---
name: MyAgent
model: opus
---
`);

      const result = findAgentConfig('myagent', tempDir);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('MyAgent');
      expect(result?.model).toBe('opus');
    });

    it('finds config in .openagents/', () => {
      const agentsDir = path.join(tempDir, '.openagents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'worker.md'), `---
name: worker
model: sonnet
---
`);

      const result = findAgentConfig('Worker', tempDir);
      expect(result).not.toBeNull();
      expect(result?.model).toBe('sonnet');
    });

    it('prefers .claude/agents/ over .openagents/', () => {
      // Create both directories
      const claudeDir = path.join(tempDir, '.claude', 'agents');
      const openDir = path.join(tempDir, '.openagents');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.mkdirSync(openDir, { recursive: true });

      fs.writeFileSync(path.join(claudeDir, 'agent.md'), `---
model: haiku
---
`);
      fs.writeFileSync(path.join(openDir, 'agent.md'), `---
model: opus
---
`);

      const result = findAgentConfig('agent', tempDir);
      expect(result?.model).toBe('haiku'); // Claude takes precedence
    });

    it('parses allowed-tools from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'test.md'), `---
name: test
allowed-tools: Read, Grep, Glob
---
`);

      const result = findAgentConfig('test', tempDir);
      expect(result?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    });
  });

  describe('isClaudeCli', () => {
    it('returns true for "claude"', () => {
      expect(isClaudeCli('claude')).toBe(true);
    });

    it('returns true for paths containing claude', () => {
      expect(isClaudeCli('/usr/local/bin/claude')).toBe(true);
    });

    it('returns false for other commands', () => {
      expect(isClaudeCli('codex')).toBe(false);
      expect(isClaudeCli('gemini')).toBe(false);
      expect(isClaudeCli('node')).toBe(false);
    });
  });

  describe('buildClaudeArgs', () => {
    it('returns existing args when no config found', () => {
      const args = buildClaudeArgs('Unknown', ['--debug'], tempDir);
      expect(args).toEqual(['--debug']);
    });

    it('adds --model and --agent when config found', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'lead.md'), `---
name: lead
model: haiku
---
`);

      const args = buildClaudeArgs('Lead', [], tempDir);
      expect(args).toContain('--model');
      expect(args).toContain('haiku');
      expect(args).toContain('--agent');
      expect(args).toContain('lead');
    });

    it('does not duplicate --model if already present', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'lead.md'), `---
model: haiku
---
`);

      const args = buildClaudeArgs('Lead', ['--model', 'opus'], tempDir);
      const modelCount = args.filter(a => a === '--model').length;
      expect(modelCount).toBe(1);
      expect(args).toContain('opus'); // Original preserved
    });
  });
});
