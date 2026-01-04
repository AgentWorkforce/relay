#!/usr/bin/env npx tsx
/**
 * CI Test Runner for Real CLI OAuth Flows
 *
 * Tests the actual CLI tools to verify:
 * 1. URL extraction patterns work with real CLI output
 * 2. Prompt detection works with real prompts
 * 3. Auto-responses navigate through the flow correctly
 *
 * Exit codes:
 *   0 - All available CLIs passed
 *   1 - One or more tests failed
 *
 * Note: CLIs that aren't installed are skipped, not failed.
 *
 * IMPORTANT: This test uses the same runCLIAuthViaPTY function as production
 * to ensure the PTY handling logic is consistent.
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

// Import the actual config and PTY runner from cli-pty-runner.ts
// This ensures tests use the EXACT SAME logic as production
// Note: In Docker container, both files are in /app/, so use relative import
// For local dev, this path also works from scripts/test-cli-auth/
import {
  CLI_AUTH_CONFIG,
  runCLIAuthViaPTY,
  type PTYAuthResult,
} from './cli-pty-runner.js';

interface TestResult {
  provider: string;
  command: string;
  installed: boolean;
  passed: boolean;
  skipped: boolean;
  urlExtracted: string | null;
  promptsDetected: string[];
  promptsResponded: string[];
  successDetected: boolean;
  exitCode: number | null;
  duration: number;
  rawOutput: string;
  error?: string;
}

/**
 * Check if a CLI is installed
 */
function isCliInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Test a real CLI's OAuth flow using the shared PTY runner
 *
 * Uses the EXACT SAME runCLIAuthViaPTY function as production to ensure
 * the PTY handling logic is consistent between tests and production.
 */
async function testRealCli(providerId: string): Promise<TestResult> {
  const config = CLI_AUTH_CONFIG[providerId];
  if (!config) {
    return {
      provider: providerId,
      command: 'unknown',
      installed: false,
      passed: false,
      skipped: true,
      urlExtracted: null,
      promptsDetected: [],
      promptsResponded: [],
      successDetected: false,
      exitCode: null,
      duration: 0,
      rawOutput: '',
      error: `Unknown provider: ${providerId}`,
    };
  }

  const result: TestResult = {
    provider: providerId,
    command: `${config.command} ${config.args.join(' ')}`.trim(),
    installed: isCliInstalled(config.command),
    passed: false,
    skipped: false,
    urlExtracted: null,
    promptsDetected: [],
    promptsResponded: [],
    successDetected: false,
    exitCode: null,
    duration: 0,
    rawOutput: '',
  };

  // Skip if CLI not installed
  if (!result.installed) {
    result.skipped = true;
    result.error = `CLI '${config.command}' not installed`;
    return result;
  }

  const startTime = Date.now();

  // Use the shared PTY runner - SAME code as production
  const ptyResult: PTYAuthResult = await runCLIAuthViaPTY(config, {
    onAuthUrl: (url) => {
      result.urlExtracted = url;
      console.log(`    [${providerId}] URL found: ${url.substring(0, 60)}...`);
    },
    onPromptHandled: (description) => {
      result.promptsDetected.push(description);
      result.promptsResponded.push(description);
      console.log(`    [${providerId}] Responded to: ${description}`);
    },
    onOutput: (data) => {
      result.rawOutput += data;
    },
  });

  result.duration = Date.now() - startTime;
  result.exitCode = ptyResult.exitCode;
  result.successDetected = ptyResult.success;

  // Pass if we got a URL (main goal of OAuth flow)
  result.passed = !!result.urlExtracted;

  if (!result.passed) {
    result.error = ptyResult.error || 'Failed to extract auth URL from CLI output';
  }

  return result;
}

/**
 * Run tests for all configured providers
 */
async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        CLI OAuth Flow Tests - Real CLIs                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const results: TestResult[] = [];
  const providerIds = Object.keys(CLI_AUTH_CONFIG);

  for (const providerId of providerIds) {
    const config = CLI_AUTH_CONFIG[providerId];
    console.log(`Testing ${config.displayName} (${providerId})...`);

    const result = await testRealCli(providerId);
    results.push(result);

    if (result.skipped) {
      console.log(`  ⏭️  SKIPPED: ${result.error}`);
    } else if (result.passed) {
      console.log(`  ✅ PASSED`);
    } else {
      console.log(`  ❌ FAILED: ${result.error}`);
    }

    console.log(`     Installed: ${result.installed ? 'Yes' : 'No'}`);
    if (!result.skipped) {
      console.log(`     URL: ${result.urlExtracted ? 'Extracted' : 'NOT FOUND'}`);
      console.log(`     Prompts: ${result.promptsResponded.length}/${config.prompts.length} handled`);
      console.log(`     Duration: ${result.duration}ms`);
    }
    console.log('');
  }

  // Summary
  const installed = results.filter(r => r.installed);
  const skipped = results.filter(r => r.skipped);
  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed && !r.skipped);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Summary:`);
  console.log(`  Installed: ${installed.length}/${results.length}`);
  console.log(`  Passed: ${passed.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log(`  Skipped: ${skipped.length}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Write JSON results
  const jsonResults = {
    timestamp: new Date().toISOString(),
    results: results.map(r => ({
      provider: r.provider,
      command: r.command,
      installed: r.installed,
      passed: r.passed,
      skipped: r.skipped,
      urlExtracted: r.urlExtracted ? true : false,
      urlSample: r.urlExtracted?.substring(0, 80),
      promptsDetected: r.promptsDetected,
      promptsResponded: r.promptsResponded,
      exitCode: r.exitCode,
      duration: r.duration,
      error: r.error,
    })),
    summary: {
      total: results.length,
      installed: installed.length,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
    },
  };

  try {
    writeFileSync('/tmp/cli-oauth-test-results.json', JSON.stringify(jsonResults, null, 2));
    console.log('\nResults written to /tmp/cli-oauth-test-results.json');
  } catch {
    console.log('\n--- JSON Results ---');
    console.log(JSON.stringify(jsonResults, null, 2));
  }

  // Exit with failure only if an installed CLI failed
  // Skipped CLIs don't count as failures
  if (failed.length > 0) {
    console.log('\nFailed CLIs:');
    for (const result of failed) {
      console.log(`  - ${result.provider}: ${result.error}`);
      if (result.rawOutput) {
        console.log(`    Last 500 chars of output:`);
        console.log(`    ${result.rawOutput.slice(-500).replace(/\n/g, '\n    ')}`);
      }
    }
    process.exit(1);
  }

  // Warn if no CLIs were tested
  if (installed.length === 0) {
    console.log('\n⚠️  WARNING: No CLIs were installed - no actual testing performed!');
    process.exit(0); // Don't fail, but warn
  }

  console.log('\n✅ All installed CLIs passed!');
  process.exit(0);
}

runAllTests().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
