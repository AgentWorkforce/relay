#!/usr/bin/env node
// Install without upgrading Pi or changing its settings. Existing sessions use /reload.
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
if (!isAbsolute(agentDir)) throw new Error('PI_CODING_AGENT_DIR must be absolute.');
if (!fs.existsSync(agentDir)) throw new Error(`Pi agent directory does not exist: ${agentDir}`);
const path = join(agentDir, 'extensions/agent-relay.js');
const source = fs.readFileSync(new URL('../probe/src/relay/pi/agent-relay.mjs', import.meta.url), 'utf8')
  .replace('__RUNTIME__', JSON.stringify(join(homedir(), '.agentworkforce/desktop/pi')));

// Read the installed entry through the same no-follow descriptor that is
// validated. A separate lstat/read pair lets a symlink be swapped in between.
let installed;
let descriptor;
try {
  descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const stat = fs.fstatSync(descriptor);
  installed = fs.readFileSync(descriptor, 'utf8');
  if (!stat.isFile() || !installed.startsWith('// AGENT_RELAY_PI_EXTENSION='))
    throw new Error(`Preserving another extension at ${path}; move it before installing.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
}
fs.mkdirSync(join(agentDir, 'extensions'), { recursive: true, mode: 0o700 });
if (installed !== source) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, source, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, path);
}
console.log(`Installed ${path}. Run /reload in an existing Pi session, then enable Receives messages in Agent Relay.`);
