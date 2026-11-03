#!/usr/bin/env node
// Install without upgrading Pi or changing its settings. Existing sessions use /reload.
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

// The core turns Pi sessions off on Windows: the extension calls
// process.getuid(), which Windows lacks.
if (process.platform === 'win32') throw new Error('Pi sessions are not available on Windows.');
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
if (!isAbsolute(agentDir)) throw new Error('PI_CODING_AGENT_DIR must be absolute.');
if (!fs.existsSync(agentDir)) throw new Error(`Pi agent directory does not exist: ${agentDir}`);
const path = join(agentDir, 'extensions/agent-relay.js');
const source = fs
  .readFileSync(new URL('../src/relay/pi/agent-relay.mjs', import.meta.url), 'utf8')
  .replace('__RUNTIME__', JSON.stringify(join(homedir(), '.agentworkforce/desktop/pi')))
  .replace('__HARNESS__', JSON.stringify('pi'));
// Read what is there through one descriptor that refuses a symlink, so the
// file checked is the file read.
let current = null;
try {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    current = fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : '';
  } finally {
    fs.closeSync(fd);
  }
} catch (error) {
  // ELOOP: a symlink, which is never ours to replace.
  if (error.code === 'ELOOP') current = '';
  else if (error.code !== 'ENOENT') throw error;
}
if (current !== null) {
  if (!current.startsWith('// AGENT_RELAY_PI_EXTENSION='))
    throw new Error(`Preserving another extension at ${path}; move it before installing.`);
  // Oh My Pi can share this folder; its copy names the omp harness.
  if (current.includes('const harness = "omp";'))
    throw new Error(`Preserving the Oh My Pi extension at ${path}; the core installs both.`);
}
fs.mkdirSync(join(agentDir, 'extensions'), { recursive: true, mode: 0o700 });
if (current !== source) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, source, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, path);
}
console.log(
  `Installed ${path}. Run /reload in an existing Pi session, then enable Receives messages in Agent Relay.`
);
