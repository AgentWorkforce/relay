import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

/**
 * The merge-train sweeper (AgentWorkforce/cloud packages/web/lib/merge-train)
 * and these workflows share three names: the label that runs promotion CI
 * (`ci:run`), the check every promotion CI run creates (the sweeper's "CI ran
 * on this head" marker, `changes / Detect change scope`), and the feature ready
 * check (`Merge-train ready check`, kicked by `ready:check`). A rename on either
 * side silently breaks the gate, so they are pinned here.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.github/workflows');
const load = (file) => parse(readFileSync(path.join(DIR, file), 'utf8'));

/** The complete trunk-PR + ci:run gate. Asserted exactly, never as a substring. */
const TRUNK_CI_GATE =
  "(github.event_name != 'pull_request' && github.event_name != 'pull_request_target') || (github.head_ref == 'trunk' && github.event.pull_request.head.repo.full_name == github.repository && github.base_ref == 'main' && (github.event.action != 'labeled' || github.event.label.name == 'ci:run'))";
const IGNORED_GROUP =
  "(github.event.action == 'labeled' && github.event.label.name != 'ci:run') && format('ignored-{0}', github.run_id)";
const PROMOTION_TYPES = ['opened', 'reopened', 'labeled'];

/** True when `expr` has an `||` outside any parentheses. */
function hasTopLevelOr(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    if (expr[i] === '(') depth += 1;
    else if (expr[i] === ')') depth -= 1;
    else if (depth === 0 && expr.startsWith('||', i)) return true;
  }
  return false;
}

/**
 * A job gate is exactly the trunk gate, or `(gate) && <extra>` where <extra>
 * cannot reopen the gate with a top-level `||`.
 */
function assertGate(gate, where) {
  const value = String(gate ?? '').trim();
  if (value === TRUNK_CI_GATE) return;
  const prefix = `(${TRUNK_CI_GATE}) && `;
  assert.ok(value.startsWith(prefix), `${where}: must be the exact trunk PR + ci:run gate, got ${value}`);
  assert.ok(
    !hasTopLevelOr(value.slice(prefix.length)),
    `${where}: an extra condition must not add a top-level ||`
  );
}

const workflows = readdirSync(DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, workflow: load(file) }));
// Every workflow that runs CI on pull requests, except the guard and the
// closed-PR cleanup, is promotion CI.
const promotion = workflows.filter(({ file, workflow }) => {
  const on = workflow.on ?? {};
  const prEvents = ['pull_request', 'pull_request_target'].filter((event) => event in on);
  if (prEvents.length === 0 || file === 'trunk-guard.yml' || file === 'merge-train-ready.yml') return false;
  const closedOnly = (event) => {
    const types = on[event]?.types ?? [];
    return types.length > 0 && types.every((type) => type === 'closed');
  };
  return !prEvents.every(closedOnly);
});

test('every promotion workflow runs the trunk PR only on opened/reopened/ci:run, never on synchronize', () => {
  assert.ok(promotion.length >= 15, `expected the promotion workflows, found ${promotion.length}`);
  for (const { file, workflow } of promotion) {
    for (const event of ['pull_request', 'pull_request_target']) {
      if (!(event in workflow.on)) continue;
      assert.deepEqual(workflow.on[event]?.types, PROMOTION_TYPES, `${file} ${event}`);
    }
    for (const [id, job] of Object.entries(workflow.jobs)) {
      // A job with `needs` and no `if` is skipped whenever its gated parent skips.
      if (!job.if && job.needs) continue;
      assertGate(job.if, `${file} ${id}`);
    }
  }
});

test('an unrelated label event can never cancel a real promotion CI run', () => {
  for (const { file, workflow } of promotion) {
    if (!workflow.concurrency) continue;
    const { group } = workflow.concurrency;
    assert.ok(String(group).includes(IGNORED_GROUP), `${file}: throwaway group for ignored labels`);
  }
});

test("the sweeper's CI marker is a job every promotion CI run creates", () => {
  const job = load('test.yml').jobs.changes;
  assert.equal(job.uses, './.github/workflows/detect-changes.yml');
  assert.equal(job.needs, undefined);
  assertGate(job.if, 'test.yml changes');
  assert.equal(load('detect-changes.yml').jobs.changes.name, 'Detect change scope');
});

test('feature PRs into trunk get the ready check the sweeper requires', () => {
  const ready = load('merge-train-ready.yml');
  assert.deepEqual(Object.keys(ready.on), ['pull_request']);
  assert.deepEqual(ready.on.pull_request.branches, ['trunk']);
  assert.deepEqual(ready.on.pull_request.types, ['labeled', 'synchronize', 'reopened']);
  assert.equal(
    ready.concurrency.group,
    "merge-train-ready-${{ contains(github.event.pull_request.labels.*.name, 'mergeable') && format('pr-{0}', github.event.pull_request.number) || format('ignored-{0}', github.run_id) }}"
  );
  const jobs = Object.values(ready.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.name, 'Merge-train ready check');
  assert.match(job.if, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'mergeable'\)/);
  // Fork PRs get the check too (no secrets under `pull_request`); trust is the sweeper's gate.
  assert.doesNotMatch(job.if, /head\.repo\.full_name/);
  assert.doesNotMatch(readFileSync(path.join(DIR, 'merge-train-ready.yml'), 'utf8'), /secrets\./);
  assert.equal(job.steps[0].with?.['persist-credentials'], false);
  // The sweeper kicks missing runs with `ready:check`: the job runs on ANY label event.
  assert.doesNotMatch(job.if, /event\.label\.name/);
});
