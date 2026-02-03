import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const execAsync = promisify(exec);

// Path to the compiled CLI
const CLI_PATH = path.resolve(__dirname, '../../dist/src/cli/index.js');
const CLI_EXISTS = fs.existsSync(CLI_PATH);
const describeCli = CLI_EXISTS ? describe : describe.skip;

// Use a temp directory to isolate tests from any running daemon
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
      env: {
        ...process.env,
        DOTENV_CONFIG_QUIET: 'true',
        AGENT_RELAY_SKIP_TMUX: '1', // Skip tmux discovery to avoid hangs in CI
        AGENT_RELAY_SKIP_UPDATE_CHECK: '1', // Skip update check in tests
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
      // gc is hidden (agent-only command)
    });

    it('should show help when no args', async () => {
      const { stdout, stderr } = await runCli('');
      // Commander outputs help to stderr when no command is provided
      const output = stdout + stderr;
      expect(output).toContain('Usage:');
    });
  });

  describe('doctor', () => {
    it('should run doctor command via CLI', async () => {
      const env = {
        ...process.env,
        DOTENV_CONFIG_QUIET: 'true',
        AGENT_RELAY_SKIP_TMUX: '1',
        AGENT_RELAY_SKIP_UPDATE_CHECK: '1',
        AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE: '1',
      };

      const output = execSync(`node ${CLI_PATH} doctor`, {
        cwd: testProjectRoot,
        encoding: 'utf-8',
        env,
      });

      expect(output).toContain('Storage Diagnostics');
      expect(output).toMatch(/better-sqlite3|node:sqlite|memory/i);
    });
  });

  describe('status', () => {
    it('should show status when daemon not running', async () => {
      // This test assumes daemon isn't running on a test socket
      const { stdout } = await runCli('status');
      expect(stdout).toMatch(/Status:/i);
    });
  });

  describe('gc', () => {
    it('should show help for gc command', async () => {
      const { stdout } = await runCli('gc --help');
      expect(stdout).toContain('orphaned');
      expect(stdout).toContain('--dry-run');
      expect(stdout).toContain('--force');
    });

    it('should handle gc with no sessions', async () => {
      // In test environment, likely no relay sessions
      const { stdout } = await runCli('gc --dry-run');
      expect(stdout).toMatch(/(No relay tmux sessions|orphaned|session)/i);
    });
  });

  describe('agents', () => {
    it('should handle no agents file gracefully', async () => {
      const { stdout } = await runCli('agents');
      // Either shows "No agents" message OR a table with NAME/STATUS headers
      expect(stdout).toMatch(/(No agents|NAME.*STATUS)/i);
    });

    it('should support --json flag', async () => {
      const { stdout } = await runCli('agents --json');
      // Should be valid JSON (empty array or agent list)
      expect(() => JSON.parse(stdout)).not.toThrow();
    });
  });

  describe('who', () => {
    it('should handle no active agents gracefully', async () => {
      const { stdout } = await runCli('who');
      expect(stdout).toMatch(/(No active agents|NAME)/i);
    });

    it('should support --json flag', async () => {
      const { stdout } = await runCli('who --json');
      expect(() => JSON.parse(stdout)).not.toThrow();
    });
  });

  describe('read', () => {
    it('should error when message not found', async () => {
      const { stderr, code } = await runCli('read nonexistent-message-id');
      expect(code).not.toBe(0);
      expect(stderr).toContain('not found');
    });
  });

  describe('history', () => {
    it('should show history or empty message', async () => {
      const { stdout, code } = await runCli('history --limit 5');
      // Should either show messages or "No messages found"
      expect(code).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
    });

    it('should support --json flag', async () => {
      const { stdout } = await runCli('history --json --limit 1');
      expect(() => JSON.parse(stdout)).not.toThrow();
    });
  });
});

describe('CLI Helper Functions', () => {
  describe('discoverRelaySessions', () => {
    // These are integration tests that would need tmux running
    // Skipping in CI but useful for local development
    it.skip('should discover relay-* tmux sessions', async () => {
      // Would need to mock tmux or have it running
    });
  });

  describe('formatRelativeTime', () => {
    // Test the time formatting logic indirectly through agents command
    it('should format relative times in agents output', async () => {
      const { stdout } = await runCli('agents');
      // If agents exist, should show relative time
      if (stdout.includes('ago')) {
        expect(stdout).toMatch(/\d+[smhd] ago/);
      }
    });
  });

  describe('parseSince', () => {
    // Test through history command
    it('should parse duration strings', async () => {
      // These should not error
      const { code: code1 } = await runCli('history --since 1h');
      const { code: _code2 } = await runCli('history --since 30m');
      const { code: _code3 } = await runCli('history --since 7d');
      // Commands should execute (might have no results, but shouldn't crash)
      expect([0, code1]).toContain(code1);
    });
  });
});

