#!/usr/bin/env npx tsx
/**
 * CI Test Runner for CLI OAuth Flow
 *
 * This script runs in a Docker container and tests each provider's
 * CLI OAuth flow to ensure URL extraction works correctly.
 *
 * Exit codes:
 *   0 - All tests passed
 *   1 - One or more tests failed
 *
 * Output format (JSON):
 *   { "results": [...], "summary": { "passed": N, "failed": N } }
 */

import * as pty from 'node-pty';
import { writeFileSync } from 'fs';

// Provider configurations - must match CLI_AUTH_CONFIG in onboarding.ts
const PROVIDERS = {
  anthropic: {
    command: 'claude',
    args: [] as string[],
    urlPattern: /(https:\/\/[^\s]+)/,
    expectedUrlPrefix: 'https://console.anthropic.com',
    prompts: [
      { pattern: /dark\s*(mode|theme)/i, response: '\r' },
      { pattern: /(subscription|api\s*key)/i, response: '\r' },
      { pattern: /trust/i, response: 'y\r' },
    ],
  },
  openai: {
    command: 'codex',
    args: ['login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    expectedUrlPrefix: 'https://auth.openai.com',
    prompts: [
      { pattern: /trust/i, response: 'y\r' },
    ],
  },
  google: {
    command: 'gemini',
    args: [] as string[],
    urlPattern: /(https:\/\/[^\s]+)/,
    expectedUrlPrefix: 'https://accounts.google.com',
    prompts: [],
  },
  opencode: {
    command: 'opencode',
    args: [] as string[],
    urlPattern: /(https:\/\/[^\s]+)/,
    expectedUrlPrefix: 'https://opencode.ai',
    prompts: [],
  },
  droid: {
    command: 'droid',
    args: [] as string[],
    urlPattern: /(https:\/\/[^\s]+)/,
    expectedUrlPrefix: 'https://factory.ai',
    prompts: [],
  },
};

interface TestResult {
  provider: string;
  command: string;
  passed: boolean;
  urlExtracted: string | null;
  urlValid: boolean;
  promptsHandled: number;
  exitCode: number | null;
  duration: number;
  output: string;
  error?: string;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

async function testProvider(providerId: string): Promise<TestResult> {
  const config = PROVIDERS[providerId as keyof typeof PROVIDERS];
  if (!config) {
    return {
      provider: providerId,
      command: 'unknown',
      passed: false,
      urlExtracted: null,
      urlValid: false,
      promptsHandled: 0,
      exitCode: null,
      duration: 0,
      output: '',
      error: `Unknown provider: ${providerId}`,
    };
  }

  const startTime = Date.now();
  const result: TestResult = {
    provider: providerId,
    command: `${config.command} ${config.args.join(' ')}`.trim(),
    passed: false,
    urlExtracted: null,
    urlValid: false,
    promptsHandled: 0,
    exitCode: null,
    duration: 0,
    output: '',
  };

  return new Promise((resolve) => {
    const respondedPrompts = new Set<number>();

    try {
      const proc = pty.spawn(config.command, config.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' },
      });

      const timeout = setTimeout(() => {
        proc.kill();
        result.error = 'Timeout waiting for CLI';
        result.duration = Date.now() - startTime;
        resolve(result);
      }, 15000);

      proc.onData((data: string) => {
        result.output += data;
        const cleanText = stripAnsi(data);

        // Check for prompts and respond
        for (let i = 0; i < config.prompts.length; i++) {
          if (respondedPrompts.has(i)) continue;
          if (config.prompts[i].pattern.test(cleanText)) {
            respondedPrompts.add(i);
            result.promptsHandled++;
            setTimeout(() => {
              try {
                proc.write(config.prompts[i].response);
              } catch {
                // Process may have exited
              }
            }, 100);
          }
        }

        // Check for URL
        const match = cleanText.match(config.urlPattern);
        if (match && match[1] && !result.urlExtracted) {
          result.urlExtracted = match[1];
          result.urlValid = result.urlExtracted.startsWith(config.expectedUrlPrefix);
        }
      });

      proc.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        result.exitCode = exitCode;
        result.duration = Date.now() - startTime;

        // Determine pass/fail
        result.passed = !!(
          result.urlExtracted &&
          result.urlValid &&
          exitCode === 0
        );

        resolve(result);
      });

      // Send signal to continue after prompts are done
      setTimeout(() => {
        try {
          proc.write('\n');
        } catch {
          // Ignore
        }
      }, 5000);
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Unknown error';
      result.duration = Date.now() - startTime;
      resolve(result);
    }
  });
}

async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           CLI OAuth Flow CI Tests                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const results: TestResult[] = [];

  for (const providerId of Object.keys(PROVIDERS)) {
    process.stdout.write(`Testing ${providerId}... `);
    const result = await testProvider(providerId);
    results.push(result);

    if (result.passed) {
      console.log('✅ PASSED');
    } else {
      console.log(`❌ FAILED${result.error ? `: ${result.error}` : ''}`);
    }

    // Detailed output
    console.log(`  Command: ${result.command}`);
    console.log(`  URL: ${result.urlExtracted || 'NOT FOUND'}`);
    console.log(`  Valid: ${result.urlValid ? 'Yes' : 'No'}`);
    console.log(`  Prompts: ${result.promptsHandled}/${PROVIDERS[providerId as keyof typeof PROVIDERS].prompts.length}`);
    console.log(`  Exit: ${result.exitCode}`);
    console.log(`  Duration: ${result.duration}ms`);
    console.log('');
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Summary: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Write JSON results for CI parsing
  const jsonResults = {
    timestamp: new Date().toISOString(),
    results: results.map(r => ({
      provider: r.provider,
      command: r.command,
      passed: r.passed,
      urlExtracted: r.urlExtracted,
      urlValid: r.urlValid,
      promptsHandled: r.promptsHandled,
      exitCode: r.exitCode,
      duration: r.duration,
      error: r.error,
    })),
    summary: {
      total: results.length,
      passed,
      failed,
    },
  };

  // Write to file for CI artifact
  try {
    writeFileSync('/tmp/cli-oauth-test-results.json', JSON.stringify(jsonResults, null, 2));
    console.log('\nResults written to /tmp/cli-oauth-test-results.json');
  } catch {
    // Might not have write access, output to stdout instead
    console.log('\n--- JSON Results ---');
    console.log(JSON.stringify(jsonResults, null, 2));
  }

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
