import { describe, expect, it } from 'vitest';
import { CLI_AUTH_CONFIG, validateAllProviderConfigs } from './cli-auth-config.js';

describe('CLI auth config', () => {
  it('validates all provider configs', () => {
    expect(validateAllProviderConfigs()).toEqual([]);
  });

  it('recognizes OpenCode API-key completion output', () => {
    const transcript = [
      'Add credential',
      'Select provider',
      'OpenCode Zen',
      'Create an api key at https://opencode.ai/auth',
      'Enter your API key',
      'secret',
      '└  Done',
    ].join('\n');

    expect(CLI_AUTH_CONFIG.opencode.successPatterns.some((pattern) => pattern.test(transcript))).toBe(true);
  });

  it('configures Grok auth through the xAI provider', () => {
    expect(CLI_AUTH_CONFIG.xai.command).toBe('grok');
    expect(CLI_AUTH_CONFIG.xai.args).toEqual(['login']);
    expect(CLI_AUTH_CONFIG.xai.deviceFlowArgs).toEqual(['login', '--device-auth']);
    expect(CLI_AUTH_CONFIG.xai.credentialPath).toBe('~/.grok/auth.json');
    expect(CLI_AUTH_CONFIG.xai.installCommand).toContain('https://x.ai/cli/install.sh');
  });
});
