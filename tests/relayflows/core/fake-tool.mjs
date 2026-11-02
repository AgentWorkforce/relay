// Runs as a copy of Node named after an agent tool, because the core finds a
// session by its executable's name and the files it holds open. It holds the
// files named on its command line, then runs each command written to its stdin
// as its own child, the way the tool runs a hook.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const held = process.argv.slice(2).map((file) => fs.openSync(file, 'r+'));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { command, input, output } = JSON.parse(line);
  const result = spawnSync('sh', ['-c', command], { input: fs.readFileSync(input) });
  fs.writeFileSync(
    `${output}.tmp`,
    Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)])
  );
  fs.renameSync(`${output}.tmp`, output);
});

process.on('exit', () => held.forEach((descriptor) => fs.closeSync(descriptor)));
