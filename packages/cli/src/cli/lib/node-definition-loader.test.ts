import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverNodeConfigPath, loadNodeDefinition } from './node-definition-loader.js';

describe('loadNodeDefinition', () => {
  it('loads the example TS node file', async () => {
    const node = await loadNodeDefinition(path.resolve(process.cwd(), 'examples/relay-node.ts'));

    expect(node.name).toBe('local-builder');
    expect(Object.keys(node.capabilities)).toContain('spawn:codex');
  });

  it('loads a plain JS node file through native import', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-def-'));
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      const file = path.join(dir, 'node-def.js');
      await writeFile(
        file,
        [
          'export default {',
          '  __agentRelayFleetNode: true,',
          '  name: "plain-js-node",',
          '  capabilities: {},',
          '  triggers: [],',
          '};',
        ].join('\n')
      );

      const node = await loadNodeDefinition(file);

      expect(node.name).toBe('plain-js-node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads CommonJS compiled JS node files that export default wrappers', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-def-'));
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      const file = path.join(dir, 'node-def.js');
      await writeFile(
        file,
        [
          'exports.default = {',
          '  __agentRelayFleetNode: true,',
          '  name: "compiled-cjs-node",',
          '  capabilities: {},',
          '  triggers: [],',
          '};',
        ].join('\n')
      );

      const node = await loadNodeDefinition(file);

      expect(node.name).toBe('compiled-cjs-node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to jiti for ESM-syntax JS node files in CommonJS projects', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-def-'));
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      const file = path.join(dir, 'node-def.js');
      await writeFile(
        file,
        [
          'export default {',
          '  __agentRelayFleetNode: true,',
          '  name: "commonjs-project-esm-node",',
          '  capabilities: {},',
          '  triggers: [],',
          '};',
        ].join('\n')
      );

      const node = await loadNodeDefinition(file);

      expect(node.name).toBe('commonjs-project-esm-node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('discoverNodeConfigPath', () => {
  it('resolves an explicit --config path that exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-cfg-'));
    try {
      const file = path.join(dir, 'custom-node.ts');
      await writeFile(file, 'export default {};');

      expect(discoverNodeConfigPath(dir, 'custom-node.ts')).toBe(file);
      expect(discoverNodeConfigPath(dir, file)).toBe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when an explicit --config path is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-cfg-'));
    try {
      expect(() => discoverNodeConfigPath(dir, 'does-not-exist.ts')).toThrow(
        /Node config file not found: does-not-exist\.ts/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('auto-discovers agent-relay.ts in the working directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-cfg-'));
    try {
      const file = path.join(dir, 'agent-relay.ts');
      await writeFile(file, 'export default {};');

      expect(discoverNodeConfigPath(dir)).toBe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers TS variants over compiled JS in the deterministic search order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-cfg-'));
    try {
      await writeFile(path.join(dir, 'agent-relay.js'), 'module.exports = {};');
      const tsFile = path.join(dir, 'agent-relay.ts');
      await writeFile(tsFile, 'export default {};');

      expect(discoverNodeConfigPath(dir)).toBe(tsFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no config file is present and none was requested', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-cfg-'));
    try {
      expect(discoverNodeConfigPath(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
