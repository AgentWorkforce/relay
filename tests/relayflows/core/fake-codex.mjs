#!/usr/bin/env node
// `codex app-server` for trusting a hook, which is all `relay init` asks of Codex:
// `hooks/list` from the home's real hooks.json, and `config/value/write`, recorded
// where the scenario can read it. No session or model runs here.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex');
const camel = (event) => event[0].toLowerCase() + event.slice(1);

function listHooks() {
  const file = path.join(home, 'hooks.json');
  const { hooks = {} } = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      group.hooks.map((hook) => ({
        ...hook,
        eventName: camel(event),
        key: `${event}:${hook.command}`,
        currentHash: `hash-${event}`,
        trustStatus: 'untrusted',
      }))
    )
  );
}

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'hooks/list') {
    reply(id, { data: [{ hooks: listHooks() }] });
    return;
  }
  if (method === 'config/value/write') {
    fs.appendFileSync(path.join(home, 'trusted.jsonl'), `${JSON.stringify(params)}\n`);
  }
  reply(id, {});
});
