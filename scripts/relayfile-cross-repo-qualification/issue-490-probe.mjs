#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const entrypoint = process.argv[2];
if (!['cli', 'standalone'].includes(entrypoint)) process.exit(2);
let changed = false, wsUpgradeCount = 0;
const server = createServer((req, res) => {
  if (req.url?.includes('/fs/tree')) return res.end(JSON.stringify({ entries: [{ path: '/issue-490.txt', type: 'file', revision: changed ? 'r2' : 'r1' }] }));
  if (req.url?.includes('/fs/file')) return res.end(JSON.stringify({ path: '/issue-490.txt', revision: changed ? 'r2' : 'r1', content: changed ? 'healthy polling update' : 'initial' }));
  if (req.url?.includes('/fs/events')) return res.end(JSON.stringify({ events: changed ? [{ eventId: 'evt_001', type: 'file.updated', path: '/issue-490.txt', revision: 'r2' }] : [] }));
  if (req.url?.includes('/fs/bulk-read')) { res.statusCode = 501; return res.end('unsupported'); }
  if (req.url?.includes('/sync/status')) return res.end(JSON.stringify({ workspaceId: 'issue-490', providers: [] }));
  res.statusCode = 404; res.end();
});
server.on('upgrade', (_req, socket) => { wsUpgradeCount += 1; setTimeout(() => { socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 7\r\n\r\ndelayed'); socket.destroy(); }, 1500); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const jwt = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${Buffer.from(JSON.stringify({ workspace_id: 'issue-490', aud: 'relayfile', agent_name: 'qualification-490' })).toString('base64url')}.signature`;
const binary = entrypoint === 'cli' ? '/qualification/relayfile-npm/node_modules/.bin/relayfile' : '/qualification/relayfile-npm/node_modules/@relayfile/mount-linux-x64/bin/relayfile-mount';
const outputDir = `/tmp/issue-490-${entrypoint}`;
const stateFile = `/tmp/issue-490-${entrypoint}-state/state.json`;
const args = entrypoint === 'cli' ? ['mount', 'issue-490', '--server', base, '--token', jwt, '--once', '--timeout=250ms', '--local-dir', outputDir, '--state-file', stateFile] : ['--workspace', 'issue-490', '--server', base, '--token', jwt, '--once', '--timeout=250ms', '--local-dir', outputDir, '--state-file', stateFile];
const runOnce = () => new Promise((resolve) => {
  const child = spawn(binary, args, { stdio: 'ignore', env: { ...process.env, RELAYFILE_MOUNT_WEBSOCKET: 'true' } });
  child.once('error', () => resolve(1));
  child.once('exit', (code) => resolve(code ?? 1));
});
const firstExit = await runOnce();
changed = true;
const secondExit = await runOnce();
const onceWsUpgradeCount = wsUpgradeCount;
let fileUpdated = false, cursorPersisted = false;
try { fileUpdated = (await readFile(`${outputDir}/issue-490.txt`, 'utf8')) === 'healthy polling update'; } catch {}
try { cursorPersisted = JSON.parse(await readFile(stateFile, 'utf8')).eventsCursor === 'evt_001'; } catch {}
let daemonRealtimeDialCount = 0;
if (entrypoint === 'standalone') {
  const daemon = spawn(binary, ['--workspace', 'issue-490', '--server', base, '--token', jwt, '--local-dir', `${outputDir}-daemon`, '--state-file', `/tmp/issue-490-${entrypoint}-daemon-state/state.json`], { stdio: 'ignore', env: { ...process.env, RELAYFILE_MOUNT_WEBSOCKET: 'true' } });
  const daemonExit = new Promise((resolve) => { daemon.once('error', () => resolve(1)); daemon.once('exit', (code) => resolve(code ?? 1)); });
  const deadline = Date.now() + 10_000;
  while (wsUpgradeCount - onceWsUpgradeCount < 1 && Date.now() < deadline) await sleep(100);
  daemonRealtimeDialCount = wsUpgradeCount - onceWsUpgradeCount;
  daemon.kill('SIGKILL');
  await daemonExit;
}
server.close();
const success = firstExit === 0 && secondExit === 0 && fileUpdated && cursorPersisted && onceWsUpgradeCount === 0 && (entrypoint !== 'standalone' || daemonRealtimeDialCount > 0);
console.log(JSON.stringify({ exitCode: success ? 0 : 1, testsPassed: success ? 1 : 0, testsFailed: success ? 0 : 1, realtimeDialCount: onceWsUpgradeCount, onceWsUpgradeCount, daemonRealtimeDialCount, pollingUpdateApplied: fileUpdated, cursorPersisted }));
process.exitCode = success ? 0 : 1;
