import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseExactPackageSpec, waitForNpmPackage } from '../../scripts/wait-for-npm-package.mjs';

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('npm package readiness gate', () => {
  it('parses scoped exact-version package specs', () => {
    expect(parseExactPackageSpec('@agent-relay/sdk@11.8.4')).toEqual({
      name: '@agent-relay/sdk',
      version: '11.8.4',
    });
  });

  it('waits until both version metadata and the tarball are available', async () => {
    let currentTime = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      currentTime += delayMs;
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(
        response(200, {
          version: '11.8.4',
          dist: { tarball: 'https://registry.npmjs.org/@agent-relay/sdk/-/sdk-11.8.4.tgz' },
        })
      )
      .mockResolvedValueOnce(response(200));

    await waitForNpmPackage('@agent-relay/sdk@11.8.4', {
      fetchImpl,
      sleep,
      now: () => currentTime,
      intervalMs: 1_000,
      timeoutMs: 5_000,
      log: vi.fn(),
    });

    expect(sleep).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: 'HEAD' });
  });

  it('fails with the last registry error after the bounded timeout', async () => {
    let currentTime = 0;

    await expect(
      waitForNpmPackage('@agent-relay/sdk@11.8.4', {
        fetchImpl: vi.fn().mockResolvedValue(response(404)),
        sleep: async (delayMs: number) => {
          currentTime += delayMs;
        },
        now: () => currentTime,
        intervalMs: 1_000,
        timeoutMs: 2_000,
        log: vi.fn(),
      })
    ).rejects.toThrow('Timed out after 2s waiting for @agent-relay/sdk@11.8.4: metadata HTTP 404');
  });

  it('blocks the package publish matrix on registry readiness', () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
    const publishMatrix = workflow.match(
      /  publish-packages:\n[\s\S]*?\n  # Publish @agent-relay\/harnesses/
    )?.[0];

    expect(publishMatrix).toBeDefined();
    expect(publishMatrix).toContain('npm publish --access public --provenance');
    expect(publishMatrix).toContain('Wait for published package readiness');
    expect(publishMatrix).toContain('node ../../scripts/wait-for-npm-package.mjs "$PKG_SPEC"');
    expect(publishMatrix!.indexOf('Wait for published package readiness')).toBeGreaterThan(
      publishMatrix!.indexOf('npm publish --access public --provenance')
    );
  });
});
