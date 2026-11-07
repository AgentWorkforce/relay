import { describe, expect, it } from 'vitest';

import { clientLabel, pickAvailableName, sanitizeNameSegment, sessionBaseName } from './mcp-session-name.js';

describe('clientLabel', () => {
  // clientInfo.name values captured from the real tools' MCP handshakes.
  it.each([
    ['claude-code', 'claude'],
    ['codex-mcp-client', 'codex'],
    ['opencode', 'opencode'],
    ['pi', 'pi'],
    ['grok-shell', 'grok'],
    ['grok-shell-stub', 'grok'],
    ['cursor-vscode', 'cursor'],
    ['gemini-cli-mcp-client', 'gemini'],
    ['Visual Studio Code', 'vscode'],
  ])('%s -> %s', (clientName, label) => {
    expect(clientLabel(clientName)).toBe(label);
  });

  it('uses the install hint when the client only names its MCP library (Devin reports rmcp)', () => {
    expect(clientLabel('rmcp', 'devin')).toBe('devin');
    expect(clientLabel(undefined, 'devin')).toBe('devin');
  });

  it('prefers a known client name over the hint, since tools read each other’s configs', () => {
    expect(clientLabel('claude-code', 'grok')).toBe('claude');
  });

  it('keeps an unknown client name, trimmed of client suffixes', () => {
    expect(clientLabel('zed-mcp-client')).toBe('zed');
    expect(clientLabel('My Editor')).toBe('my-editor');
  });

  it('never returns an empty or shared default like orchestrator', () => {
    expect(clientLabel(undefined)).toBe('agent');
    expect(clientLabel('rmcp')).toBe('agent');
    expect(clientLabel('')).toBe('agent');
  });
});

describe('sessionBaseName', () => {
  it('joins the tool and the project folder', () => {
    expect(sessionBaseName({ clientName: 'claude-code', cwd: '/home/me/src/myproject' })).toBe(
      'claude-myproject'
    );
    expect(sessionBaseName({ clientName: 'codex-mcp-client', cwd: '/home/me/src/myproject/' })).toBe(
      'codex-myproject'
    );
  });

  it('sanitizes the folder name', () => {
    expect(sessionBaseName({ clientName: 'claude-code', cwd: '/w/My Project_v2 (copy)' })).toBe(
      'claude-my-project-v2-copy'
    );
    expect(sessionBaseName({ clientName: 'pi', cwd: '/w/Café' })).toBe('pi-cafe');
  });

  it('uses the tool alone at the filesystem root', () => {
    expect(sessionBaseName({ clientName: 'claude-code', cwd: '/' })).toBe('claude');
  });

  it('limits the length', () => {
    const name = sessionBaseName({ clientName: 'claude-code', cwd: `/w/${'a'.repeat(100)}` });
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.startsWith('claude-aaaa')).toBe(true);
  });
});

describe('pickAvailableName', () => {
  it('uses the base name when no live session holds it', () => {
    expect(pickAvailableName('claude-myproject', new Set(['codex-myproject']))).toBe('claude-myproject');
  });

  it('adds a short suffix when a live session holds it', () => {
    expect(pickAvailableName('claude-myproject', new Set(['claude-myproject']))).toBe('claude-myproject-2');
    expect(pickAvailableName('claude-myproject', new Set(['claude-myproject', 'claude-myproject-2']))).toBe(
      'claude-myproject-3'
    );
  });

  it('falls back to a random suffix after nine sessions', () => {
    const live = new Set(['x', ...Array.from({ length: 8 }, (_, i) => `x-${i + 2}`)]);
    expect(pickAvailableName('x', live, () => 'beef')).toBe('x-beef');
  });
});

it('sanitizeNameSegment keeps letters, digits and single dashes', () => {
  expect(sanitizeNameSegment('--Hello__World!!--')).toBe('hello-world');
});
