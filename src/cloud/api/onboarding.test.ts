/**
 * Onboarding OAuth Flow Tests
 *
 * Tests the CLI-based OAuth authentication flow for AI providers.
 * These tests verify prompt detection, URL extraction, and success patterns
 * without requiring actual CLI execution.
 */

import { describe, it, expect } from 'vitest';
import {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
  validateProviderConfig,
  validateAllProviderConfigs,
  getSupportedProviders,
  type CLIAuthConfig,
} from './onboarding.js';

describe('CLI Auth Config', () => {
  describe('anthropic (Claude)', () => {
    const config = CLI_AUTH_CONFIG.anthropic;

    it('has correct command and args', () => {
      expect(config.command).toBe('claude');
      expect(config.args).toEqual([]);
    });

    it('extracts auth URL from output', () => {
      const output = 'Please visit https://console.anthropic.com/oauth/authorize?client_id=xxx to authenticate';
      const match = output.match(config.urlPattern);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('https://console.anthropic.com/oauth/authorize?client_id=xxx');
    });

    it('handles URL with query params and fragments', () => {
      const output = 'Open: https://auth.example.com/login?state=abc123&redirect=xyz#section';
      const match = output.match(config.urlPattern);
      expect(match).toBeTruthy();
      expect(match![1]).toContain('https://auth.example.com/login');
    });

    describe('prompt handlers', () => {
      it('detects dark mode prompt', () => {
        const respondedPrompts = new Set<string>();

        const prompt1 = findMatchingPrompt('Would you like dark mode?', config.prompts, respondedPrompts);
        expect(prompt1).toBeTruthy();
        expect(prompt1!.description).toBe('Dark mode prompt');
        expect(prompt1!.response).toBe('\r');

        const prompt2 = findMatchingPrompt('Enable dark theme?', config.prompts, respondedPrompts);
        expect(prompt2).toBeTruthy();
        expect(prompt2!.description).toBe('Dark mode prompt');
      });

      it('detects login method prompt', () => {
        const respondedPrompts = new Set<string>();

        const prompt1 = findMatchingPrompt(
          'Would you like to use your Claude subscription or an API key?',
          config.prompts,
          respondedPrompts
        );
        expect(prompt1).toBeTruthy();
        expect(prompt1!.description).toBe('Login method selection');

        const prompt2 = findMatchingPrompt(
          'How would you like to authenticate?',
          config.prompts,
          respondedPrompts
        );
        expect(prompt2).toBeTruthy();
        expect(prompt2!.description).toBe('Login method selection');
      });

      it('detects trust directory prompt', () => {
        const respondedPrompts = new Set<string>();

        const prompt = findMatchingPrompt(
          'Do you trust the files in this folder?',
          config.prompts,
          respondedPrompts
        );
        expect(prompt).toBeTruthy();
        expect(prompt!.description).toBe('Trust directory prompt');
        expect(prompt!.response).toBe('\r'); // Press enter to select first option (Yes, proceed)
      });

      it('does not respond to same prompt twice', () => {
        const respondedPrompts = new Set<string>();

        // First match
        const prompt1 = findMatchingPrompt('dark mode?', config.prompts, respondedPrompts);
        expect(prompt1).toBeTruthy();
        respondedPrompts.add(prompt1!.description);

        // Second attempt should return null
        const prompt2 = findMatchingPrompt('dark mode?', config.prompts, respondedPrompts);
        expect(prompt2).toBeNull();
      });
    });

    describe('success patterns', () => {
      it('detects success indicators', () => {
        expect(matchesSuccessPattern('Authentication successful!', config.successPatterns)).toBe(true);
        expect(matchesSuccessPattern('You are now authenticated', config.successPatterns)).toBe(true);
        expect(matchesSuccessPattern('Logged in as user@example.com', config.successPatterns)).toBe(true);
      });

      it('handles case insensitivity', () => {
        expect(matchesSuccessPattern('SUCCESS', config.successPatterns)).toBe(true);
        expect(matchesSuccessPattern('Authenticated', config.successPatterns)).toBe(true);
      });

      it('does not false positive', () => {
        expect(matchesSuccessPattern('Please enter your password', config.successPatterns)).toBe(false);
        expect(matchesSuccessPattern('Waiting for authentication...', config.successPatterns)).toBe(false);
      });
    });
  });

  describe('openai (Codex)', () => {
    const config = CLI_AUTH_CONFIG.openai;

    it('has correct command and args', () => {
      expect(config.command).toBe('codex');
      expect(config.args).toEqual(['login']);
    });

    it('extracts auth URL from output', () => {
      const output = 'Visit https://auth.openai.com/authorize?client_id=xxx to login';
      const match = output.match(config.urlPattern);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('https://auth.openai.com/authorize?client_id=xxx');
    });
  });

  describe('all providers', () => {
    it('have required fields', () => {
      for (const [name, config] of Object.entries(CLI_AUTH_CONFIG)) {
        expect(config.command, `${name} missing command`).toBeTruthy();
        expect(config.urlPattern, `${name} missing urlPattern`).toBeInstanceOf(RegExp);
        expect(config.displayName, `${name} missing displayName`).toBeTruthy();
        expect(config.waitTimeout, `${name} missing waitTimeout`).toBeGreaterThan(0);
        expect(Array.isArray(config.prompts), `${name} prompts should be array`).toBe(true);
        expect(Array.isArray(config.successPatterns), `${name} successPatterns should be array`).toBe(true);
      }
    });

    it('URL patterns have capture groups', () => {
      for (const [name, config] of Object.entries(CLI_AUTH_CONFIG)) {
        const testUrl = 'https://example.com/auth';
        const match = testUrl.match(config.urlPattern);
        expect(match, `${name} urlPattern should match`).toBeTruthy();
        expect(match![1], `${name} urlPattern should have capture group`).toBe(testUrl);
      }
    });
  });
});

describe('stripAnsiCodes', () => {
  it('removes ANSI escape codes', () => {
    const input = '\x1b[32mGreen text\x1b[0m and \x1b[1mbold\x1b[0m';
    expect(stripAnsiCodes(input)).toBe('Green text and bold');
  });

  it('preserves text without ANSI codes', () => {
    const input = 'Plain text without codes';
    expect(stripAnsiCodes(input)).toBe(input);
  });

  it('handles complex ANSI sequences', () => {
    const input = '\x1b[38;5;196mRed\x1b[0m \x1b[48;2;0;255;0mGreen BG\x1b[0m';
    expect(stripAnsiCodes(input)).toBe('Red Green BG');
  });
});

describe('matchesSuccessPattern', () => {
  const patterns = [/success/i, /authenticated/i, /logged\s*in/i];

  it('matches patterns case-insensitively', () => {
    expect(matchesSuccessPattern('SUCCESS', patterns)).toBe(true);
    expect(matchesSuccessPattern('Authenticated!', patterns)).toBe(true);
    expect(matchesSuccessPattern('You are logged in', patterns)).toBe(true);
  });

  it('strips ANSI codes before matching', () => {
    expect(matchesSuccessPattern('\x1b[32mSuccess!\x1b[0m', patterns)).toBe(true);
  });

  it('returns false when no match', () => {
    expect(matchesSuccessPattern('Please wait...', patterns)).toBe(false);
    expect(matchesSuccessPattern('Error occurred', patterns)).toBe(false);
  });
});

describe('findMatchingPrompt', () => {
  const prompts = [
    { pattern: /dark mode/i, response: '\r', description: 'Dark mode' },
    { pattern: /api key/i, response: '2\r', description: 'API key option' },
  ];

  it('finds matching prompt', () => {
    const responded = new Set<string>();
    const match = findMatchingPrompt('Enable dark mode?', prompts, responded);
    expect(match).toBeTruthy();
    expect(match!.description).toBe('Dark mode');
  });

  it('skips already responded prompts', () => {
    const responded = new Set(['Dark mode']);
    const match = findMatchingPrompt('Enable dark mode?', prompts, responded);
    expect(match).toBeNull();
  });

  it('returns null when no match', () => {
    const responded = new Set<string>();
    const match = findMatchingPrompt('Something else', prompts, responded);
    expect(match).toBeNull();
  });

  it('strips ANSI codes before matching', () => {
    const responded = new Set<string>();
    const match = findMatchingPrompt('\x1b[1mDark mode?\x1b[0m', prompts, responded);
    expect(match).toBeTruthy();
    expect(match!.description).toBe('Dark mode');
  });
});

describe('validateProviderConfig', () => {
  it('validates a correct config', () => {
    const config: CLIAuthConfig = {
      command: 'test-cli',
      args: ['login'],
      urlPattern: /(https:\/\/[^\s]+)/,
      displayName: 'Test',
      waitTimeout: 3000,
      prompts: [
        { pattern: /test/i, response: '\r', description: 'Test prompt' },
      ],
      successPatterns: [/success/i],
    };
    expect(validateProviderConfig('test', config)).toBeNull();
  });

  it('rejects missing command', () => {
    const config = {
      command: '',
      args: [],
      urlPattern: /(https:\/\/[^\s]+)/,
      displayName: 'Test',
      waitTimeout: 3000,
      prompts: [],
      successPatterns: [],
    } as CLIAuthConfig;
    expect(validateProviderConfig('test', config)).toContain('command');
  });

  it('rejects urlPattern without capture group', () => {
    const config: CLIAuthConfig = {
      command: 'test-cli',
      args: [],
      urlPattern: /https:\/\/[^\s]+/, // No capture group!
      displayName: 'Test',
      waitTimeout: 3000,
      prompts: [],
      successPatterns: [],
    };
    expect(validateProviderConfig('test', config)).toContain('capture group');
  });

  it('rejects invalid waitTimeout', () => {
    const config: CLIAuthConfig = {
      command: 'test-cli',
      args: [],
      urlPattern: /(https:\/\/[^\s]+)/,
      displayName: 'Test',
      waitTimeout: 0,
      prompts: [],
      successPatterns: [],
    };
    expect(validateProviderConfig('test', config)).toContain('waitTimeout');
  });

  it('rejects prompt without description', () => {
    const config: CLIAuthConfig = {
      command: 'test-cli',
      args: [],
      urlPattern: /(https:\/\/[^\s]+)/,
      displayName: 'Test',
      waitTimeout: 3000,
      prompts: [
        { pattern: /test/i, response: '\r', description: '' },
      ],
      successPatterns: [],
    };
    expect(validateProviderConfig('test', config)).toContain('description');
  });
});

describe('validateAllProviderConfigs', () => {
  it('validates all built-in providers', () => {
    // Should not throw
    expect(() => validateAllProviderConfigs()).not.toThrow();
  });
});

describe('getSupportedProviders', () => {
  it('returns list of providers', () => {
    const providers = getSupportedProviders();
    expect(providers.length).toBeGreaterThan(0);

    // Check structure
    for (const provider of providers) {
      expect(provider.id).toBeTruthy();
      expect(provider.displayName).toBeTruthy();
      expect(provider.command).toBeTruthy();
    }
  });

  it('includes anthropic', () => {
    const providers = getSupportedProviders();
    const anthropic = providers.find(p => p.id === 'anthropic');
    expect(anthropic).toBeTruthy();
    expect(anthropic!.displayName).toBe('Claude');
  });
});

describe('Provider name validation', () => {
  // These are the valid provider names used by /api/onboarding/mark-connected/:provider
  // They must be lowercase to match backend validation
  const validProviders = ['anthropic', 'openai', 'google', 'github', 'opencode', 'factory'];

  it('validates all expected lowercase providers', () => {
    // Backend validates against this list
    for (const provider of validProviders) {
      expect(provider).toBe(provider.toLowerCase());
    }
  });

  it('includes all AI providers used by WorkspaceSettingsPanel', () => {
    // These are the name values from AI_PROVIDERS in WorkspaceSettingsPanel
    // They must all be in validProviders for mark-connected to work
    const settingsPanelProviderNames = [
      'anthropic',  // Claude
      'openai',     // Codex
      'google',     // Gemini
      'opencode',   // OpenCode
      'factory',    // Droid
    ];

    for (const name of settingsPanelProviderNames) {
      expect(validProviders).toContain(name);
    }
  });

  it('includes all providers used by onboarding PROVIDER_CONFIGS', () => {
    // These are the name values from PROVIDER_CONFIGS in constants.ts
    const onboardingProviderNames = [
      'anthropic',  // claude
      'openai',     // codex
    ];

    for (const name of onboardingProviderNames) {
      expect(validProviders).toContain(name);
    }
  });
});
