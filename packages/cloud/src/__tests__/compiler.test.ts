import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

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

test.skipIf(process.platform === 'win32')(
  'symlinks use target rules and remain in exactly one permission partition',
  async () => {
    const workspace = await createWorkspace({
      'docs/guide.md': '# guide',
      'private/key.txt': 'inside secret',
      'source/code.ts': 'source',
    });
    const outside = await createWorkspace({ 'outside.txt': 'external secret' });
    try {
      await mkdir(path.join(workspace.dir, 'links'), { recursive: true });
      await symlink(path.join(outside.dir, 'outside.txt'), path.join(workspace.dir, 'docs', 'external.md'));
      await symlink(
        path.join(outside.dir, 'outside.txt'),
        path.join(workspace.dir, 'links', 'external-write.md')
      );
      await symlink(
        path.join(workspace.dir, 'private', 'key.txt'),
        path.join(workspace.dir, 'docs', 'inside.md')
      );
      await symlink(
        path.join(workspace.dir, 'source', 'code.ts'),
        path.join(workspace.dir, 'links', 'code.ts')
      );
      await symlink(
        path.join(workspace.dir, 'private'),
        path.join(workspace.dir, 'docs', 'private-dir'),
        'dir'
      );
      await symlink(path.join(workspace.dir, 'gone'), path.join(workspace.dir, 'docs', 'dangling.md'));
      await symlink(outside.dir, path.join(workspace.dir, 'links', 'external-dir'), 'dir');

      const compiled = compileAgentScopes({
        agentName: 'builder',
        workspace: 'relay-test',
        projectDir: workspace.dir,
        permissions: {
          access: 'restricted',
          inherit: false,
          files: { read: ['docs/**', 'source/**'], write: ['links/**'], deny: ['private/**'] },
        },
      });
      assert.deepEqual(compiled.readonlyPaths, ['docs/guide.md', 'links/code.ts', 'source/code.ts']);
      assert.deepEqual(compiled.readwritePaths, []);
      assert.deepEqual(compiled.deniedPaths, [
        'docs/dangling.md',
        'docs/external.md',
        'docs/inside.md',
        'docs/private-dir',
        'links/external-dir',
        'links/external-write.md',
        'private/key.txt',
      ]);
      assert.deepEqual(compiled.acl['/docs'], ['read']);
      assert.deepEqual(compiled.acl['/private'], ['deny:agent:builder']);
      assert.equal(compiled.scopes.includes('relayfile:fs:read:/docs/external.md'), false);
      const classified = [...compiled.readonlyPaths, ...compiled.readwritePaths, ...compiled.deniedPaths];
      assert.equal(classified.length, 10);
      assert.equal(new Set(classified).size, classified.length);
    } finally {
      await workspace.cleanup();
      await outside.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'a deny on the symlink path is preserved when its target is readable',
  async () => {
    const workspace = await createWorkspace({ 'docs/public.md': 'public' });
    try {
      await mkdir(path.join(workspace.dir, 'private'));
      await symlink('../docs/public.md', path.join(workspace.dir, 'private', 'shortcut.md'));
      const compiled = compileAgentScopes({
        agentName: 'builder',
        workspace: 'relay-test',
        projectDir: workspace.dir,
        permissions: {
          access: 'restricted',
          inherit: false,
          files: { read: ['docs/**'], deny: ['private/**'] },
        },
      });
      assert.deepEqual(compiled.readonlyPaths, ['docs/public.md']);
      assert.deepEqual(compiled.readwritePaths, []);
      assert.deepEqual(compiled.deniedPaths, ['private/shortcut.md']);
      assert.deepEqual(compiled.scopes, ['relayfile:fs:read:/docs/public.md']);
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'a readonly dotfile rule on the symlink path is preserved when its target is writable',
  async () => {
    const workspace = await createWorkspace({
      '.agentreadonly': 'links/**\n',
      'source/code.ts': 'source',
    });
    try {
      await mkdir(path.join(workspace.dir, 'links'));
      await symlink('../source/code.ts', path.join(workspace.dir, 'links', 'code.ts'));
      const compiled = compileAgentScopes({
        agentName: 'builder',
        workspace: 'relay-test',
        projectDir: workspace.dir,
        permissions: { access: 'readwrite' },
      });
      assert.equal(compiled.readwritePaths.includes('source/code.ts'), true);
      assert.equal(compiled.readonlyPaths.includes('links/code.ts'), true);
      assert.equal(compiled.readwritePaths.includes('links/code.ts'), false);
      assert.equal(compiled.scopes.includes('relayfile:fs:read:/links/code.ts'), true);
      assert.equal(compiled.scopes.includes('relayfile:fs:write:/links/code.ts'), false);
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'YAML overrides of dotfile restrictions apply independently to link and target paths',
  async () => {
    const workspace = await createWorkspace({
      '.agentignore': 'blocked/**\n',
      '.agentreadonly': 'links/**\n',
      'source/code.ts': 'source',
    });
    try {
      await mkdir(path.join(workspace.dir, 'blocked'));
      await mkdir(path.join(workspace.dir, 'links'));
      await symlink('../source/code.ts', path.join(workspace.dir, 'blocked', 'code.ts'));
      await symlink('../source/code.ts', path.join(workspace.dir, 'links', 'code.ts'));
      const compile = (write: string[]) =>
        compileAgentScopes({
          agentName: 'builder',
          workspace: 'relay-test',
          projectDir: workspace.dir,
          permissions: { access: 'readwrite', files: { write } },
        });
      const targetGrant = compile(['source/**']);
      assert.equal(targetGrant.deniedPaths.includes('blocked/code.ts'), true);
      assert.equal(targetGrant.readonlyPaths.includes('links/code.ts'), true);
      const linkGrant = compile(['links/**']);
      assert.equal(linkGrant.readwritePaths.includes('links/code.ts'), true);
      const bothGrants = compile(['source/**', 'blocked/**', 'links/**']);
      assert.equal(bothGrants.readwritePaths.includes('blocked/code.ts'), true);
      assert.equal(bothGrants.readwritePaths.includes('links/code.ts'), true);
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'directory symlinks preserve directory-only denies on both paths',
  async () => {
    const workspace = await createWorkspace({ 'private/key.txt': 'secret', 'public/a.txt': 'public' });
    try {
      await symlink('private', path.join(workspace.dir, 'target-link'), 'dir');
      await symlink('public', path.join(workspace.dir, 'blocked-link'), 'dir');
      for (const rules of [{ files: { deny: ['private/', 'blocked-link/'] } }, {}]) {
        if (!('files' in rules)) {
          await writeFile(path.join(workspace.dir, '.agentignore'), 'private/\nblocked-link/\n');
        }
        const compiled = compileAgentScopes({
          agentName: 'builder',
          workspace: 'relay-test',
          projectDir: workspace.dir,
          permissions: { access: 'readwrite', ...rules },
        });
        assert.equal(compiled.deniedPaths.includes('target-link'), true);
        assert.equal(compiled.deniedPaths.includes('blocked-link'), true);
        assert.equal(compiled.readwritePaths.includes('public/a.txt'), true);
      }
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'symlinks cannot grant access to directories excluded by the project walk',
  async () => {
    const workspace = await createWorkspace({
      '.git/config': 'git config',
      '.relay/state.json': 'relay state',
      'node_modules/pkg/index.js': 'dependency',
      'nested/node_modules/pkg/index.js': 'nested dependency',
      'public.txt': 'public',
    });
    try {
      const targets = [
        '.git/config',
        '.relay/state.json',
        'node_modules/pkg/index.js',
        'nested/node_modules/pkg/index.js',
        '.git',
        '.relay',
        'node_modules',
      ];
      for (const [index, target] of targets.entries()) {
        await symlink(target, path.join(workspace.dir, `link-${index}`), index >= 4 ? 'dir' : 'file');
      }
      for (const access of ['readwrite', 'full'] as const) {
        const compiled = compileAgentScopes({
          agentName: 'builder',
          workspace: 'relay-test',
          projectDir: workspace.dir,
          permissions: { access },
        });
        assert.deepEqual(
          compiled.deniedPaths,
          targets.map((_, index) => `link-${index}`)
        );
        assert.deepEqual(compiled.readwritePaths, ['public.txt']);
        assert.deepEqual(compiled.readonlyPaths, []);
        assert.equal(
          compiled.scopes.some((scope) => scope.includes('/link-')),
          false
        );
      }
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'target YAML grants override target dotfile restrictions independently of link grants',
  async () => {
    const workspace = await createWorkspace({
      '.agentignore': 'blocked/**\n',
      '.agentreadonly': 'readonly/**\n',
      'blocked/a.txt': 'a',
      'readonly/b.txt': 'b',
    });
    try {
      await symlink('blocked/a.txt', path.join(workspace.dir, 'denied-link'));
      await symlink('readonly/b.txt', path.join(workspace.dir, 'readonly-link'));
      const compile = (write: string[]) =>
        compileAgentScopes({
          agentName: 'builder',
          workspace: 'relay-test',
          projectDir: workspace.dir,
          permissions: { access: 'readwrite', files: { write } },
        });
      const linksOnly = compile(['denied-link', 'readonly-link']);
      assert.equal(linksOnly.deniedPaths.includes('denied-link'), true);
      assert.equal(linksOnly.readonlyPaths.includes('readonly-link'), true);
      const targetsOnly = compile(['blocked/**', 'readonly/**']);
      assert.equal(targetsOnly.readwritePaths.includes('denied-link'), true);
      assert.equal(targetsOnly.readwritePaths.includes('readonly-link'), true);
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'an exact write grant cannot grant a dangling link or ENOTDIR target',
  async () => {
    const workspace = await createWorkspace({ 'file.txt': 'file' });
    try {
      await symlink('missing', path.join(workspace.dir, 'dangling'));
      await symlink('file.txt/child', path.join(workspace.dir, 'invalid'));
      const compiled = compileAgentScopes({
        agentName: 'builder',
        workspace: 'relay-test',
        projectDir: workspace.dir,
        permissions: { access: 'restricted', inherit: false, files: { write: ['dangling', 'invalid'] } },
      });
      assert.deepEqual(compiled.scopes, []);
      assert.deepEqual(compiled.readwritePaths, []);
      assert.equal(compiled.deniedPaths.includes('dangling'), true);
      assert.equal(compiled.deniedPaths.includes('invalid'), true);
    } finally {
      await workspace.cleanup();
    }
  }
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'an unreadable symlink target is denied without dropping normal grants',
  async () => {
    const workspace = await createWorkspace({ 'a.txt': 'a', 'b.txt': 'b' });
    const outside = await createWorkspace({ 'locked/secret.txt': 'secret' });
    const locked = path.join(outside.dir, 'locked');
    try {
      await symlink(path.join(locked, 'secret.txt'), path.join(workspace.dir, 'locked-link'));
      await chmod(locked, 0o000);
      const compiled = compileAgentScopes({
        agentName: 'builder',
        workspace: 'relay-test',
        projectDir: workspace.dir,
        permissions: { access: 'readwrite' },
      });
      assert.deepEqual(compiled.deniedPaths, ['locked-link']);
      assert.deepEqual(compiled.readwritePaths, ['a.txt', 'b.txt']);
      assert.deepEqual(compiled.scopes, [
        'relayfile:fs:read:/a.txt',
        'relayfile:fs:read:/b.txt',
        'relayfile:fs:write:/a.txt',
        'relayfile:fs:write:/b.txt',
      ]);
    } finally {
      await chmod(locked, 0o755);
      await workspace.cleanup();
      await outside.cleanup();
    }
  }
);
