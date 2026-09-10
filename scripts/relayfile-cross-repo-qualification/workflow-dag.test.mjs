import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./workflow.ts', import.meta.url), 'utf8');

test('capture-integrity is a hard prerequisite for the first Claude review', () => {
  assert.match(source, /wf\.step\('capture-integrity',[\s\S]*?dependsOn: \['aggregate-evidence'\]/);
  assert.match(
    source,
    /const deps = \(step: string\) =>[\s\S]*?\? \[previous, step, 'capture-integrity'\] : \[step, 'capture-integrity'\]/
  );
  assert.match(source, /wf\.step\(`\$\{provider\}-review`,[\s\S]*?dependsOn: deps\('aggregate-evidence'\)/);
});

test('verify-integrity receives the captured digest before the config flag', () => {
  assert.match(source, /command\('verify-integrity\.mjs', '\{\{steps\.capture-integrity\.output\}\}'\)/);
  assert.doesNotMatch(source, /command\('verify-integrity\.mjs'\)\}\s+"\{\{steps\.capture-integrity\.output\}\}"/);
});
