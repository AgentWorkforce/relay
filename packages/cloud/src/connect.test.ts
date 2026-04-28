import { describe, expect, it } from 'vitest';

import { getProviderHelpText, normalizeProvider } from './connect.js';

describe('normalizeProvider', () => {
  it('maps friendly aliases to canonical provider ids', () => {
    expect(normalizeProvider('claude')).toBe('anthropic');
    expect(normalizeProvider('codex')).toBe('openai');
    expect(normalizeProvider('gemini')).toBe('google');
  });

  it('lowercases and trims unknown values without rewriting them', () => {
    expect(normalizeProvider('  Anthropic  ')).toBe('anthropic');
    expect(normalizeProvider('OpenAI')).toBe('openai');
    expect(normalizeProvider('something-new')).toBe('something-new');
  });
});

describe('getProviderHelpText', () => {
  it('lists known providers with their CLI aliases', () => {
    const help = getProviderHelpText();

    expect(help).toContain('anthropic (alias: claude)');
    expect(help).toContain('openai (alias: codex)');
    expect(help).toContain('google (alias: gemini)');
  });
});
