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

  it('captures Daytona via the sandbox login flow', () => {
    const daytona = CLI_AUTH_CONFIG.daytona;
    // The capture contract: run `daytona login` and read the CLI's token store
    // from the Linux (XDG) config path so the cloud handler can extract
    // profiles[active].api.token + activeOrganizationId.
    expect(daytona.command).toBe('daytona');
    expect(daytona.args).toEqual(['login']);
    expect(daytona.credentialPath).toBe('~/.config/daytona/config.json');

    // The surfaced Auth0 URL must be extractable for the user to open.
    const authLine = 'Please visit https://daytonaio.us.auth0.com/activate?user_code=ABCD to log in';
    expect(authLine.match(daytona.urlPattern)?.[1]).toBe(
      'https://daytonaio.us.auth0.com/activate?user_code=ABCD'
    );

    // A successful login must be detected from the CLI's terminal output.
    expect(daytona.successPatterns.some((p) => p.test('Logged in as user@example.com'))).toBe(true);
  });
});
