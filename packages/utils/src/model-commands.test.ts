import { describe, it, expect } from 'vitest';
import {
  isModelSwitchSupported,
  buildModelSwitchCommand,
  validateModelForCli,
  getModelCommandConfig,
} from './model-commands.js';

describe('Model Commands', () => {
  describe('isModelSwitchSupported', () => {
    it('returns true for claude', () => {
      expect(isModelSwitchSupported('claude')).toBe(true);
    });

    it('returns false for codex', () => {
      expect(isModelSwitchSupported('codex')).toBe(false);
    });

    it('returns false for gemini', () => {
      expect(isModelSwitchSupported('gemini')).toBe(false);
    });

    it('returns false for aider', () => {
      expect(isModelSwitchSupported('aider')).toBe(false);
    });

    it('returns false for goose', () => {
      expect(isModelSwitchSupported('goose')).toBe(false);
    });

    it('returns false for droid', () => {
      expect(isModelSwitchSupported('droid')).toBe(false);
    });

    it('returns false for opencode', () => {
      expect(isModelSwitchSupported('opencode')).toBe(false);
    });

    it('returns false for cursor', () => {
      expect(isModelSwitchSupported('cursor')).toBe(false);
    });

    it('returns true for claude with variant prefix like claude:opus', () => {
      expect(isModelSwitchSupported('claude:opus')).toBe(true);
    });

    it('returns false for codex with variant prefix like codex:gpt4', () => {
      expect(isModelSwitchSupported('codex:gpt4')).toBe(false);
    });

    it('returns false for an unknown CLI type', () => {
      expect(isModelSwitchSupported('unknown-cli')).toBe(false);
    });

    it('handles case insensitivity for CLI names', () => {
      expect(isModelSwitchSupported('Claude')).toBe(true);
      expect(isModelSwitchSupported('CLAUDE')).toBe(true);
      expect(isModelSwitchSupported('Codex')).toBe(false);
    });
  });

  describe('buildModelSwitchCommand', () => {
    it('returns /model command string for claude with a valid model', () => {
      expect(buildModelSwitchCommand('claude', 'opus')).toBe('/model opus\n');
    });

    it('normalizes model aliases before building command', () => {
      expect(buildModelSwitchCommand('claude', 'claude-opus-4')).toBe('/model opus\n');
    });

    it('normalizes claude-sonnet-4 alias to sonnet', () => {
      expect(buildModelSwitchCommand('claude', 'claude-sonnet-4')).toBe('/model sonnet\n');
    });

    it('normalizes claude-haiku-3.5 alias to haiku', () => {
      expect(buildModelSwitchCommand('claude', 'claude-haiku-3.5')).toBe('/model haiku\n');
    });

    it('returns null for unsupported CLI types', () => {
      expect(buildModelSwitchCommand('codex', 'gpt-4')).toBeNull();
      expect(buildModelSwitchCommand('gemini', 'pro')).toBeNull();
      expect(buildModelSwitchCommand('aider', 'some-model')).toBeNull();
    });

    it('returns null for unknown CLI types', () => {
      expect(buildModelSwitchCommand('unknown', 'model')).toBeNull();
    });

    it('resolves CLI with variant prefix before building command', () => {
      expect(buildModelSwitchCommand('claude:opus', 'sonnet')).toBe('/model sonnet\n');
    });

    it('handles case insensitivity for CLI name', () => {
      expect(buildModelSwitchCommand('Claude', 'opus')).toBe('/model opus\n');
      expect(buildModelSwitchCommand('CLAUDE', 'opus')).toBe('/model opus\n');
    });

    it('passes through unknown model names without normalization changes', () => {
      expect(buildModelSwitchCommand('claude', 'somethingcustom')).toBe('/model somethingcustom\n');
    });
  });

  describe('validateModelForCli', () => {
    it('returns valid true for supported base models', () => {
      const result = validateModelForCli('claude', 'opus');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('opus');
    });

    it('returns valid true for sonnet', () => {
      const result = validateModelForCli('claude', 'sonnet');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('sonnet');
    });

    it('returns valid true for haiku', () => {
      const result = validateModelForCli('claude', 'haiku');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('haiku');
    });

    it('returns valid true and normalizes model aliases', () => {
      const result = validateModelForCli('claude', 'claude-opus-4');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('opus');
    });

    it('normalizes claude-opus-4.5 to opus', () => {
      const result = validateModelForCli('claude', 'claude-opus-4.5');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('opus');
    });

    it('normalizes claude-opus-4-6 to opus', () => {
      const result = validateModelForCli('claude', 'claude-opus-4-6');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('opus');
    });

    it('normalizes claude-sonnet-4-5 to sonnet', () => {
      const result = validateModelForCli('claude', 'claude-sonnet-4-5');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('sonnet');
    });

    it('normalizes claude-haiku-4.5 to haiku', () => {
      const result = validateModelForCli('claude', 'claude-haiku-4.5');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('haiku');
    });

    it('returns invalid for unsupported CLI', () => {
      const result = validateModelForCli('codex', 'gpt-4');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not support mid-session model switching');
      expect(result.error).toContain('codex');
    });

    it('returns invalid for unknown CLI', () => {
      const result = validateModelForCli('nonexistent', 'model');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not support mid-session model switching');
    });

    it('returns invalid for an unknown model on a supported CLI', () => {
      const result = validateModelForCli('claude', 'gpt-4');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid model');
      expect(result.error).toContain('gpt-4');
    });

    it('handles CLI with variant prefix', () => {
      const result = validateModelForCli('claude:opus', 'sonnet');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('sonnet');
    });

    it('handles case insensitivity in CLI name', () => {
      const result = validateModelForCli('Claude', 'opus');
      expect(result.valid).toBe(true);
      expect(result.normalizedModel).toBe('opus');
    });
  });

  describe('getModelCommandConfig', () => {
    it('returns supported config for claude', () => {
      const config = getModelCommandConfig('claude');
      expect(config.supported).toBe(true);
      expect(config.buildCommand).toBeDefined();
      expect(config.validModels).toBeDefined();
      expect(config.normalizeModel).toBeDefined();
    });

    it('returns unsupported config for codex', () => {
      const config = getModelCommandConfig('codex');
      expect(config.supported).toBe(false);
      expect(config.buildCommand).toBeUndefined();
    });

    it('returns unsupported config for gemini', () => {
      const config = getModelCommandConfig('gemini');
      expect(config.supported).toBe(false);
    });

    it('returns unsupported config for droid', () => {
      const config = getModelCommandConfig('droid');
      expect(config.supported).toBe(false);
    });

    it('returns unsupported config for opencode', () => {
      const config = getModelCommandConfig('opencode');
      expect(config.supported).toBe(false);
    });

    it('returns unsupported config for aider', () => {
      const config = getModelCommandConfig('aider');
      expect(config.supported).toBe(false);
    });

    it('returns unsupported config for goose', () => {
      const config = getModelCommandConfig('goose');
      expect(config.supported).toBe(false);
    });

    it('returns unsupported config for cursor', () => {
      const config = getModelCommandConfig('cursor');
      expect(config.supported).toBe(false);
    });

    it('returns default unsupported config for unknown CLI', () => {
      const config = getModelCommandConfig('totally-unknown');
      expect(config.supported).toBe(false);
      expect(config.buildCommand).toBeUndefined();
      expect(config.validModels).toBeUndefined();
      expect(config.normalizeModel).toBeUndefined();
    });

    it('strips variant prefix and resolves base CLI', () => {
      const config = getModelCommandConfig('claude:opus');
      expect(config.supported).toBe(true);
    });

    it('handles uppercase CLI name', () => {
      const config = getModelCommandConfig('CLAUDE');
      expect(config.supported).toBe(true);
    });

    it('includes all alias keys in validModels for claude', () => {
      const config = getModelCommandConfig('claude');
      expect(config.validModels).toContain('opus');
      expect(config.validModels).toContain('sonnet');
      expect(config.validModels).toContain('haiku');
      expect(config.validModels).toContain('claude-opus-4');
      expect(config.validModels).toContain('claude-sonnet-4');
      expect(config.validModels).toContain('claude-haiku-3.5');
    });

    it('normalizeModel trims whitespace and lowercases input', () => {
      const config = getModelCommandConfig('claude');
      expect(config.normalizeModel!('  OPUS  ')).toBe('opus');
      expect(config.normalizeModel!('  Claude-Opus-4  ')).toBe('opus');
    });

    it('buildCommand produces /model format with newline', () => {
      const config = getModelCommandConfig('claude');
      expect(config.buildCommand!('sonnet')).toBe('/model sonnet\n');
    });
  });
});
