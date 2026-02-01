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

  describe('auto-detect integration pattern', () => {
    // Tests the pattern used by TmuxWrapper and PtyWrapper
    // to auto-detect agent role from config files

    it('detects role when config exists with description', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'backend.md'), `---
name: backend
description: Backend development agent - handles server-side tasks
model: sonnet
---
# Backend Agent
`);

      // Simulate wrapper auto-detect pattern
      const configTask: string | undefined = undefined; // No explicit task
      let detectedTask = configTask;
      if (!detectedTask) {
        const agentConfig = findAgentConfig('Backend', tempDir);
        if (agentConfig?.description) {
          detectedTask = agentConfig.description;
        }
      }

      expect(detectedTask).toBe('Backend development agent - handles server-side tasks');
    });

    it('uses explicit task when provided', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'worker.md'), `---
description: Config description
---
`);

      // Simulate wrapper auto-detect pattern with explicit task
      const configTask = 'Explicit task override';
      let detectedTask = configTask;
      if (!detectedTask) {
        const agentConfig = findAgentConfig('Worker', tempDir);
        if (agentConfig?.description) {
          detectedTask = agentConfig.description;
        }
      }

      expect(detectedTask).toBe('Explicit task override');
    });

    it('handles missing config gracefully', () => {
      // Simulate wrapper auto-detect pattern with no config
      const configTask: string | undefined = undefined;
      let detectedTask = configTask;
      if (!detectedTask) {
        const agentConfig = findAgentConfig('NonExistent', tempDir);
        if (agentConfig?.description) {
          detectedTask = agentConfig.description;
        }
      }

      expect(detectedTask).toBeUndefined();
    });

    it('handles config without description gracefully', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'nodesc.md'), `---
name: nodesc
model: haiku
---
# Agent without description
`);

      // Simulate wrapper auto-detect pattern
      const configTask: string | undefined = undefined;
      let detectedTask = configTask;
      if (!detectedTask) {
        const agentConfig = findAgentConfig('nodesc', tempDir);
        if (agentConfig?.description) {
          detectedTask = agentConfig.description;
        }
      }

      expect(detectedTask).toBeUndefined();
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

  describe('file permissions in agent config', () => {
    it('parses file-allowed from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'worker.md'), `---
name: worker
file-allowed: src/**, tests/**
---
`);

      const result = findAgentConfig('worker', tempDir);
      expect(result?.filePermissions?.allowed).toEqual(['src/**', 'tests/**']);
    });

    it('parses file-disallowed from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'secure.md'), `---
name: secure
file-disallowed: .env*, secrets/**, *.pem
---
`);

      const result = findAgentConfig('secure', tempDir);
      expect(result?.filePermissions?.disallowed).toEqual(['.env*', 'secrets/**', '*.pem']);
    });

    it('parses file-readonly from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'reader.md'), `---
name: reader
file-readonly: package.json, tsconfig.json
---
`);

      const result = findAgentConfig('reader', tempDir);
      expect(result?.filePermissions?.readOnly).toEqual(['package.json', 'tsconfig.json']);
    });

    it('parses file-writable from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'writer.md'), `---
name: writer
file-writable: dist/**, build/**
---
`);

      const result = findAgentConfig('writer', tempDir);
      expect(result?.filePermissions?.writable).toEqual(['dist/**', 'build/**']);
    });

    it('parses file-network from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'offline.md'), `---
name: offline
file-network: false
---
`);

      const result = findAgentConfig('offline', tempDir);
      expect(result?.filePermissions?.allowNetwork).toBe(false);
    });

    it('parses file-network: true from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'online.md'), `---
name: online
file-network: true
---
`);

      const result = findAgentConfig('online', tempDir);
      expect(result?.filePermissions?.allowNetwork).toBe(true);
    });

    it('parses file-preset from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'preset.md'), `---
name: preset
file-preset: block-secrets
---
`);

      const result = findAgentConfig('preset', tempDir);
      expect(result?.filePermissionPreset).toBe('block-secrets');
    });

    it('parses all file presets', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });

      const presets = ['block-secrets', 'source-only', 'read-only', 'docs-only'];
      for (const preset of presets) {
        fs.writeFileSync(path.join(agentsDir, `${preset}-test.md`), `---
name: ${preset}-test
file-preset: ${preset}
---
`);
        const result = findAgentConfig(`${preset}-test`, tempDir);
        expect(result?.filePermissionPreset).toBe(preset);
      }
    });

    it('ignores invalid file-preset values', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'invalid.md'), `---
name: invalid
file-preset: invalid-preset
---
`);

      const result = findAgentConfig('invalid', tempDir);
      expect(result?.filePermissionPreset).toBeUndefined();
    });

    it('parses allowed-cwd from frontmatter', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'cwd.md'), `---
name: cwd
allowed-cwd: src, tests
---
`);

      const result = findAgentConfig('cwd', tempDir);
      expect(result?.allowedCwd).toEqual(['src', 'tests']);
    });

    it('parses multiple file permission fields together', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'full.md'), `---
name: full
file-allowed: src/**
file-disallowed: .env*
file-readonly: package.json
file-writable: dist/**
file-network: false
file-preset: block-secrets
allowed-cwd: src
---
`);

      const result = findAgentConfig('full', tempDir);
      expect(result?.filePermissions?.allowed).toEqual(['src/**']);
      expect(result?.filePermissions?.disallowed).toEqual(['.env*']);
      expect(result?.filePermissions?.readOnly).toEqual(['package.json']);
      expect(result?.filePermissions?.writable).toEqual(['dist/**']);
      expect(result?.filePermissions?.allowNetwork).toBe(false);
      expect(result?.filePermissionPreset).toBe('block-secrets');
      expect(result?.allowedCwd).toEqual(['src']);
    });

    it('returns undefined filePermissions when no file fields present', () => {
      const agentsDir = path.join(tempDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'nofile.md'), `---
name: nofile
model: haiku
---
`);

      const result = findAgentConfig('nofile', tempDir);
      expect(result?.filePermissions).toBeUndefined();
    });
  });
});
