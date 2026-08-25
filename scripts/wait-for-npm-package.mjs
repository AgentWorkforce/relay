#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
// The 11.8.4 SDK took just over 15 minutes to become readable after npm
// accepted the publish. Leave enough room for that asynchronous processing
// without allowing a stuck release to wait forever.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 10 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

export function parseExactPackageSpec(spec) {
  const separator = spec.lastIndexOf('@');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Expected an exact package spec such as @scope/name@1.2.3, got: ${spec}`);
  }

  return {
    name: spec.slice(0, separator),
    version: spec.slice(separator + 1),
  };
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number, got: ${value}`);
  }
  return parsed;
}

function describeResponse(response) {
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
}

export async function waitForNpmPackage(
  spec,
  {
    registryUrl = DEFAULT_REGISTRY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = Date.now,
    log = console.log,
  } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  const { name, version } = parseExactPackageSpec(spec);
  const normalizedRegistry = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`;
  const metadataUrl = new URL(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    normalizedRegistry
  );
  const startedAt = now();
  let attempt = 0;
  let lastFailure = 'package metadata was not checked';

  while (true) {
    attempt += 1;
    const cacheBuster = String(now());
    metadataUrl.searchParams.set('_relay_ready', cacheBuster);

    try {
      const metadataResponse = await fetchImpl(metadataUrl, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!metadataResponse.ok) {
        lastFailure = `metadata ${describeResponse(metadataResponse)}`;
      } else {
        const metadata = await metadataResponse.json();
        if (metadata.version !== version) {
          lastFailure = `metadata returned version ${metadata.version ?? '<missing>'}`;
        } else if (!metadata.dist?.tarball) {
          lastFailure = 'metadata did not include dist.tarball';
        } else {
          const tarballUrl = new URL(metadata.dist.tarball);
          tarballUrl.searchParams.set('_relay_ready', cacheBuster);
          const tarballResponse = await fetchImpl(tarballUrl, {
            method: 'HEAD',
            headers: { 'cache-control': 'no-cache' },
            redirect: 'follow',
            signal: AbortSignal.timeout(requestTimeoutMs),
          });

          if (tarballResponse.ok) {
            const elapsedSeconds = Math.ceil((now() - startedAt) / 1000);
            log(`npm package ready: ${spec} (attempt ${attempt}, ${elapsedSeconds}s)`);
            return metadata;
          }
          lastFailure = `tarball ${describeResponse(tarballResponse)}`;
        }
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`Timed out after ${Math.ceil(elapsedMs / 1000)}s waiting for ${spec}: ${lastFailure}`);
    }

    const delayMs = Math.min(intervalMs, timeoutMs - elapsedMs);
    log(
      `npm package not ready: ${spec} (attempt ${attempt}: ${lastFailure}); retrying in ${Math.ceil(delayMs / 1000)}s`
    );
    await sleep(delayMs);
  }
}

function parseCliArgs(argv) {
  const [spec, ...args] = argv;
  if (!spec) {
    throw new Error(
      'Usage: node scripts/wait-for-npm-package.mjs <package@version> [--timeout-seconds N] [--interval-seconds N] [--registry URL]'
    );
  }

  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    switch (flag) {
      case '--timeout-seconds':
        options.timeoutMs = positiveNumber(value, flag) * 1000;
        break;
      case '--interval-seconds':
        options.intervalMs = positiveNumber(value, flag) * 1000;
        break;
      case '--registry':
        options.registryUrl = value;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { spec, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { spec, options } = parseCliArgs(process.argv.slice(2));
    await waitForNpmPackage(spec, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
