import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOPICS } from './client.js';
import { ERROR_KINDS, REFUSAL_REASONS } from './errors.js';
import { BRIDGE_VERSION, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, coreSocketPath, pipeName } from './paths.js';
import {
  SPAWN_ERROR_CODES,
  SPAWN_INVOKE_KEYS,
  SPAWN_RELEASE_KEYS,
  SPAWN_STATUSES,
  SPAWN_STATUS_KEYS,
  type SpawnControlInvocation,
  type SpawnControlTarget,
} from './spawn.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const relay = path.join(repoRoot, 'crates/relay-node/src/relay');
const read = (file: string) => fs.readFileSync(path.join(relay, file), 'utf8');

/** The body of `pub <kind> <name> { … }` in Rust source. */
function block(source: string, kind: 'enum' | 'struct', name: string): string {
  const start = source.indexOf(`pub ${kind} ${name} {`);
  expect(start, `${kind} ${name}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}', start));
}

const snake = (variant: string) => variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const variants = (body: string) => [...body.matchAll(/^\s+([A-Z]\w*),$/gm)].map((m) => snake(m[1]));
const fields = (body: string) => [...body.matchAll(/^\s+pub (\w+):/gm)].map((m) => m[1]);
function constant(source: string, name: string): number {
  const match = source.match(new RegExp(`pub const ${name}: \\w+ = ([\\d\\s*]+);`));
  expect(match, name).not.toBeNull();
  return match![1].split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
}

describe('core socket', () => {
  it('defaults to the desktop socket under home, as the core does', () => {
    expect(coreSocketPath({}, '/home/me')).toBe('/home/me/.agentworkforce/desktop/core.sock');
  });

  it('honours AGENT_RELAY_CORE_SOCKET, a relative one beside the default', () => {
    expect(coreSocketPath({ AGENT_RELAY_CORE_SOCKET: '/run/x.sock' }, '/home/me')).toBe('/run/x.sock');
    expect(coreSocketPath({ AGENT_RELAY_CORE_SOCKET: 'core.dev.sock' }, '/home/me')).toBe(
      '/home/me/.agentworkforce/desktop/core.dev.sock'
    );
    expect(coreSocketPath({ AGENT_RELAY_CORE_SOCKET: '  ' }, '/home/me')).toBe(
      '/home/me/.agentworkforce/desktop/core.sock'
    );
  });

  it('derives the Windows pipe exactly as the core does (relay::transport tests share the vector)', () => {
    const expected = '\\\\.\\pipe\\agent-relay-367ccf5106272db6';
    expect(pipeName('C:\\Users\\A\\.agentworkforce\\desktop\\core.sock')).toBe(expected);
    expect(pipeName('c:/users/a/.agentworkforce/desktop/core.sock')).toBe(expected);
    expect(pipeName('\\\\?\\C:\\Users\\A\\.agentworkforce\\desktop\\core.sock')).toBe(expected);
    expect(pipeName('C:\\Users\\A\\.agentworkforce\\desktop\\core.sock\\\\')).toBe(expected);
  });
});

describe('contract drift against crates/relay-node', () => {
  const protocol = read('protocol.rs');

  it('speaks the bridge version the core declares', () => {
    expect(protocol).toContain(`pub const BRIDGE_VERSION: u32 = ${BRIDGE_VERSION};`);
  });

  it('caps requests and replies as the core does', () => {
    expect(constant(protocol, 'MAX_FRAME_BYTES')).toBe(MAX_REQUEST_BYTES);
    expect(constant(protocol, 'MAX_REPLY_BYTES')).toBe(MAX_REPLY_BYTES);
  });

  it('knows every topic and error kind', () => {
    expect([...TOPICS]).toEqual(variants(block(protocol, 'enum', 'Topic')));
    expect([...ERROR_KINDS]).toEqual(variants(block(protocol, 'enum', 'ErrorKind')));
  });

  it('knows every refusal reason', () => {
    // RefusalReason arrives with the spawn callers hook; until it is on this
    // base there is nothing to compare. `other` is the core's own fallback for
    // a reason it does not know, never a reason of its own.
    if (!protocol.includes('pub enum RefusalReason {')) return;
    const reasons = variants(block(protocol, 'enum', 'RefusalReason')).filter((r) => r !== 'other');
    expect([...REFUSAL_REASONS]).toEqual(reasons);
  });

  it('sends exactly the spawn params structs, which deny unknown fields', () => {
    const contract = read('contract/spawn_control.rs');
    const pairs = [
      [SPAWN_INVOKE_KEYS, 'SpawnInvokeParams'],
      [SPAWN_STATUS_KEYS, 'SpawnInvocationParams'],
      [SPAWN_RELEASE_KEYS, 'SpawnReleaseParams'],
    ] as const;
    for (const [keys, struct] of pairs) {
      // No params struct carries a credential: a service caller binds its
      // connection with authenticate() and names no caller.
      expect(keys, struct).not.toContain('caller_secret');
      expect(keys[0], struct).toBe('caller_name');
      expect(fields(block(contract, 'struct', struct)), struct).toEqual([...keys]);
    }
    expect(variants(block(contract, 'enum', 'SpawnControlAction'))).toEqual(['spawn', 'release']);
  });

  it('types every spawn result field', () => {
    const contract = read('contract/spawn_control.rs');
    const target: SpawnControlTarget = {
      id: 'n',
      name: 'n',
      live: true,
      handlers_live: true,
      stale: false,
      capabilities: [],
      active_agents: 0,
      reserved_agents: 0,
      max_agents: 1,
    };
    const invocation: SpawnControlInvocation = {
      id: 'i',
      agent_id: null,
      status: 'pending',
      node_id: null,
      name: null,
      spawned: false,
      ready: false,
      released: false,
      task_unconfirmed: false,
      error_code: null,
    };
    expect(Object.keys(target)).toEqual(fields(block(contract, 'struct', 'SpawnControlTarget')));
    const rust = fields(block(contract, 'struct', 'SpawnControlInvocation'));
    // Until the core's released field (relay spawn projection) is on this
    // base, the rest must still match field for field; once it is, exactly.
    const keys = Object.keys(invocation);
    expect(rust).toEqual(rust.includes('released') ? keys : keys.filter((k) => k !== 'released'));
  });

  it('knows every spawn status and error code the core lets through', () => {
    const control = read('spawn/control.rs');
    const statuses = control.match(/\["pending"[^\]]*\]/);
    expect(statuses).not.toBeNull();
    expect([...SPAWN_STATUSES]).toEqual([...statuses![0].matchAll(/"(\w+)"/g)].map((m) => m[1]));
    const known = control.slice(control.indexOf('let known ='), control.indexOf('.contains(&candidate)'));
    expect([...SPAWN_ERROR_CODES]).toEqual([...known.matchAll(/"(\w+)"/g)].map((m) => m[1]));
  });
});
