import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compileAgentScopes, globToScopes } from '../compiler.js';

async function createWorkspace(
  files: Record<string, string>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-provisioner-compiler-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('compileAgentScopes applies explicit file permissions', async () => {
  const workspace = await createWorkspace({
    'docs/guide.md': '# guide\n',
    'src/index.ts': 'export const value = 1;\n',
    'secrets.env': 'TOP_SECRET=1\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'builder',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'restricted',
        inherit: false,
        files: {
          read: ['docs/**'],
          write: ['src/**'],
          deny: ['secrets.env'],
        },
      },
    });

    assert.deepEqual(compiled.readonlyPaths, ['docs/guide.md']);
    assert.deepEqual(compiled.readwritePaths, ['src/index.ts']);
    assert.deepEqual(compiled.deniedPaths, ['secrets.env']);
    assert.deepEqual(compiled.scopes, [
      'relayfile:fs:read:/docs/guide.md',
      'relayfile:fs:read:/src/index.ts',
      'relayfile:fs:write:/src/index.ts',
    ]);
    assert.deepEqual(compiled.sources, [
      {
        type: 'yaml',
        label: 'permissions.files',
        ruleCount: 3,
      },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes honors the readonly preset', async () => {
  const workspace = await createWorkspace({
    'docs/guide.md': '# guide\n',
    'src/index.ts': 'export const value = 1;\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'reader',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'readonly',
      },
    });

    assert.equal(compiled.effectiveAccess, 'readonly');
    assert.deepEqual(compiled.readonlyPaths, ['docs/guide.md', 'src/index.ts']);
    assert.deepEqual(compiled.readwritePaths, []);
    assert.deepEqual(compiled.deniedPaths, []);
    assert.deepEqual(compiled.readonlyPatterns, ['**']);
    assert.deepEqual(compiled.readwritePatterns, []);
    assert.deepEqual(compiled.scopes, [
      'relayfile:fs:read:/docs/guide.md',
      'relayfile:fs:read:/src/index.ts',
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes honors the readwrite preset', async () => {
  const workspace = await createWorkspace({
    'docs/guide.md': '# guide\n',
    'src/index.ts': 'export const value = 1;\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'writer',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'readwrite',
      },
    });

    assert.equal(compiled.effectiveAccess, 'readwrite');
    assert.deepEqual(compiled.readonlyPaths, []);
    assert.deepEqual(compiled.readwritePaths, ['docs/guide.md', 'src/index.ts']);
    assert.deepEqual(compiled.deniedPaths, []);
    assert.deepEqual(compiled.readwritePatterns, ['**']);
    assert.deepEqual(compiled.scopes, [
      'relayfile:fs:read:/docs/guide.md',
      'relayfile:fs:read:/src/index.ts',
      'relayfile:fs:write:/docs/guide.md',
      'relayfile:fs:write:/src/index.ts',
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes applies deny patterns last', async () => {
  const workspace = await createWorkspace({
    'docs/private.md': '# private\n',
    'docs/public.md': '# public\n',
    'secrets.env': 'TOP_SECRET=1\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'writer',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'full',
        files: {
          deny: ['docs/private.md', 'secrets.env'],
        },
      },
    });

    assert.equal(compiled.inherited, false);
    assert.deepEqual(compiled.readonlyPaths, []);
    assert.deepEqual(compiled.readwritePaths, ['docs/public.md']);
    assert.deepEqual(compiled.deniedPaths, ['docs/private.md', 'secrets.env']);
    assert.deepEqual(compiled.deniedPatterns, ['docs/private.md', 'secrets.env']);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes ignores dotfiles when inherit is false', async () => {
  const workspace = await createWorkspace({
    '.agentignore': 'blocked.txt\n',
    '.agentreadonly': 'locked.txt\n',
    'blocked.txt': 'blocked\n',
    'locked.txt': 'locked\n',
    'open.txt': 'open\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'writer',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'readwrite',
        inherit: false,
      },
    });

    assert.equal(compiled.inherited, false);
    assert.deepEqual(compiled.sources, [
      {
        type: 'preset',
        label: 'access: readwrite',
        ruleCount: 2,
      },
    ]);
    assert.deepEqual(compiled.readonlyPaths, []);
    assert.deepEqual(compiled.readwritePaths, [
      '.agentignore',
      '.agentreadonly',
      'blocked.txt',
      'locked.txt',
      'open.txt',
    ]);
    assert.deepEqual(compiled.deniedPaths, []);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes loads dotfiles when inherit is true', async () => {
  const workspace = await createWorkspace({
    '.agentignore': 'blocked.txt\n',
    '.agentreadonly': 'locked.txt\n',
    'blocked.txt': 'blocked\n',
    'locked.txt': 'locked\n',
    'open.txt': 'open\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'writer',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'readwrite',
      },
    });

    assert.equal(compiled.inherited, true);
    assert.deepEqual(compiled.sources, [
      {
        type: 'dotfile',
        label: 'dotfiles',
        ruleCount: 2,
      },
      {
        type: 'preset',
        label: 'access: readwrite',
        ruleCount: 2,
      },
    ]);
    assert.deepEqual(compiled.readonlyPaths, ['locked.txt']);
    assert.deepEqual(compiled.readwritePaths, ['.agentignore', '.agentreadonly', 'open.txt']);
    assert.deepEqual(compiled.deniedPaths, ['blocked.txt']);
    assert.deepEqual(compiled.readonlyPatterns, ['locked.txt']);
    assert.deepEqual(compiled.deniedPatterns, ['blocked.txt']);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes appends raw scopes', async () => {
  const workspace = await createWorkspace({
    'src/index.ts': 'export const value = 1;\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'scoped',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'restricted',
        inherit: false,
        scopes: ['relay:custom:deploy', 'relay:custom:audit', 'relay:custom:deploy'],
      },
    });

    assert.deepEqual(compiled.readonlyPaths, []);
    assert.deepEqual(compiled.readwritePaths, []);
    assert.deepEqual(compiled.deniedPaths, ['src/index.ts']);
    assert.deepEqual(compiled.scopes, ['relay:custom:deploy', 'relay:custom:audit']);
    assert.deepEqual(compiled.summary, {
      readonly: 0,
      readwrite: 0,
      denied: 1,
      customScopes: 2,
    });
    assert.deepEqual(compiled.sources, [
      {
        type: 'scope',
        label: 'permissions.scopes',
        ruleCount: 2,
      },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes lets YAML rules override dotfiles', async () => {
  const workspace = await createWorkspace({
    '.agentignore': 'blocked.txt\n',
    '.agentreadonly': 'locked.txt\n',
    'blocked.txt': 'blocked\n',
    'locked.txt': 'locked\n',
    'plain.txt': 'plain\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'override-agent',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {
        access: 'restricted',
        files: {
          read: ['blocked.txt'],
          write: ['locked.txt'],
        },
      },
    });

    assert.deepEqual(compiled.readonlyPaths, ['blocked.txt']);
    assert.deepEqual(compiled.readwritePaths, ['locked.txt']);
    assert.deepEqual(compiled.deniedPaths, ['.agentignore', '.agentreadonly', 'plain.txt']);
    assert.deepEqual(compiled.scopes, [
      'relayfile:fs:read:/blocked.txt',
      'relayfile:fs:read:/locked.txt',
      'relayfile:fs:write:/locked.txt',
    ]);
    assert.deepEqual(compiled.sources, [
      {
        type: 'dotfile',
        label: 'dotfiles',
        ruleCount: 2,
      },
      {
        type: 'yaml',
        label: 'permissions.files',
        ruleCount: 2,
      },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('compileAgentScopes defaults empty permissions to inherited readwrite access', async () => {
  const workspace = await createWorkspace({
    'docs/guide.md': '# guide\n',
    'src/index.ts': 'export const value = 1;\n',
  });

  try {
    const compiled = compileAgentScopes({
      agentName: 'defaulted',
      workspace: 'relay-test',
      projectDir: workspace.dir,
      permissions: {},
    });

    assert.equal(compiled.effectiveAccess, 'readwrite');
    assert.equal(compiled.inherited, true);
    assert.deepEqual(compiled.readonlyPaths, []);
    assert.deepEqual(compiled.readwritePaths, ['docs/guide.md', 'src/index.ts']);
    assert.deepEqual(compiled.deniedPaths, []);
    assert.deepEqual(compiled.sources, [
      {
        type: 'preset',
        label: 'access: readwrite',
        ruleCount: 2,
      },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('globToScopes normalizes and de-duplicates globs', () => {
  assert.deepEqual(globToScopes(['src\\index.ts', './docs/**', '/docs/**', '', ' src/index.ts '], 'write'), [
    'relayfile:fs:write:/src/index.ts',
    'relayfile:fs:write:/docs/**',
  ]);
});
