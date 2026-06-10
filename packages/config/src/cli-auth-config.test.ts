import { describe, expect, it } from 'vitest';
import { CLI_AUTH_CONFIG, validateAllProviderConfigs } from './cli-auth-config.js';

describe('CLI auth config', () => {
  it('validates all provider configs', () => {
    expect(validateAllProviderConfigs()).toEqual([]);
  });

  it('configures grok (xai) with a device-code flow and the grok auth file', () => {
    const xai = CLI_AUTH_CONFIG.xai;
    expect(xai.command).toBe('grok');
    expect(xai.supportsDeviceFlow).toBe(true);
    expect(xai.deviceFlowArgs).toEqual(['login', '--device-auth']);
    expect(xai.credentialPath).toBe('~/.grok/auth.json');
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
});
