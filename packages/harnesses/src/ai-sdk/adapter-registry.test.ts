import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiSdkAdapterRegistry, aiSdkAdapterRegistry } from './adapter-registry.js';

describe('AI SDK adapter registry', () => {
  it('registers the five planned adapters and aliases', () => {
    expect(aiSdkAdapterRegistry.list().map((entry) => entry.name)).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
      'deepagents',
    ]);
    expect(aiSdkAdapterRegistry.get('CLAUDE-CODE')?.name).toBe('claude');
    expect(aiSdkAdapterRegistry.get('open-code')?.name).toBe('opencode');
    expect(aiSdkAdapterRegistry.get('deep-agents')?.name).toBe('deepagents');
  });

  it('declares execution, PTY, rollout, and lifecycle limitations honestly', () => {
    expect(aiSdkAdapterRegistry.require('pi')).toMatchObject({
      execution: 'host',
      ptyAvailable: false,
      rollout: 'experimental',
    });
    expect(aiSdkAdapterRegistry.require('deepagents').lifecycle).toMatchObject({
      compact: false,
      stopPreservesConversation: false,
    });
    expect(aiSdkAdapterRegistry.require('codex').ptyAvailable).toBe(true);
  });

  it('maps only settings understood by each adapter', () => {
    expect(aiSdkAdapterRegistry.require('codex').mapSettings({})).toEqual({
      model: 'gpt-5.6-terra',
    });
    expect(
      aiSdkAdapterRegistry.require('codex').mapSettings({ model: 'gpt-5.6-sol', webSearch: true })
    ).toEqual({ model: 'gpt-5.6-sol', webSearch: true });
    expect(
      aiSdkAdapterRegistry.require('claude').mapSettings({
        model: 'opus',
        maxTurns: 4,
        thinking: { type: 'adaptive' },
        thinkingLevel: 'high',
      })
    ).toEqual({ model: 'opus', maxTurns: 4, thinking: { type: 'adaptive' } });
    expect(
      aiSdkAdapterRegistry.require('pi').mapSettings({
        model: 'gateway/model',
        thinkingLevel: 'high',
        port: 9000,
      })
    ).toEqual({ model: 'gateway/model', thinkingLevel: 'high' });
  });

  it('loads each official package lazily', async () => {
    const harnesses = await Promise.all(aiSdkAdapterRegistry.list().map((entry) => entry.createHarness()));

    for (const harness of harnesses) {
      expect(harness.specificationVersion).toBe('harness-v1');
      expect(harness.harnessId).toBeTruthy();
    }
  }, 15_000);

  it('pins a Pi adapter closure without the known vulnerable nested HTTP and glob releases', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(
      await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8')
    );
    expect(manifest.dependencies['@ai-sdk/harness-pi']).toBe('1.0.104');

    const effectivePackage = (from: string, name: string) => {
      for (let current = from; current !== '.'; current = path.posix.dirname(current)) {
        if (path.posix.basename(current) === 'node_modules') continue;
        const location = path.posix.join(current, 'node_modules', name);
        if (lock.packages[location]) return { location, ...lock.packages[location] };
      }
      const rootLocation = path.posix.join('node_modules', name);
      if (lock.packages[rootLocation]) return { location: rootLocation, ...lock.packages[rootLocation] };
      throw new Error(`lockfile cannot resolve ${name} from ${from}`);
    };
    const pi = effectivePackage('packages/harnesses', '@earendil-works/pi-coding-agent');
    const minimatch = effectivePackage(pi.location, 'minimatch');
    const braceExpansion = effectivePackage(minimatch.location, 'brace-expansion');
    const undici = effectivePackage(pi.location, 'undici');

    expect(pi.version).toBe('0.84.4');
    expect(minimatch.version).toBe('10.2.5');
    expect(braceExpansion.version).toBe('5.0.9');
    expect(undici.version).toBe('8.9.0');
  });

  it('rejects duplicate aliases at construction', () => {
    const entry = aiSdkAdapterRegistry.require('codex');
    expect(() => new AiSdkAdapterRegistry([entry, { ...entry }])).toThrow(/Duplicate/);
  });
});
