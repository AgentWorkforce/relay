import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('trail start', () => {
  it('populates agents array with starting agent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-agent-test-'));
    const cliPath = path.resolve('node_modules/agent-trajectories/dist/cli/index.js');

    try {
      execFileSync('node', [cliPath, 'start', 'Agent test run', '--task', 'test-123'], {
        cwd: tmpDir,
        env: { ...process.env, AGENT_NAME: 'Tester' },
        stdio: 'ignore',
      });

      const activeDir = path.join(tmpDir, '.trajectories', 'active');
      const files = fs.readdirSync(activeDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBe(1);

      const trajectory = JSON.parse(fs.readFileSync(path.join(activeDir, files[0]), 'utf-8'));
      expect(trajectory.agents[0]).toMatchObject({
        name: 'Tester',
        role: 'lead',
      });
      expect(new Date(trajectory.agents[0].joinedAt).toString()).not.toBe('Invalid Date');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
