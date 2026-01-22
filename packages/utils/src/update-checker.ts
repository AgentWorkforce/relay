/**
 * Auto-update checker for agent-relay
 *
 * Checks npm registry for newer versions and notifies users.
 * Caches results to avoid excessive API calls (checks at most once per hour).
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import { compare } from 'compare-versions';

const PACKAGE_NAME = 'agent-relay';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
  error?: string;
}

function getCachePath(): string {
  const cacheDir = path.join(os.homedir(), '.agent-relay');
  return path.join(cacheDir, 'update-cache.json');
}

function readCache(): UpdateCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;
    const data = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    const cachePath = getCachePath();
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // Silently ignore cache write errors
  }
}

function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(NPM_REGISTRY_URL, { timeout: 5000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const location = res.headers.location;
        if (location) {
          https.get(location, { timeout: 5000 }, (redirectRes) => {
            handleResponse(redirectRes, resolve, reject);
          }).on('error', reject);
          return;
        }
      }
      handleResponse(res, resolve, reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function handleResponse(
  res: http.IncomingMessage,
  resolve: (version: string) => void,
  reject: (err: Error) => void
): void {
  if (res.statusCode !== 200) {
    reject(new Error(`HTTP ${res.statusCode}`));
    return;
  }

  let data = '';
  res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.version) {
        resolve(json.version);
      } else {
        reject(new Error('No version in response'));
      }
    } catch (err) {
      reject(err as Error);
    }
  });
  res.on('error', reject);
}


export interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  error?: string;
}

/**
 * Check for updates (uses cache to avoid excessive API calls)
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo> {
  const cache = readCache();
  const now = Date.now();

  // Return cached result if still valid
  if (cache && (now - cache.lastCheck) < CHECK_INTERVAL_MS) {
    const updateAvailable = cache.latestVersion
      ? compare(cache.latestVersion, currentVersion, '>')
      : false;
    return {
      updateAvailable,
      currentVersion,
      latestVersion: cache.latestVersion,
      error: cache.error,
    };
  }

  // Fetch latest version from npm
  try {
    const latestVersion = await fetchLatestVersion();
    const updateAvailable = compare(latestVersion, currentVersion, '>');

    writeCache({
      lastCheck: now,
      latestVersion,
    });

    return {
      updateAvailable,
      currentVersion,
      latestVersion,
    };
  } catch (err) {
    const error = (err as Error).message;

    // Cache the error to avoid repeated failed requests
    writeCache({
      lastCheck: now,
      latestVersion: cache?.latestVersion || null,
      error,
    });

    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: cache?.latestVersion || null,
      error,
    };
  }
}

/**
 * Print update notification to stderr (non-blocking)
 */
export function printUpdateNotification(info: UpdateInfo): void {
  if (!info.updateAvailable || !info.latestVersion) return;

  const line1 = `Update available: ${info.currentVersion} → ${info.latestVersion}`;
  const line2 = 'Run: npm install -g agent-relay';
  const contentWidth = Math.max(line1.length, line2.length);
  const boxWidth = contentWidth + 4; // 2 chars padding each side

  const top = '╭' + '─'.repeat(boxWidth) + '╮';
  const bottom = '╰' + '─'.repeat(boxWidth) + '╯';
  const row1 = '│  ' + line1.padEnd(contentWidth) + '  │';
  const row2 = '│  ' + line2.padEnd(contentWidth) + '  │';

  console.error('');
  console.error(top);
  console.error(row1);
  console.error(row2);
  console.error(bottom);
  console.error('');
}

/**
 * Check for updates in the background and print notification if available.
 * This is non-blocking and errors are silently ignored.
 */
export function checkForUpdatesInBackground(currentVersion: string): void {
  // Run async check without awaiting
  checkForUpdates(currentVersion)
    .then(info => {
      if (info.updateAvailable) {
        printUpdateNotification(info);
      }
    })
    .catch(() => {
      // Silently ignore errors
    });
}
