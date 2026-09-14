import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureTypeStrippingRuntime } from './node-runtime.mjs';

const caseId = '1593-receipt-reachability';
const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `Missing ${name}`);
  return value;
};
const arm = required('RELAY_PR_PROOF_ARM');
assert.ok(arm === 'base' || arm === 'head', 'Invalid proof arm');
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const sha = (directory) =>
  execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(sha(targetDir), required(`RELAY_PR_PROOF_${arm.toUpperCase()}_SHA`));
assert.equal(sha(harnessDir), required('RELAY_PR_PROOF_HEAD_SHA'));
assert.equal(
  fileURLToPath(import.meta.url),
  path.join(harnessDir, 'tests', 'relayflows', 'cases', caseId, 'run.mjs')
);

const replacementExitCode = ensureTypeStrippingRuntime({
  moduleApi: nodeModule,
  scriptPath: fileURLToPath(import.meta.url),
});
if (replacementExitCode !== undefined) process.exit(replacementExitCode);

// Evaluate the target checkout's actual dependency-free receipt implementation.
// Type stripping changes no runtime logic. Node 22 before 22.13 uses the pinned
// runtime bootstrap above; a runtime already exposing the API needs no install.
const source = await readFile(
  path.join(targetDir, 'packages/cli/src/cli/lib/message-delivery-receipts.ts'),
  'utf8'
);
const code = nodeModule.stripTypeScriptTypes(source, { mode: 'strip' });
const { directMessageReceipt, compactDirectMessageReceipt, directMessageDeliveryFailure } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const matched = compactDirectMessageReceipt(
  directMessageReceipt({ id: 'probe-queued', text: 'body-canary' }, 'worker', 'wait', 'worker')
);
const mismatch = directMessageReceipt({ id: 'probe-mismatch' }, 'worker', 'wait', 'wrong-worker');
const unresolved = directMessageReceipt({ id: 'probe-unresolved' }, 'worker');
assert.equal(matched.id, 'probe-queued');
assert.equal(matched.delivery.status, 'queued_unconfirmed');
assert.equal(matched.delivery.readConfirmed, false);
assert.equal(directMessageDeliveryFailure(matched), undefined);
assert.equal(JSON.stringify(matched).includes('body-canary'), false);
assert.equal(mismatch.delivery.recipientMatched, false);
assert.equal(mismatch.delivery.status, 'recipient_mismatch');
assert.ok(directMessageDeliveryFailure(mismatch).includes('probe-mismatch'));
assert.equal(unresolved.delivery.recipientMatched, null);
assert.equal(unresolved.delivery.status, 'recipient_unresolved');
assert.ok(directMessageDeliveryFailure(unresolved).includes('probe-unresolved'));

const bug = matched.delivery.recipientMatched === true;
const fixed =
  matched.delivery.recipientMatched === null &&
  matched.delivery.directoryMatched === true &&
  matched.delivery.deliveryConfirmed === false;
assert.ok(bug || fixed, 'Unexpected receipt behavior; cannot classify as expected red or green');
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  JSON.stringify(
    {
      version: 1,
      caseId,
      arm,
      outcome: bug ? 'bug' : 'fixed',
      signature: bug
        ? 'directory_match_claims_recipient_match'
        : 'directory_match_preserves_delivery_uncertainty',
      details: JSON.stringify({
        matched,
        mismatchStatus: mismatch.delivery.status,
        unresolvedStatus: unresolved.delivery.status,
      }),
    },
    null,
    2
  ) + '\n'
);
