#!/usr/bin/env node

import { syncBuiltinESMExports } from 'node:module';

const blocked = () => {
  const error = new Error('candidate CLI inventory network access is disabled');
  error.code = 'ERR_ACCESS_DENIED';
  throw error;
};

globalThis.fetch = blocked;
if ('WebSocket' in globalThis) globalThis.WebSocket = blocked;

for (const name of [
  'node:dgram',
  'node:dns',
  'node:dns/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
]) {
  const module = await import(name);
  const api = module.default ?? module;
  for (const key of [
    'connect',
    'createConnection',
    'createServer',
    'get',
    'lookup',
    'lookupService',
    'request',
    'resolve',
    'resolve4',
    'resolve6',
    'send',
  ]) {
    if (typeof api[key] === 'function') api[key] = blocked;
  }
}

syncBuiltinESMExports();
