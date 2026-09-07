import { describe, expect, it } from 'vitest';

// The runner copies this probe to <target>/.relay-pr-proof before execution.
import { resolveBrokerConnection } from '../packages/cli/src/cli/lib/broker-connection.js';
import { isNativeHarness } from '../packages/cli/src/cli/lib/attach-native.js';

const ARM = process.env.RELAY_PR_PROOF_ARM;

function makeDeps(overrides: { env?: NodeJS.ProcessEnv; fileUrl?: string; fileKey?: string } = {}) {
  return {
    readConnectionFile: () =>
      overrides.fileUrl ? { url: overrides.fileUrl, ...(overrides.fileKey ? { api_key: overrides.fileKey } : {}) } : null,
    getDefaultStateDir: () => '/tmp/fake/.agentworkforce/relay',
    env: overrides.env ?? {},
  };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
}

describe('broker connection atomic credential pairing proof', () => {
  it('observes the declared base bug or the complete head fix', async () => {
    expect(['base', 'head']).toContain(ARM);

    // Scenario: a relay agent's own RELAY_BROKER_API_KEY sits in env (its own
    // broker's credential) while attaching to a *different* repo's broker,
    // whose URL resolves from that repo's connection.json. No explicit or
    // env URL is provided.
    const deps = makeDeps({
      env: { RELAY_BROKER_API_KEY: 'own-broker-key' },
      fileUrl: 'http://target-repo-host:4000',
    });
    const connection = resolveBrokerConnection({}, deps);

    // A probe that always fails, standing in for a broker rejecting a
    // mismatched credential with 401 (or being unreachable at all) — the
    // point under test is whether isNativeHarness propagates that failure
    // or degrades to `false`, not the transport itself.
    const failingFetch = (async () => {
      throw new Error('401 Unauthorized');
    }) as unknown as typeof globalThis.fetch;
    const probeOutcome = await captureRejection(
      isNativeHarness('Worker', { brokerUrl: connection?.url }, failingFetch)
    );

    if (ARM === 'base') {
      // Bug 1: the env-sourced key rides along with the file-sourced URL.
      expect(connection).toEqual({ url: 'http://target-repo-host:4000', apiKey: 'own-broker-key' });
      // Bug 2: the capability probe's rejection propagates and would abort
      // the whole attach before any non-native fallback runs.
      expect(probeOutcome).toHaveProperty('rejected');
      return;
    }

    // Fix 1: the key never reaches past the tier that supplied the URL, so
    // an unrelated env-sourced key is never paired with the file's URL.
    expect(connection).toEqual({ url: 'http://target-repo-host:4000', apiKey: undefined });
    // Fix 2: the probe degrades to `false` instead of aborting the attach.
    expect(probeOutcome).toEqual({ resolved: false });

    // An explicit --api-key still overrides, and an explicit --broker-url
    // still discovers its key normally beneath it — the fix narrows only
    // the cross-tier leak, it does not remove either override path.
    const explicitKeyDeps = makeDeps({
      env: { RELAY_BROKER_API_KEY: 'own-broker-key' },
      fileUrl: 'http://target-repo-host:4000',
    });
    expect(resolveBrokerConnection({ apiKey: 'explicit-key' }, explicitKeyDeps)).toEqual({
      url: 'http://target-repo-host:4000',
      apiKey: 'explicit-key',
    });
    const explicitUrlDeps = makeDeps({ fileUrl: 'http://file-host:5678', fileKey: 'file-key' });
    expect(resolveBrokerConnection({ brokerUrl: 'http://flag-host:9999' }, explicitUrlDeps)).toEqual({
      url: 'http://flag-host:9999',
      apiKey: 'file-key',
    });
  });
});
