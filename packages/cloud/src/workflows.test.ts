import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';

const s3SendMock = vi.hoisted(() => vi.fn());
const ensureAuthenticatedMock = vi.hoisted(() => vi.fn());
const authorizedApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class S3Client {
    send(command: unknown) {
      return s3SendMock(command);
    }
  }
  return { PutObjectCommand, S3Client };
});

vi.mock('./auth.js', () => ({
  ensureAuthenticated: (...args: unknown[]) => ensureAuthenticatedMock(...args),
  authorizedApiFetch: (...args: unknown[]) => authorizedApiFetchMock(...args),
}));

import { parseGitHubRemote, parseWorkflowPaths, relativizeWorkflowPath, runWorkflow } from './workflows.js';

describe('relativizeWorkflowPath', () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // On macOS os.tmpdir() is a symlink (e.g. /var → /private/var), so
    // after chdir() process.cwd() returns the realpath. Resolve both up
    // front so assertions that build absolute paths relative to the
    // temp dir compare apples to apples.
    tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relativize-workflow-')));
    process.chdir(tmpRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns a forward-slash relative path for a sibling of cwd', () => {
    const result = relativizeWorkflowPath('workflows/foo.ts');
    expect(result).toBe('workflows/foo.ts');
  });

  it('strips a leading ./', () => {
    const result = relativizeWorkflowPath('./workflows/foo.ts');
    expect(result).toBe('workflows/foo.ts');
  });

  it('relativizes an absolute path that lives inside cwd', () => {
    const abs = path.join(tmpRoot, 'nested', 'workflow.ts');
    const result = relativizeWorkflowPath(abs);
    expect(result).toBe('nested/workflow.ts');
  });

  it('returns null for an absolute path outside cwd', async () => {
    // realpath() so the comparison is symlink-stable on macOS (same
    // reason we realpath() tmpRoot above).
    const outsideDir = await realpath(os.tmpdir());
    const outside = path.resolve(outsideDir, 'not-in-cwd', 'workflow.ts');
    const result = relativizeWorkflowPath(outside);
    expect(result).toBeNull();
  });

  it('returns null for a path that escapes cwd via ..', () => {
    const result = relativizeWorkflowPath('../escaped.ts');
    expect(result).toBeNull();
  });

  it('returns null when the arg resolves to cwd itself', () => {
    const result = relativizeWorkflowPath('.');
    expect(result).toBeNull();
  });
});

describe('parseWorkflowPaths', () => {
  it('extracts paths from YAML workflow source', () => {
    const paths = parseWorkflowPaths(
      [
        'version: "1.0"',
        'name: multi',
        'paths:',
        '  - name: cloud',
        '    path: .',
        '  - name: relay',
        '    path: ../relay',
        'swarm:',
        '  pattern: dag',
        'agents: []',
        'workflows: []',
      ].join('\n'),
      'yaml'
    );

    expect(paths).toEqual([
      { name: 'cloud', path: '.' },
      { name: 'relay', path: '../relay' },
    ]);
  });

  it('extracts paths from TS workflow source', () => {
    const paths = parseWorkflowPaths(
      `
      export const config = {
        version: '1.0',
        paths: [
          { name: 'cloud', path: '.' },
          { name: "relay", path: "../relay" },
        ],
        swarm: { pattern: 'dag' },
      };
      `,
      'ts'
    );

    expect(paths).toEqual([
      { name: 'cloud', path: '.' },
      { name: 'relay', path: '../relay' },
    ]);
  });

  it('extracts paths from fluent TS workflow source', () => {
    const paths = parseWorkflowPaths(
      `
      workflow('probe')
        .paths([
          { name: 'cloud', path: '.' },
          { name: 'relay', path: '../relay' },
        ])
        .run();
      `,
      'ts'
    );

    expect(paths).toEqual([
      { name: 'cloud', path: '.' },
      { name: 'relay', path: '../relay' },
    ]);
  });
});

describe('parseGitHubRemote', () => {
  it('parses scp-style GitHub remotes', () => {
    expect(parseGitHubRemote('git@github.com:Owner/Name.git')).toEqual({
      repoOwner: 'Owner',
      repoName: 'Name',
    });
  });

  it('parses HTTPS GitHub remotes', () => {
    expect(parseGitHubRemote('https://github.com/Owner/Name')).toEqual({
      repoOwner: 'Owner',
      repoName: 'Name',
    });
    expect(parseGitHubRemote('https://github.com/Owner/Name.git')).toEqual({
      repoOwner: 'Owner',
      repoName: 'Name',
    });
  });

  it('parses ssh:// GitHub remotes', () => {
    expect(parseGitHubRemote('ssh://git@github.com/Owner/Name.git')).toEqual({
      repoOwner: 'Owner',
      repoName: 'Name',
    });
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubRemote('https://gitlab.com/Owner/Name.git')).toBeNull();
    expect(parseGitHubRemote('not-a-url')).toBeNull();
  });
});

describe('runWorkflow code sync', () => {
  let tmpRoot: string;
  let originalCwd: string;
  const s3Credentials = {
    accessKeyId: 'access',
    secretAccessKey: 'secret',
    sessionToken: 'session',
    bucket: 'bucket',
    prefix: 'user/run',
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloud-run-workflow-')));
    process.chdir(tmpRoot);
    ensureAuthenticatedMock.mockResolvedValue({ accessToken: 'token' });
    s3SendMock.mockResolvedValue({});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function mockPrepareAndRun(runBodies: unknown[]) {
    authorizedApiFetchMock.mockImplementation(async (_auth, requestPath, init) => {
      if (requestPath === '/api/v1/workflows/prepare') {
        return {
          auth: { accessToken: 'token' },
          response: new Response(
            JSON.stringify({
              runId: 'run-1',
              s3Credentials,
              s3CodeKey: 'code.tar.gz',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
        };
      }
      if (requestPath === '/api/v1/workflows/run') {
        runBodies.push(JSON.parse(String(init?.body)));
        return {
          auth: { accessToken: 'token' },
          response: new Response(JSON.stringify({ runId: 'run-1', status: 'pending' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        };
      }
      throw new Error(`unexpected request: ${requestPath}`);
    });
  }

  it('uploads one tarball per declared path and sends paths[]', async () => {
    await mkdir('cloud', { recursive: true });
    await mkdir('relay', { recursive: true });
    await writeFile('cloud/README.md', 'cloud\n');
    await writeFile('relay/README.md', 'relay\n');
    execFileSync('git', ['init', '-q'], { cwd: path.join(tmpRoot, 'cloud') });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:AgentWorkforce/cloud.git'], {
      cwd: path.join(tmpRoot, 'cloud'),
    });
    execFileSync('git', ['add', 'README.md'], { cwd: path.join(tmpRoot, 'cloud') });

    const workflowPath = path.join(tmpRoot, 'workflow.yaml');
    await writeFile(
      workflowPath,
      [
        'version: "1.0"',
        'name: multi',
        'paths:',
        '  - name: cloud',
        '    path: cloud',
        '  - name: relay',
        '    path: relay',
        'swarm:',
        '  pattern: dag',
        'agents: []',
        'workflows: []',
      ].join('\n')
    );
    const runBodies: unknown[] = [];
    mockPrepareAndRun(runBodies);

    await runWorkflow(workflowPath);

    expect(s3SendMock).toHaveBeenCalledTimes(2);
    const keys = s3SendMock.mock.calls.map(([command]) => command.input.Key);
    expect(keys).toEqual(['user/run/code-cloud.tar.gz', 'user/run/code-relay.tar.gz']);
    expect(runBodies[0]).toMatchObject({
      runId: 'run-1',
      paths: [
        {
          name: 'cloud',
          s3CodeKey: 'code-cloud.tar.gz',
          repoOwner: 'AgentWorkforce',
          repoName: 'cloud',
        },
        {
          name: 'relay',
          s3CodeKey: 'code-relay.tar.gz',
        },
      ],
    });
    expect((runBodies[0] as { s3CodeKey?: unknown }).s3CodeKey).toBeUndefined();
  });

  it('falls back to the legacy single tarball when no paths are declared', async () => {
    await writeFile('README.md', 'legacy\n');
    const workflowPath = path.join(tmpRoot, 'workflow.yaml');
    await writeFile(
      workflowPath,
      ['version: "1.0"', 'name: legacy', 'swarm:', '  pattern: dag', 'agents: []', 'workflows: []'].join('\n')
    );
    const runBodies: unknown[] = [];
    mockPrepareAndRun(runBodies);

    await runWorkflow(workflowPath);

    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(s3SendMock.mock.calls[0][0].input.Key).toBe('user/run/code.tar.gz');
    expect(runBodies[0]).toMatchObject({
      runId: 'run-1',
      s3CodeKey: 'code.tar.gz',
    });
    expect((runBodies[0] as { paths?: unknown }).paths).toBeUndefined();
  });
});
