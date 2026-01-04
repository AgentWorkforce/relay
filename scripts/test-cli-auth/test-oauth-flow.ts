#!/usr/bin/env npx tsx
/**
 * CLI OAuth Flow Integration Test
 *
 * Tests the prompt handling and URL extraction for each provider
 * using mock CLIs that simulate the real interactive flows.
 *
 * Usage:
 *   npx tsx scripts/test-cli-auth/test-oauth-flow.ts [provider]
 *
 * Examples:
 *   npx tsx scripts/test-cli-auth/test-oauth-flow.ts           # Test all providers
 *   npx tsx scripts/test-cli-auth/test-oauth-flow.ts claude    # Test Claude only
 */

import * as pty from 'node-pty';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
} from '../../src/cloud/api/onboarding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestResult {
  provider: string;
  passed: boolean;
  urlExtracted: string | null;
  promptsResponded: string[];
  successDetected: boolean;
  output: string;
  error?: string;
}

/**
 * Test a single provider's OAuth flow using the mock CLI
 */
async function testProvider(providerId: string): Promise<TestResult> {
  const config = CLI_AUTH_CONFIG[providerId];
  if (!config) {
    return {
      provider: providerId,
      passed: false,
      urlExtracted: null,
      promptsResponded: [],
      successDetected: false,
      output: '',
      error: `Unknown provider: ${providerId}`,
    };
  }

  const result: TestResult = {
    provider: providerId,
    passed: false,
    urlExtracted: null,
    promptsResponded: [],
    successDetected: false,
    output: '',
  };

  return new Promise((resolve) => {
    const mockCliPath = path.join(__dirname, 'mock-cli.sh');
    const respondedPrompts = new Set<string>();

    // Map provider IDs to mock CLI provider names
    const mockProviderName = providerId === 'anthropic' ? 'claude' :
                             providerId === 'openai' ? 'codex' :
                             providerId === 'google' ? 'gemini' : providerId;

    const proc = pty.spawn('bash', [mockCliPath, mockProviderName, '0.2'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: __dirname,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      result.error = 'Timeout waiting for completion';
      resolve(result);
    }, 10000);

    proc.onData((data: string) => {
      result.output += data;

      // Check for matching prompts and auto-respond
      const matchingPrompt = findMatchingPrompt(data, config.prompts, respondedPrompts);
      if (matchingPrompt) {
        respondedPrompts.add(matchingPrompt.description);
        result.promptsResponded.push(matchingPrompt.description);
        setTimeout(() => {
          try {
            proc.write(matchingPrompt.response);
          } catch {
            // Process may have exited
          }
        }, matchingPrompt.delay ?? 50);
      }

      // Look for auth URL
      const cleanText = stripAnsiCodes(data);
      const match = cleanText.match(config.urlPattern);
      if (match && match[1] && !result.urlExtracted) {
        result.urlExtracted = match[1];
      }

      // Check for success indicators
      if (matchesSuccessPattern(data, config.successPatterns)) {
        result.successDetected = true;
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timeout);

      // Determine if test passed
      result.passed = !!(
        result.urlExtracted &&
        result.successDetected &&
        exitCode === 0
      );

      // Send completion signal to mock CLI
      setTimeout(() => resolve(result), 100);
    });

    // For mock CLI, send signal to continue after prompts
    setTimeout(() => {
      try {
        proc.write('\n'); // Signal to continue
      } catch {
        // Ignore
      }
    }, 3000);
  });
}

/**
 * Run tests for specified providers or all providers
 */
async function runTests(providers?: string[]) {
  const providerIds = providers ?? Object.keys(CLI_AUTH_CONFIG);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           CLI OAuth Flow Integration Tests                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const results: TestResult[] = [];

  for (const providerId of providerIds) {
    const config = CLI_AUTH_CONFIG[providerId];
    if (!config) {
      console.log(`⚠️  Unknown provider: ${providerId}`);
      continue;
    }

    console.log(`Testing ${config.displayName} (${providerId})...`);

    const result = await testProvider(providerId);
    results.push(result);

    if (result.passed) {
      console.log(`  ✅ PASSED`);
    } else {
      console.log(`  ❌ FAILED${result.error ? `: ${result.error}` : ''}`);
    }

    console.log(`     URL extracted: ${result.urlExtracted ? '✓' : '✗'}`);
    console.log(`     Success detected: ${result.successDetected ? '✓' : '✗'}`);
    if (result.promptsResponded.length > 0) {
      console.log(`     Prompts responded: ${result.promptsResponded.join(', ')}`);
    }
    console.log('');
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Exit with error if any tests failed
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  - ${result.provider}: ${result.error || 'See details above'}`);
    }
    process.exit(1);
  }
}

// Parse CLI args
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
CLI OAuth Flow Integration Test

Usage:
  npx tsx scripts/test-cli-auth/test-oauth-flow.ts [provider...]

Examples:
  npx tsx scripts/test-cli-auth/test-oauth-flow.ts           # Test all providers
  npx tsx scripts/test-cli-auth/test-oauth-flow.ts anthropic # Test Claude only
  npx tsx scripts/test-cli-auth/test-oauth-flow.ts anthropic openai # Test multiple

Providers:
  ${Object.keys(CLI_AUTH_CONFIG).join(', ')}
`);
  process.exit(0);
}

runTests(args.length > 0 ? args : undefined).catch(console.error);
