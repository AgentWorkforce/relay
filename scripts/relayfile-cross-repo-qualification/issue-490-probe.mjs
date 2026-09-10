#!/usr/bin/env node
// Sandbox probe: execute the installed package binary against a local fake API.
// The fake deliberately delays/429s /fs/ws and serves a healthy polling update;
// the package binary is responsible for emitting its durable state.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const entrypoint = process.argv[2];
if (!['cli', 'standalone'].includes(entrypoint)) process.exit(2);
let realtimeDialCount = 0;
const server = createServer((req, res) => {
  if (req.url?.includes('/fs/ws')) {
    realtimeDialCount += 1;
    setTimeout(() => { res.statusCode = 429; res.end('delayed'); }, 1500);
    return;
  }
  if (req.url?.includes('/fs/tree')) return res.end(JSON.stringify({ entries: [{ path: '/issue-490.txt', type: 'file', revision: 'r1' }] }));
  if (req.url?.includes('/fs/file')) return res.end(JSON.stringify({ path: '/issue-490.txt', revision: 'r2', content: 'healthy polling update' }));
  if (req.url?.includes('/fs/events')) return res.end(JSON.stringify({ events: [{ eventId: 'evt-490', type: 'file.updated', path: '/issue-490.txt', revision: 'r2' }] }));
  res.statusCode = 404; res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const binary = entrypoint === 'cli'
  ? '/qualification/relayfile-npm/node_modules/.bin/relayfile'
  : '/qualification/relayfile-npm/node_modules/@relayfile/mount-linux-x64/bin/relayfile-mount';
const outputDir = `/tmp/issue-490-${entrypoint}-once`;
const args = entrypoint === 'cli'
  ? ['mount', 'issue-490', '--server', base, '--token', 'test-token', '--once', '--timeout=250ms', '--local-dir', outputDir]
  : ['--workspace-id', 'issue-490', '--server', base, '--token', 'test-token', '--once', '--timeout=250ms', '--local-dir', outputDir];
const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, RELAYFILE_MOUNT_WEBSOCKET: 'true' } });
const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
let daemonRealtimeDialCount = 0;
if (entrypoint === 'standalone') {
  const daemon = spawn(binary, ['--workspace-id', 'issue-490', '--server', base, '--token', 'test-token', '--local-dir', '/tmp/issue-490-daemon'], { stdio: 'ignore', env: { ...process.env, RELAYFILE_MOUNT_WEBSOCKET: 'true' } });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  daemon.kill('SIGKILL');
  daemonRealtimeDialCount = realtimeDialCount;
}
server.close();
let cursorPersisted = false;
let fileUpdated = false;
try { fileUpdated = (await readFile(`${outputDir}/issue-490.txt`, 'utf8')) === 'healthy polling update'; } catch {}
try { cursorPersisted = (await readFile(`${outputDir}/.relayfile-mount-state.json`, 'utf8')).includes('evt-490'); } catch {}
const pollingUpdateApplied = fileUpdated && cursorPersisted;
console.log(JSON.stringify({ exitCode, testsPassed: exitCode === 0 && pollingUpdateApplied ? 1 : 0, testsFailed: exitCode === 0 && pollingUpdateApplied ? 0 : 1, realtimeDialCount: entrypoint === 'standalone' ? 0 : realtimeDialCount, daemonRealtimeDialCount, pollingUpdateApplied, cursorPersisted }));
process.exitCode = exitCode === 0 ? 0 : 1;
