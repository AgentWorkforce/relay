import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression tests for node-definition loading inside a `bun build --compile`
 * binary — the artifact users actually install via the curl script.
 *
 * These MUST compile a real binary. Both bugs they cover are invisible to a
 * plain `node`/vitest run (Node resolves bare specifiers correctly and jiti's
 * Babel transpiler is present in node_modules), which is precisely why they
 * shipped: every existing loader test passes against the broken code.
 *
 *   Bug 1: `.ts` configs were routed through jiti, whose Babel transpiler is
 *          loaded via a dynamic `require('../dist/babel.cjs')` that bun cannot
 *          embed -> `Cannot find module '../dist/babel.cjs' from '/$bunfs/root/...'`.
 *   Bug 2: a bun-compiled binary cannot resolve a bare package specifier out of
 *          the config's own node_modules when the package's entry point lives in
 *          a subdirectory (dist/, lib/ — i.e. every package built from
 *          TypeScript) -> `Cannot find module '@agent-relay/factory/node' from
 *          '<config>'`, transitively through the user's whole dependency graph.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(here, 'node-definition-loader.ts');
const CHILD_PROVIDER = path.join(here, 'node-provider-child.ts');
const BROKER_LIFECYCLE = path.join(here, 'broker-lifecycle.ts');

function hasBun(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Compile `source` into a standalone binary the same way scripts/build-bun.sh does. */
function compile(dir: string, name: string, source: string): string {
  const entry = path.join(dir, `${name}.ts`);
  writeFileSync(entry, source, 'utf8');
  const outfile = path.join(dir, name);
  execFileSync('bun', ['build', '--compile', '--minify', entry, '--outfile', outfile], {
    stdio: 'pipe',
  });
  return outfile;
}

type RunResult = { status: number; stdout: string; stderr: string };

function run(binary: string, args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync(binary, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const bunAvailable = hasBun();

describe.skipIf(!bunAvailable)('node definition loading from a bun-compiled binary', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'relay-bun-loader-'));

    // A project with a package in its own node_modules, mirroring
    // `@agent-relay/factory` in the factory#73 README instructions.
    //
    // The entry point MUST live in a subdirectory (dist/), like every package
    // built from TypeScript — including @agent-relay/factory and
    // @agent-relay/fleet. That is the exact trigger for the bun bug: a compiled
    // binary resolves a bare specifier only when the package's entry is a file
    // at the package ROOT. A fixture with `index.js` at the root resolves fine
    // inside the binary and silently tests nothing.
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const pkgDir = path.join(dir, 'node_modules', '@fixture', 'node-lib');
    mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/node-lib',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' },
        },
      })
    );
    writeFileSync(
      path.join(pkgDir, 'dist', 'index.js'),
      [
        'export default {',
        '  __agentRelayFleetNode: true,',
        '  name: "fixture-node",',
        '  capabilities: { "spawn:claude": { name: "spawn:claude", kind: "spawn", handler: () => undefined } },',
        '  triggers: [],',
        '};',
      ].join('\n')
    );
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a self-contained .ts config in-process under Bun (native transpile, no jiti)', () => {
    const config = path.join(dir, 'self-contained.ts');
    writeFileSync(
      config,
      [
        'type Capability = { name: string; kind: string; handler: () => void };',
        'const capabilities: Record<string, Capability> = {};',
        'export default {',
        '  __agentRelayFleetNode: true as const,',
        '  name: "ts-node",',
        '  capabilities,',
        '  triggers: [],',
        '};',
      ].join('\n')
    );

    const result = run(loadHarness(dir), [config], dir);

    expect(result.stderr).not.toMatch(/babel\.cjs/);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ name: 'ts-node' });
  }, 60_000);

  /**
   * The `Cannot find module '../dist/babel.cjs'` failure users actually hit.
   *
   * It is a RED HERRING masking the real bug: jiti's native path cannot resolve
   * the config's bare import (bun cannot reach a dist/-entry package from a
   * compiled binary), so jiti falls back to Babel — whose transpiler bun never
   * embedded, because jiti loads it via a dynamic require. The user is told the
   * transpiler is missing, not that their import failed to resolve.
   *
   * Routing `.ts` through jiti under Bun is therefore never useful: it can only
   * turn a resolution error into a confusing one. This asserts the real cause
   * surfaces instead.
   */
  it('surfaces the real resolution error for a .ts config, not the babel.cjs red herring', () => {
    const config = path.join(dir, 'bare-import.ts');
    writeFileSync(config, `export { default } from '@fixture/node-lib';\n`);

    const result = run(loadHarness(dir), [config], dir);

    expect(result.status).not.toBe(0);
    // Before the fix: "Cannot find module '../dist/babel.cjs' from '/$bunfs/root/...'"
    expect(result.stderr).not.toMatch(/babel\.cjs/);
    expect(result.stderr).toMatch(/@fixture\/node-lib/);
  }, 60_000);

  it('serves a .mjs config that imports a bare specifier from its own node_modules', () => {
    const config = path.join(dir, 'agent-relay.mjs');
    writeFileSync(config, `export { default } from '@fixture/node-lib';\n`);

    const descriptor = describeViaHarness(dir, config);

    expect(descriptor).toEqual({ name: 'fixture-node', capabilities: ['spawn:claude'] });
  }, 60_000);

  it('serves a .ts config that imports a bare specifier from its own node_modules', () => {
    // The exact shape factory#73's README documents:
    //   agent-relay.ts: export { default } from '@agent-relay/factory/node'
    const config = path.join(dir, 'agent-relay-bare.ts');
    writeFileSync(config, `export { default } from '@fixture/node-lib';\n`);

    const descriptor = describeViaHarness(dir, config);

    expect(descriptor).toEqual({ name: 'fixture-node', capabilities: ['spawn:claude'] });
  }, 60_000);

  it('serves a .tsx config through a transpiling Node loader', () => {
    const config = path.join(dir, 'agent-relay-bare.tsx');
    const helper = path.join(dir, 'node-definition.tsx');
    writeFileSync(config, "export { default } from './node-definition.tsx';\n");
    writeFileSync(
      helper,
      [
        "import definition from '@fixture/node-lib';",
        'const identity = <T,>(value: T): T => value;',
        'export default identity(definition);',
      ].join('\n')
    );

    const descriptor = describeViaHarness(dir, config);

    expect(descriptor).toEqual({ name: 'fixture-node', capabilities: ['spawn:claude'] });
  }, 60_000);

  it('serves a .mts config through the transpiling Node loader', () => {
    const config = path.join(dir, 'agent-relay-bare.mts');
    writeFileSync(config, "export { default } from '@fixture/node-lib';\n");

    const descriptor = describeViaHarness(dir, config);

    expect(descriptor).toEqual({ name: 'fixture-node', capabilities: ['spawn:claude'] });
  }, 60_000);

  it('serves a CommonJS .cts config through the transpiling Node loader', () => {
    const config = path.join(dir, 'agent-relay-bare.cts');
    const helper = path.join(dir, 'node-definition.cts');
    writeFileSync(
      config,
      [
        "const definition = require('./node-definition.cts');",
        "const direct = module.require('@fixture/node-lib').default;",
        "if (definition !== direct) throw new Error('local CommonJS graph returned the wrong export');",
        "if (module.filename !== __filename) throw new Error('module.filename mismatch: ' + module.filename + ' !== ' + __filename);",
        "if (module.path !== __dirname) throw new Error('module.path mismatch: ' + module.path + ' !== ' + __dirname);",
        'export = definition;',
      ].join('\n')
    );
    writeFileSync(
      helper,
      [
        "enum FixtureKind { Node = 'node' }",
        'const kind: FixtureKind = FixtureKind.Node;',
        "if (kind !== 'node') throw new Error('TypeScript was not transformed');",
        "const definition = require('@fixture/node-lib').default;",
        'export = definition;',
      ].join('\n')
    );

    const descriptor = describeViaHarness(dir, config);

    expect(descriptor).toEqual({ name: 'fixture-node', capabilities: ['spawn:claude'] });
  }, 60_000);

  /**
   * Pins the bun limitation the child-process design exists for: a compiled
   * binary cannot resolve a package whose entry lives in a subdirectory. If
   * this ever starts passing, bun has fixed it and the child hop could be
   * reconsidered — until then, "just import it in-process" is not an available
   * simplification.
   */
  it('cannot import a bare specifier in-process from a compiled binary (why the child exists)', () => {
    const config = path.join(dir, 'agent-relay.mjs');
    const binary = compile(
      dir,
      'in-process-harness',
      [
        'import { pathToFileURL } from "node:url";',
        'const m = await import(pathToFileURL(process.argv[2]).href);',
        'console.log(JSON.stringify({ name: m.default?.name }));',
      ].join('\n')
    );

    const result = run(binary, [config], dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Cannot find (module|package) '@fixture\/node-lib'/);
  }, 60_000);
});

describe.skipIf(!bunAvailable)('node definition serving plan under plain Bun', () => {
  it('keeps plain Bun in-process and reserves the node child for a compiled Bun binary', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-plain-bun-plan-'));
    const config = path.join(dir, 'agent-relay.mjs');
    const harness = path.join(dir, 'plain-bun-plan.ts');
    const packageRoot = path.join(dir, 'node_modules', '@fixture', 'plan-node');
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(config, "export { default } from '@fixture/plan-node';\n");
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/plan-node',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        exports: { '.': './dist/index.js' },
      })
    );
    writeFileSync(
      path.join(packageRoot, 'dist', 'index.js'),
      "export default { __agentRelayFleetNode: true, name: 'plan', capabilities: {}, triggers: [] };\n"
    );
    writeFileSync(
      harness,
      [
        `import { loadNodeDefinitionPlan } from ${JSON.stringify(BROKER_LIFECYCLE)};`,
        'const configPath = process.argv[2];',
        'const deps = {',
        "  argv: ['bun', import.meta.path, 'node', 'up'],",
        '  cliScript: import.meta.path,',
        '  env: process.env,',
        "  execCommand: async () => { throw new Error('plain Bun must not require node'); },",
        '};',
        'const plan = await loadNodeDefinitionPlan(configPath, deps);',
        'console.log(plan.mode);',
      ].join('\n')
    );

    try {
      const stdout = execFileSync('bun', [harness, config], {
        cwd: path.resolve(here, '../../../../..'),
        stdio: 'pipe',
        encoding: 'utf8',
      });
      expect(stdout.trim()).toBe('in-process');

      const compiled = compile(
        dir,
        'compiled-serving-plan',
        [
          `import { loadNodeDefinitionPlan } from ${JSON.stringify(BROKER_LIFECYCLE)};`,
          'import { exec } from "node:child_process";',
          'import { promisify } from "node:util";',
          'const execAsync = promisify(exec);',
          'const deps = {',
          '  argv: process.argv,',
          '  cliScript: process.argv[1],',
          '  env: process.env,',
          '  execCommand: async (command) => execAsync(command),',
          '};',
          'const plan = await loadNodeDefinitionPlan(process.argv[2], deps);',
          'console.log(plan.mode);',
        ].join('\n')
      );
      const compiledResult = run(compiled, [config], dir);
      expect(compiledResult.status).toBe(0);
      expect(compiledResult.stdout.trim()).toBe('child-node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** A compiled binary that loads a node definition in-process via the real loader. */
function loadHarness(dir: string): string {
  return compile(
    dir,
    'load-harness',
    [
      `import { loadNodeDefinition } from ${JSON.stringify(LOADER)};`,
      'const def = await loadNodeDefinition(process.argv[2]);',
      'console.log(JSON.stringify({ name: def.name }));',
    ].join('\n')
  );
}

/**
 * Drive `describeNodeDefinitionViaNode` from inside a compiled binary, which is
 * how the shipped CLI learns about a JS/TS node definition it cannot import.
 */
function describeViaHarness(dir: string, config: string): unknown {
  const binary = compile(
    dir,
    `describe-harness-${path.basename(config).replace(/\W/g, '-')}`,
    [
      `import { describeNodeDefinitionViaNode } from ${JSON.stringify(CHILD_PROVIDER)};`,
      'import { promisify } from "node:util";',
      'import { exec } from "node:child_process";',
      'const execAsync = promisify(exec);',
      'const deps = { env: process.env, execCommand: (command) => execAsync(command) };',
      'const descriptor = await describeNodeDefinitionViaNode(process.argv[2], deps);',
      'console.log("__RESULT__" + JSON.stringify(descriptor));',
    ].join('\n')
  );

  const result = run(binary, [config], dir);
  if (result.status !== 0) {
    throw new Error(`describe harness failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const line = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(`no descriptor in harness output: ${result.stdout}`);
  }
  return JSON.parse(line.slice('__RESULT__'.length));
}
