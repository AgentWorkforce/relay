import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const execAsync = promisify(exec);

// Path to the compiled CLI
const CLI_PATH = path.resolve(__dirname, '../../dist/src/cli/index.js');
const CLI_EXISTS = fs.existsSync(CLI_PATH);
const describeCli = CLI_EXISTS ? describe : describe.skip;

// Use a temp directory to isolate tests from any running broker
let testProjectRoot: string;

beforeAll(() => {
  testProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-test-'));
});

afterAll(() => {
  fs.rmSync(testProjectRoot, { recursive: true, force: true });
});

// Helper to run CLI commands
async function runCli(args: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(`node ${CLI_PATH} ${args}`, {
      cwd: testProjectRoot, // Run in isolated temp directory
      timeout: 12000,
      env: {
        ...process.env,
        DOTENV_CONFIG_QUIET: 'true',
        AGENT_RELAY_SKIP_UPDATE_CHECK: '1', // Skip update check in tests
        AGENT_RELAY_REQUEST_TIMEOUT_MS: '5000', // Keep broker RPC failures bounded in CI
        RELAY_API_KEY: '', // Keep CLI tests offline and avoid network-dependent delays
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.code || 1,
    };
  }
}

describeCli('CLI', () => {
  describe('version', () => {
    it('should show version', async () => {
      const { stdout } = await runCli('version');
      expect(stdout).toMatch(/agent-relay v\d+\.\d+\.\d+/);
    });

    it('should show version with -V flag', async () => {
      const { stdout } = await runCli('-V');
      expect(stdout).toMatch(/\d+\.\d+\.\d+/);
    });
  });

  describe('help', () => {
    it('should show help with --help', async () => {
      const { stdout } = await runCli('--help');
      expect(stdout).toContain('agent-relay');
      expect(stdout).toContain('up');
      expect(stdout).toContain('down');
      expect(stdout).toContain('status');
      expect(stdout).toContain('agents');
      expect(stdout).toContain('who');
    });

    it('should show help when no args', async () => {
      const { stdout, stderr } = await runCli('');
      // Commander outputs help to stderr when no command is provided
      const output = stdout + stderr;
      expect(output).toContain('Usage:');
    });
  });

  describe('agents', () => {
    it('supports --json output (smoke)', async () => {
      const { stdout, stderr } = await runCli('agents --json');
      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const hasJsonPayload = lines.some((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });

      if (!hasJsonPayload) {
        expect(`${stdout}${stderr}`).toMatch(/(broker|relaycast|Failed|not running)/i);
      }
    }, 15000);
  });
});
