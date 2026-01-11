import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTrajectorySteps } from './integration.js';

describe('listTrajectorySteps', () => {
  const originalCwd = process.cwd();
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-traj-test-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'traj-test' }));
    fs.mkdirSync(path.join(tempDir, '.trajectories', 'active'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.trajectories', 'completed'), { recursive: true });
    process.env.XDG_CONFIG_HOME = path.join(tempDir, '.config');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdgConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('merges steps from all active trajectories and sorts by timestamp', async () => {
    const activeDir = path.join(tempDir, '.trajectories', 'active');
    const completedDir = path.join(tempDir, '.trajectories', 'completed');

    const trajAPath = path.join(activeDir, 'traj_a.json');
    const trajBPath = path.join(activeDir, 'traj_b.json');
    const trajCompletedPath = path.join(completedDir, 'traj_c.json');

    const trajA = {
      id: 'traj_a',
      version: 1,
      task: { title: 'A' },
      status: 'active',
      startedAt: '1970-01-01T00:00:00.000Z',
      agents: [],
      chapters: [
        {
          id: 'c1',
          title: 'chapter a',
          agentName: 'Agent',
          startedAt: '1970-01-01T00:00:00.000Z',
          events: [
            { ts: 1000, type: 'message', content: 'A1' },
            { ts: 4000, type: 'message', content: 'A2' },
          ],
        },
      ],
    };

    const trajB = {
      id: 'traj_b',
      version: 1,
      task: { title: 'B' },
      status: 'active',
      startedAt: '1970-01-01T00:00:00.000Z',
      agents: [],
      chapters: [
        {
          id: 'c2',
          title: 'chapter b',
          agentName: 'Agent',
          startedAt: '1970-01-01T00:00:00.000Z',
          events: [
            { ts: '1970-01-01T00:00:02.000Z', type: 'message', content: 'B1' },
            { ts: 3000, type: 'message', content: 'B2' },
          ],
        },
      ],
    };

    const trajCompleted = {
      id: 'traj_c',
      version: 1,
      task: { title: 'C' },
      status: 'completed',
      startedAt: '1970-01-01T00:00:00.000Z',
      completedAt: '1970-01-01T00:00:05.000Z',
      agents: [],
      chapters: [
        {
          id: 'c3',
          title: 'chapter c',
          agentName: 'Agent',
          startedAt: '1970-01-01T00:00:00.000Z',
          events: [{ ts: 5000, type: 'message', content: 'C1' }],
        },
      ],
    };

    fs.writeFileSync(trajAPath, JSON.stringify(trajA));
    fs.writeFileSync(trajBPath, JSON.stringify(trajB));
    fs.writeFileSync(trajCompletedPath, JSON.stringify(trajCompleted));

    const index = {
      version: 1,
      lastUpdated: '1970-01-01T00:00:10.000Z',
      trajectories: {
        traj_a: {
          title: 'A',
          status: 'active',
          startedAt: '1970-01-01T00:00:00.000Z',
          path: trajAPath,
        },
        traj_b: {
          title: 'B',
          status: 'active',
          startedAt: '1970-01-01T00:00:00.000Z',
          path: trajBPath,
        },
        traj_c: {
          title: 'C',
          status: 'completed',
          startedAt: '1970-01-01T00:00:00.000Z',
          completedAt: '1970-01-01T00:00:05.000Z',
          path: trajCompletedPath,
        },
      },
    };

    fs.writeFileSync(path.join(tempDir, '.trajectories', 'index.json'), JSON.stringify(index));

    const result = await listTrajectorySteps();
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map(step => step.description)).toEqual(['A1', 'B1', 'B2', 'A2']);
  });
});
