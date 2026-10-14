import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { sessionStatusSchemas } from '../dist/work.js';
import { communicationStatusSchemas } from '../dist/communication.js';
for (const [file, owner, types, fixture] of [
  ['session-work', 'work', sessionStatusSchemas, 'session-status'],
  ['communication-status', 'communication', communicationStatusSchemas, 'communication-status'],
]) {
  const output =
    JSON.stringify(
      {
        schemaVersion: 1,
        owner: `@agent-relay/status/${owner}`,
        types: Object.fromEntries(
          Object.entries(types).map(([name, schema]) => [name, z.toJSONSchema(schema)])
        ),
        fixtures: JSON.parse(
          readFileSync(new URL(`../fixtures/${fixture}.v1.json`, import.meta.url), 'utf8')
        ),
      },
      null,
      2
    ) + '\n';
  const path = new URL(`../contracts/${file}.v1.json`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw Error(`Contract drift: ${file}`);
  } else writeFileSync(path, output);
}
