import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { declaredFlowName, flowDeclarations } from './deploy-listeners.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-listeners-'));
function flowFile(name, source) {
  const file = path.join(dir, name);
  writeFileSync(file, source);
  return file;
}

describe('declaredFlowName', () => {
  it('reads the name from the flow(...) declaration', () => {
    assert.equal(declaredFlowName('flows/ci/pr-proof.flow.ts'), 'relay.ci.pr-proof');
  });

  it('reads a generic declaration split across lines', () => {
    const file = flowFile(
      'generic.flow.ts',
      `import { flow } from '@relayflows/surface';\nexport default flow<Input>(\n  "relay.ci.other",\n  { budget: {} },\n  (f) => f.done()\n);\n`
    );
    assert.equal(declaredFlowName(file), 'relay.ci.other');
  });

  it('ignores the managed name in comments once the declaration is renamed', () => {
    // The raw-text guard this replaces accepted this file: the old name still
    // appears in a comment and an unrelated literal, but the listener would be
    // created under the new name and never reconciled.
    const file = flowFile(
      'renamed.flow.ts',
      [
        '/**',
        " * relay.ci.pr-proof — the header still names the old flow: flow('relay.ci.pr-proof').",
        ' */',
        "import { flow } from '@relayflows/surface';",
        "// flow('relay.ci.pr-proof')",
        "const context = 'relay.ci.pr-proof';",
        "export default flow<Input>('relay.ci.pr-proof-v2', (f) => f.run('echo', { context }));",
        '',
      ].join('\n')
    );
    assert.equal(declaredFlowName(file), 'relay.ci.pr-proof-v2');
  });

  it('ignores flow(...) text inside string literals and trailing inline comments', () => {
    const file = flowFile(
      'strings.flow.ts',
      [
        "import { flow } from '@relayflows/surface';",
        "const help = \"see flow('relay.ci.pr-proof') for the old shape\"; // flow('relay.ci.pr-proof')",
        'const tpl = `flow("relay.ci.pr-proof")`;',
        "const escaped = 'it\\'s flow(\"relay.ci.pr-proof\")';",
        "export default flow<Input>('relay.ci.pr-proof-v2', (f) => f.run(help + tpl + escaped));",
        '',
      ].join('\n')
    );
    assert.equal(declaredFlowName(file), 'relay.ci.pr-proof-v2');
  });

  it('reads a call whose identifier is flow and nothing else', () => {
    assert.deepEqual(flowDeclarations("reflow('a'); flows('b'); flow ( 'c' ); x.flow('d')"), ['c', 'd']);
    assert.deepEqual(flowDeclarations('flow<Input<Extra>>(\n  "e",\n)'), ['e']);
  });

  it('refuses a file that declares no flow or more than one', () => {
    const none = flowFile('none.flow.ts', "export const name = 'relay.ci.pr-proof';\n");
    assert.throws(() => declaredFlowName(none), /exactly one flow\(\.\.\.\); found 0/);
    const two = flowFile(
      'two.flow.ts',
      "export const a = flow('relay.ci.pr-proof', () => {});\nexport const b = flow('relay.ci.pr-proof', () => {});\n"
    );
    assert.throws(() => declaredFlowName(two), /exactly one flow\(\.\.\.\); found 2/);
  });
});
