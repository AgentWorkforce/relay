#!/usr/bin/env node
/**
 * Comprehensive Test Runner for SDK and MCP Tests
 *
 * Runs all tests with specified CLI types (claude, codex, or both)
 *
 * Usage:
 *   node tests/run-all-tests.js [--cli=claude|codex|both] [--type=sdk|mcp|both]
 *
 * Examples:
 *   node tests/run-all-tests.js --cli=claude --type=mcp
 *   node tests/run-all-tests.js --cli=both --type=both
 *   node tests/run-all-tests.js --cli=codex
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 * - Have the specified CLI(s) installed and authenticated
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = __dirname;
const projectRoot = resolve(__dirname, '../..');

// Parse command line arguments
const args = process.argv.slice(2);
let cliTypes = ['claude']; // default
let testTypes = ['both']; // default

for (const arg of args) {
  if (arg.startsWith('--cli=')) {
    const value = arg.split('=')[1];
    if (value === 'both') {
      cliTypes = ['claude', 'codex'];
    } else if (['claude', 'codex', 'gemini'].includes(value)) {
      cliTypes = [value];
    } else {
      console.error(`Invalid CLI: ${value}. Must be one of: claude, codex, gemini, both`);
      process.exit(1);
    }
  } else if (arg.startsWith('--type=')) {
    const value = arg.split('=')[1];
    if (value === 'both') {
      testTypes = ['sdk', 'mcp'];
    } else if (['sdk', 'mcp'].includes(value)) {
      testTypes = [value];
    } else {
      console.error(`Invalid type: ${value}. Must be one of: sdk, mcp, both`);
      process.exit(1);
    }
  }
}

// Define test suites
const mcpTests = [
  { file: 'mcp/06-mcp-connect.js', name: 'MCP Connect' },
  { file: 'mcp/07-mcp-message.js', name: 'MCP Message' },
  { file: 'mcp/08-mcp-receive.js', name: 'MCP Receive' },
  { file: 'mcp/09-mcp-spawn-release.js', name: 'MCP Spawn/Release' },
  { file: 'mcp/10-mcp-multi-worker.js', name: 'MCP Multi-Worker' },
  { file: 'mcp/11-mcp-broadcast.js', name: 'MCP Broadcast' },
  { file: 'mcp/12-mcp-multi-claude.js', name: 'MCP Multi-Agent' },
  { file: 'mcp/13-mcp-negotiation.js', name: 'MCP Negotiation' },
  { file: 'mcp/14-mcp-orchestration.js', name: 'MCP Orchestration' },
  { file: 'mcp/15-mcp-send-cli.js', name: 'MCP Send CLI' },
  { file: 'mcp/16-mcp-channels.js', name: 'MCP Channels' },
  { file: 'mcp/17-mcp-await-response.js', name: 'MCP Await Response' },
  { file: 'mcp/18-mcp-consensus.js', name: 'MCP Consensus' },
  { file: 'mcp/19-mcp-pubsub.js', name: 'MCP Pub/Sub' },
  { file: 'mcp/20-mcp-shadow.js', name: 'MCP Shadow Agents' },
  { file: 'mcp/21-mcp-health-metrics.js', name: 'MCP Health & Metrics' },
  { file: 'mcp/22-mcp-threads.js', name: 'MCP Threads' },
  { file: 'mcp/23-mcp-error-handling.js', name: 'MCP Error Handling' },
  { file: 'mcp/24-mcp-continuity.js', name: 'MCP Continuity' },
  { file: 'mcp/25-mcp-socket-discovery.js', name: 'MCP Socket Discovery' },
];

const sdkTests = [
  { file: 'sdk/01-connect.js', name: 'SDK Connect' },
  { file: 'sdk/02-send-message.js', name: 'SDK Send Message' },
  { file: 'sdk/03-spawn-agent.js', name: 'SDK Spawn Agent' },
  { file: 'sdk/04-release-agent.js', name: 'SDK Release Agent' },
  { file: 'sdk/05-full-flow.js', name: 'SDK Full Flow' },
  { file: 'sdk/05a-spawn-process.js', name: 'SDK Spawn Process' },
  { file: 'sdk/05b-worker-message.js', name: 'SDK Worker Message' },
  { file: 'sdk/05b0-stability.js', name: 'SDK Stability' },
  { file: 'sdk/05b1-message-stability.js', name: 'SDK Message Stability' },
  { file: 'sdk/05b2-orch-to-worker.js', name: 'SDK Orch to Worker' },
  { file: 'sdk/06-multi-worker.js', name: 'SDK Multi-Worker' },
  { file: 'sdk/07-broadcast.js', name: 'SDK Broadcast' },
  { file: 'sdk/08-multi-claude.js', name: 'SDK Multi-Claude' },
  { file: 'sdk/09-budget-negotiation.js', name: 'SDK Budget Negotiation' },
  { file: 'sdk/10-mediated-negotiation.js', name: 'SDK Mediated Negotiation' },
  { file: 'sdk/14-orchestration-sdk.js', name: 'SDK Orchestration' },
  { file: 'sdk/15-continuity-handoff.js', name: 'SDK Continuity Handoff' },
];

// Results tracking
const results = [];

async function runTest(testFile, cli, testName) {
  const testPath = resolve(testsDir, testFile);

  return new Promise((resolve) => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Running: ${testName} (CLI: ${cli.toUpperCase()})`);
    console.log(`${'─'.repeat(60)}\n`);

    const startTime = Date.now();
    const child = spawn('node', [testPath, cli], {
      stdio: 'inherit',
      cwd: projectRoot,
    });

    child.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const status = code === 0 ? 'PASSED' : 'FAILED';

      results.push({
        test: testName,
        cli,
        status,
        duration,
        exitCode: code,
      });

      resolve(code);
    });

    child.on('error', (err) => {
      results.push({
        test: testName,
        cli,
        status: 'ERROR',
        duration: '0',
        error: err.message,
      });
      resolve(1);
    });
  });
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('=== Agent Relay Test Suite ===');
  console.log(`${'='.repeat(60)}`);
  console.log(`\nCLI Types: ${cliTypes.join(', ')}`);
  console.log(`Test Types: ${testTypes.join(', ')}`);
  console.log(`\nStarting at: ${new Date().toISOString()}\n`);

  const testsToRun = [];

  // Build test queue
  for (const cli of cliTypes) {
    if (testTypes.includes('sdk') || testTypes.includes('both')) {
      for (const test of sdkTests) {
        testsToRun.push({ ...test, cli });
      }
    }
    if (testTypes.includes('mcp') || testTypes.includes('both')) {
      for (const test of mcpTests) {
        testsToRun.push({ ...test, cli });
      }
    }
  }

  console.log(`Total tests to run: ${testsToRun.length}\n`);

  // Run tests sequentially
  for (const { file, name, cli } of testsToRun) {
    await runTest(file, cli, name);
    // Brief pause between tests
    await new Promise(r => setTimeout(r, 2000));
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('=== TEST RESULTS SUMMARY ===');
  console.log(`${'='.repeat(60)}\n`);

  const passed = results.filter(r => r.status === 'PASSED');
  const failed = results.filter(r => r.status === 'FAILED');
  const errors = results.filter(r => r.status === 'ERROR');

  // Group by CLI
  for (const cli of cliTypes) {
    console.log(`\n--- ${cli.toUpperCase()} ---`);
    const cliResults = results.filter(r => r.cli === cli);

    for (const result of cliResults) {
      const icon = result.status === 'PASSED' ? '✓' : result.status === 'FAILED' ? '✗' : '!';
      console.log(`  ${icon} ${result.test}: ${result.status} (${result.duration}s)`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length} | Errors: ${errors.length}`);
  console.log(`${'─'.repeat(60)}\n`);

  // Exit with appropriate code
  const exitCode = failed.length > 0 || errors.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
