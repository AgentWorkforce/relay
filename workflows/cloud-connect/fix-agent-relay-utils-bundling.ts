/**
 * fix-agent-relay-utils-bundling.ts
 *
 * ## Problem
 *
 * `npx agent-relay cloud connect openai` fails with:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@agent-relay/utils'
 *   imported from /root/.npm/_npx/.../node_modules/agent-relay/dist/cli/commands/cloud/connect.js
 *
 * But `agent-relay --version` and `agent-relay --help` work fine. The existing
 * post-publish verification suite only exercises `--version` and `--help`, so
 * this regression shipped without being caught.
 *
 * ## Root cause hypothesis
 *
 * `agent-relay/package.json` lists `@agent-relay/utils` in `bundledDependencies`
 * and in `dependencies` (at workspace version). The idea: npm pack should
 * bundle `node_modules/@agent-relay/utils` into the tarball so runtime import
 * resolution finds it.
 *
 * What actually ships (inspected the 3.2.22 tarball installed in cloud repo):
 *
 *   - `packages/utils/dist/` is present (via the `files` array)
 *   - `packages/utils/package.json` is present
 *   - `node_modules/@agent-relay/` directory is NOT present
 *
 * So the `bundledDependencies` mechanism didn't copy anything. The most
 * likely cause: at `npm pack` time, the workspace is symlinked from the root
 * `node_modules/@agent-relay/utils` → `packages/utils` rather than being a
 * real directory. npm's bundledDependencies implementation does not follow
 * symlinks out of the package root by default, so it silently bundles
 * nothing. Code that `import '@agent-relay/utils'` then can't resolve at
 * runtime because there is no `node_modules/@agent-relay/utils` in the
 * installed tarball and the published package.json doesn't declare a
 * `workspaces` config that would make npm install resolve the sibling
 * `packages/utils` directory.
 *
 * (An alternative mechanism would be to use `npm pkg fix` / `exports` + a
 * file: dependency, but we want to keep the bundledDependencies contract
 * rather than re-plumb resolution for all nine workspace packages.)
 *
 * ## Fix strategy
 *
 * The safest fix is to make `prepack` materialize real directories (not
 * symlinks) at `node_modules/@agent-relay/*` before `npm pack` runs, so
 * bundledDependencies copies them into the tarball. Concretely:
 *
 *   1. In `scripts/`, add `prepack-materialize-workspaces.mjs` that:
 *      - For each entry in `package.json#bundledDependencies` starting with
 *        `@agent-relay/`:
 *      - Check `node_modules/<name>` — if it's a symlink, resolve the target,
 *        rm the symlink, and copy the target directory contents (dist, package.json,
 *        README.md if present) into `node_modules/<name>`.
 *      - Exit cleanly if already a real directory.
 *   2. Wire it into `prepack` in `package.json`: run the materialize script
 *      AFTER `npm run build` and BEFORE npm pack completes.
 *   3. Add a `verify-bundled-deps.mjs` script that, post-build, verifies every
 *      entry in bundledDependencies has a real directory at `node_modules/<name>/package.json`.
 *   4. Add a `prepublishOnly` hook that runs `npm pack --dry-run --json`,
 *      parses the file list, and asserts every `node_modules/@agent-relay/<pkg>/package.json`
 *      is present in the pack list. Fail-fast if any are missing.
 *
 * The workflow delegates step 1–4 to agents, then validates with a
 * smoke test that actually runs a cloud-connect-like code path against the
 * just-built tarball.
 *
 * ## Post-publish verification enhancement
 *
 * `scripts/post-publish-verify/verify-install.sh` currently runs only
 * `agent-relay --version`, `--help`, `version`, and SDK require tests. None of
 * these exercise `@agent-relay/utils`. Add Test 6:
 *
 *   - From the installed package directory, run
 *     `node -e "require('agent-relay/dist/cli/commands/cloud/connect.js')"`
 *     (or the equivalent ESM import) and assert it does not throw
 *     ERR_MODULE_NOT_FOUND.
 *   - Additionally, direct-resolve: `require.resolve('@agent-relay/utils', { paths: [packageDir] })`
 *     — this must succeed, otherwise bundledDependencies didn't ship anything.
 *
 * ## Acceptance contract
 *
 *   A1  `node scripts/verify-bundled-deps.mjs` exits 0 and prints OK for every
 *       @agent-relay/* entry in bundledDependencies
 *   A2  `npm pack --dry-run --json` output contains an entry for
 *       `node_modules/@agent-relay/utils/package.json`
 *   A3  After `npm pack && tar -xzf agent-relay-*.tgz -C /tmp/pack-check`,
 *       the extracted `package/node_modules/@agent-relay/utils/dist/index.js`
 *       exists and is non-empty
 *   A4  In a fresh temp dir, `npm install /absolute/path/to/agent-relay-*.tgz`
 *       followed by `node -e "require.resolve('@agent-relay/utils', { paths: ['./node_modules/agent-relay'] })"`
 *       exits 0 with a path printed
 *   A5  `scripts/post-publish-verify/verify-install.sh` contains a new Test 6
 *       block that invokes the cloud-connect dynamic import path and asserts
 *       no ERR_MODULE_NOT_FOUND
 *   A6  `npx tsc --noEmit` is clean
 *   A7  Existing ssh-interactive and cli tests still pass (regression guard)
 *
 * ## Usage
 *
 *   cd /Users/khaliqgant/Projects/AgentWorkforce/relay
 *   agent-relay run workflows/cloud-connect/fix-agent-relay-utils-bundling.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';
import { CodexModels } from '@agent-relay/config';

const PKG_JSON = 'package.json';
const PREPACK_SCRIPT = 'scripts/prepack-materialize-workspaces.mjs';
const VERIFY_SCRIPT = 'scripts/verify-bundled-deps.mjs';
const POST_PUBLISH = 'scripts/post-publish-verify/verify-install.sh';

async function main() {
  const result = await workflow('fix-agent-relay-utils-bundling')
    .description(
      'Ensure @agent-relay/utils (and sibling workspace packages) are actually bundled into the published tarball. Adds prepack materializer, pack-verifier, and post-publish regression test.'
    )
    .pattern('dag')
    .channel('wf-fix-bundling')
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Writes the materialize + verify scripts and wires prepack/prepublishOnly',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Enhances post-publish verification to exercise @agent-relay/utils import path',
      retries: 2,
    })
    .agent('fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Fixes type errors, script failures, and packing issues',
      retries: 2,
    })

    // ── Phase 0: Setup branch ────────────────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: `set -e
BRANCH="fix/cloud-connect-workflows"
CURRENT=$(git branch --show-current)
if [ "$CURRENT" = "$BRANCH" ]; then
  echo "Already on $BRANCH"
else
  git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
fi
echo "BRANCH: $(git branch --show-current)"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 1: Reproduce the bug ───────────────────────────────────
    .step('reproduce-bug', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: `set -e
echo "=== bundledDependencies (expected to list @agent-relay/utils) ==="
node -e "console.log(JSON.stringify(require('./${PKG_JSON}').bundledDependencies, null, 2))"

echo ""
echo "=== current node_modules/@agent-relay/ directory (symlink or real?) ==="
ls -la node_modules/@agent-relay/ 2>&1 | head -30 || echo "(does not exist)"

echo ""
echo "=== what 'npm pack --dry-run' would ship under node_modules/@agent-relay ==="
npm pack --dry-run --json 2>/dev/null | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks).toString());
  const files = (data[0] && data[0].files) || [];
  const hits = files.filter(f => f.path && f.path.includes('node_modules/@agent-relay/'));
  if (hits.length === 0) {
    console.log('REPRO_CONFIRMED: no node_modules/@agent-relay/* entries in pack list');
  } else {
    console.log('UNEXPECTED: pack list contains ' + hits.length + ' @agent-relay node_modules entries:');
    hits.slice(0, 10).forEach(h => console.log('  ' + h.path));
  }
});
"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 2: Implement the prepack materializer ──────────────────
    .step('implement-materialize', {
      agent: 'impl',
      dependsOn: ['reproduce-bug'],
      timeoutMs: 900_000,
      task: `Reproduction output:

{{steps.reproduce-bug.output}}

Write a new script at \`${PREPACK_SCRIPT}\`. It must be a plain Node.js ESM script (\`.mjs\`). Its job is to ensure every \`@agent-relay/*\` package listed in the repo-root \`package.json#bundledDependencies\` exists as a **real directory** at \`node_modules/<pkgname>/\` (not a symlink) before \`npm pack\` runs.

Exact contract:

\`\`\`js
#!/usr/bin/env node
// scripts/prepack-materialize-workspaces.mjs
//
// npm pack's bundledDependencies mechanism only ships real directories under
// node_modules/. In a workspace, node_modules/@agent-relay/<pkg> is typically
// a symlink to packages/<pkg>, and npm pack does not follow symlinks out of
// the package root. Result: bundledDependencies silently ships nothing.
//
// This script runs in prepack, detects any symlinked workspace packages, and
// replaces them with real directories containing dist/, package.json, and
// README.md (if present). The replacement is scoped to a .materialized marker
// so it is idempotent and safe to re-run.

import { readFileSync, readdirSync, statSync, lstatSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];
const targets = bundled.filter((n) => n.startsWith('@agent-relay/'));

if (targets.length === 0) {
  console.log('[prepack-materialize] no @agent-relay/* entries in bundledDependencies — nothing to do');
  process.exit(0);
}

let materialized = 0;
for (const name of targets) {
  const dst = join(ROOT, 'node_modules', name);
  if (!existsSync(dst)) {
    console.error('[prepack-materialize] MISSING: ' + dst + ' — run npm install first');
    process.exit(1);
  }
  const lst = lstatSync(dst);
  if (lst.isDirectory() && !lst.isSymbolicLink()) {
    const marker = join(dst, '.materialized');
    if (existsSync(marker)) {
      console.log('[prepack-materialize] already materialized: ' + name);
      continue;
    }
    // Non-symlink, but not marked. Leave as-is.
    console.log('[prepack-materialize] real dir (unmarked): ' + name);
    continue;
  }
  // It's a symlink — resolve, then replace
  const target = statSync(dst).isDirectory() ? require('node:fs').realpathSync(dst) : null;
  // Using the sync API available in ESM:
  const real = (await import('node:fs/promises')).realpath(dst);
  // (keep both fallbacks working in old node)
  const realPath = target || await real;
  console.log('[prepack-materialize] ' + name + ' → symlink → ' + realPath);

  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });

  // Copy: package.json, dist (if present), README.md (if present)
  const pkgJsonSrc = join(realPath, 'package.json');
  if (!existsSync(pkgJsonSrc)) {
    console.error('[prepack-materialize] ' + name + ' missing package.json at ' + pkgJsonSrc);
    process.exit(1);
  }
  cpSync(pkgJsonSrc, join(dst, 'package.json'));
  if (existsSync(join(realPath, 'dist'))) {
    cpSync(join(realPath, 'dist'), join(dst, 'dist'), { recursive: true });
  }
  if (existsSync(join(realPath, 'README.md'))) {
    cpSync(join(realPath, 'README.md'), join(dst, 'README.md'));
  }
  writeFileSync(join(dst, '.materialized'), 'materialized-by-prepack\\n');
  materialized++;
}

console.log('[prepack-materialize] done — materialized ' + materialized + ' package(s)');
\`\`\`

Feel free to simplify the realpath dance (pick one approach — the \`realpathSync\` sync call is fine for an mjs file). Do NOT add any unrelated features; the script must be tight and auditable.

Also write a second script at \`${VERIFY_SCRIPT}\`:

\`\`\`js
#!/usr/bin/env node
// scripts/verify-bundled-deps.mjs
//
// Post-prepack sanity check: every @agent-relay/* entry in bundledDependencies
// must have a real directory at node_modules/<name>/package.json. Run from
// prepublishOnly to fail the publish if anything is off.

import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const bundled = (pkg.bundledDependencies || pkg.bundleDependencies || []).filter((n) => n.startsWith('@agent-relay/'));

let failed = 0;
for (const name of bundled) {
  const dir = join(ROOT, 'node_modules', name);
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) {
    console.error('[verify-bundled] MISSING package.json: ' + pj);
    failed++;
    continue;
  }
  if (lstatSync(dir).isSymbolicLink()) {
    console.error('[verify-bundled] STILL A SYMLINK: ' + dir + ' — prepack materializer did not run');
    failed++;
    continue;
  }
  console.log('[verify-bundled] OK: ' + name);
}

if (failed > 0) {
  console.error('[verify-bundled] FAIL — ' + failed + ' package(s) not ready for npm pack');
  process.exit(1);
}
console.log('[verify-bundled] all bundled @agent-relay/* packages ready');
\`\`\`

Finally, update \`${PKG_JSON}\`:

1. In \`scripts.prepack\`, append \`&& node scripts/prepack-materialize-workspaces.mjs && node scripts/verify-bundled-deps.mjs\`. Preserve the existing conditional build step — the new form should be:

   \`\`\`
   "prepack": "if [ -d node_modules ]; then npm run build; else echo '⚠ node_modules not found, skipping prepack build'; fi && node scripts/prepack-materialize-workspaces.mjs && node scripts/verify-bundled-deps.mjs"
   \`\`\`

2. Add a \`prepublishOnly\` script: \`"prepublishOnly": "node scripts/verify-bundled-deps.mjs"\`.

Do NOT modify any other script, dependency, or version field. End your message with IMPL_DONE.`,
      verification: { type: 'output_contains', value: 'IMPL_DONE' },
    })

    // ── Phase 3: Verify scripts landed ───────────────────────────────
    .step('verify-impl', {
      type: 'deterministic',
      dependsOn: ['implement-materialize'],
      command: `set -e
test -f ${PREPACK_SCRIPT} || (echo "MISSING ${PREPACK_SCRIPT}"; exit 1)
test -f ${VERIFY_SCRIPT} || (echo "MISSING ${VERIFY_SCRIPT}"; exit 1)

node -e "const s = require('./${PKG_JSON}').scripts; if (!s.prepack.includes('prepack-materialize-workspaces')) { console.error('prepack not wired'); process.exit(1); } if (!s.prepublishOnly || !s.prepublishOnly.includes('verify-bundled-deps')) { console.error('prepublishOnly not wired'); process.exit(1); } console.log('PKG_SCRIPTS_OK');"

echo "VERIFY_IMPL_OK"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Run the verifier (dry — pre-materialize) ────────────
    .step('run-verify-before', {
      type: 'deterministic',
      dependsOn: ['verify-impl'],
      command: `node ${VERIFY_SCRIPT} 2>&1 || echo "(expected failure pre-materialize)"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 5: Run the materializer ────────────────────────────────
    .step('run-materialize', {
      type: 'deterministic',
      dependsOn: ['run-verify-before'],
      command: `node ${PREPACK_SCRIPT} 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-materialize', {
      agent: 'fixer',
      dependsOn: ['run-materialize'],
      timeoutMs: 600_000,
      task: `Materialize script output:

{{steps.run-materialize.output}}

If the script printed "done — materialized" or "already materialized" and exited 0, do nothing and end with MATERIALIZE_OK.

If it crashed (TypeError, ReferenceError, ENOENT, etc.), read ${PREPACK_SCRIPT}, find the bug, fix it, and re-run \`node ${PREPACK_SCRIPT}\`. Iterate until it's green. End with MATERIALIZE_OK.`,
      verification: { type: 'exit_code' },
    })

    .step('run-verify-after', {
      type: 'deterministic',
      dependsOn: ['fix-materialize'],
      command: `node ${VERIFY_SCRIPT} 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 6: npm pack smoke — does the tarball actually contain utils? ──
    .step('pack-smoke', {
      type: 'deterministic',
      dependsOn: ['run-verify-after'],
      command: `set -e
rm -f agent-relay-*.tgz
# Skip the build step to keep this fast — we just care about the pack list
SKIP_BUILD=1 npm pack --dry-run --json 2>/dev/null > /tmp/pack-dry.json || npm pack --dry-run --json > /tmp/pack-dry.json
node -e "
const data = JSON.parse(require('fs').readFileSync('/tmp/pack-dry.json', 'utf8'));
const files = (data[0] && data[0].files) || [];
const utilsEntries = files.filter(f => f.path && f.path.startsWith('node_modules/@agent-relay/utils/'));
if (utilsEntries.length === 0) {
  console.error('PACK_SMOKE_FAIL: no node_modules/@agent-relay/utils entries in pack list');
  console.error('sample pack entries:');
  files.slice(0, 20).forEach(f => console.error('  ' + f.path));
  process.exit(1);
}
console.log('PACK_SMOKE_OK — ' + utilsEntries.length + ' utils entries in pack list');
utilsEntries.slice(0, 5).forEach(e => console.log('  ' + e.path));
"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 7: Enhance post-publish verification ───────────────────
    .step('enhance-post-publish', {
      agent: 'tester',
      dependsOn: ['pack-smoke'],
      timeoutMs: 600_000,
      task: `Edit \`${POST_PUBLISH}\`. Add a new test block (Test 6) near the end of the file, BEFORE the \`# Summary\` section.

The current script only runs \`agent-relay --version\` / \`--help\` / SDK require tests. None of these load any code that imports \`@agent-relay/utils\`, so the ERR_MODULE_NOT_FOUND bug ships unnoticed.

Add this block (bash, using the existing log_header / record_pass / record_fail helpers and the existing \`TEST_PROJECT_DIR\` and installed \`./node_modules/agent-relay\`):

\`\`\`bash
# ============================================
# Test 6: @agent-relay/utils resolution (regression guard for bundledDependencies)
# ============================================
log_header "Test 6: @agent-relay/utils resolution"

log_info "Verifying @agent-relay/utils resolves from installed agent-relay..."
UTILS_RESOLUTION=$(node -e "
try {
    const path = require('path');
    const pkgDir = path.dirname(require.resolve('agent-relay/package.json'));
    const resolved = require.resolve('@agent-relay/utils', { paths: [pkgDir] });
    console.log('RESOLVED:', resolved);
    console.log('UTILS_RESOLVE_OK');
} catch (e) {
    console.log('UTILS_RESOLVE_FAIL:', e.code || e.message);
}
" 2>&1) || true

log_info "Utils resolution output: $UTILS_RESOLUTION"
if echo "$UTILS_RESOLUTION" | grep -q "UTILS_RESOLVE_OK"; then
    record_pass "@agent-relay/utils resolves from installed agent-relay"
else
    record_fail "@agent-relay/utils is NOT resolvable — bundledDependencies regression"
fi

log_info "Dynamic-import smoke test for cloud connect code path..."
CLOUD_CONNECT_SMOKE=$(node --input-type=module -e "
try {
    await import('agent-relay/dist/cli/commands/cloud/connect.js');
    console.log('CLOUD_CONNECT_IMPORT_OK');
} catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
        console.log('CLOUD_CONNECT_IMPORT_FAIL:', e.message);
    } else {
        // A different error (e.g. expecting argv) is fine — the module loaded
        console.log('CLOUD_CONNECT_IMPORT_OK_WITH_RUNTIME_ERR');
    }
}
" 2>&1) || true

log_info "Cloud connect import output: $CLOUD_CONNECT_SMOKE"
if echo "$CLOUD_CONNECT_SMOKE" | grep -q "CLOUD_CONNECT_IMPORT_OK"; then
    record_pass "cloud connect module imports without ERR_MODULE_NOT_FOUND"
elif echo "$CLOUD_CONNECT_SMOKE" | grep -q "CLOUD_CONNECT_IMPORT_FAIL"; then
    record_fail "cloud connect import FAILED with ERR_MODULE_NOT_FOUND: $CLOUD_CONNECT_SMOKE"
else
    log_warn "cloud connect import had unknown outcome: $CLOUD_CONNECT_SMOKE"
    record_fail "cloud connect import indeterminate"
fi
\`\`\`

Important notes:
- The exact path \`agent-relay/dist/cli/commands/cloud/connect.js\` may not exist in the current build output — before committing, \`ls node_modules/agent-relay/dist/cli/commands/cloud/\` in the current repo (from the test project dir used by earlier Tests 3–5) to discover the actual exported entry. If \`connect.js\` isn't there, pick any file that transitively imports \`@agent-relay/utils\` — you can grep \`dist/\` for \`require("@agent-relay/utils")\` or the ESM equivalent to find a known-good target.
- Preserve all existing test blocks; only add Test 6.
- Make sure the \`Summary\` section and \`exit $TESTS_FAILED\` logic still sees the new pass/fail counts (using \`record_pass\` / \`record_fail\` handles this automatically).

End your message with POST_PUBLISH_DONE.`,
      verification: { type: 'output_contains', value: 'POST_PUBLISH_DONE' },
    })

    .step('verify-post-publish', {
      type: 'deterministic',
      dependsOn: ['enhance-post-publish'],
      command: `set -e
grep -q "Test 6: @agent-relay/utils resolution" ${POST_PUBLISH} || (echo "MISSING Test 6 block"; exit 1)
grep -q "UTILS_RESOLVE_OK" ${POST_PUBLISH} || (echo "MISSING resolve assertion"; exit 1)
grep -q "CLOUD_CONNECT_IMPORT" ${POST_PUBLISH} || (echo "MISSING cloud-connect import assertion"; exit 1)
bash -n ${POST_PUBLISH} || (echo "SHELL SYNTAX ERROR"; exit 1)
echo "POST_PUBLISH_VERIFY_OK"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 8: Full regression — typecheck and existing tests ───────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-post-publish'],
      command: `npx tsc --noEmit 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-typecheck', {
      agent: 'fixer',
      dependsOn: ['typecheck'],
      timeoutMs: 600_000,
      task: `Typecheck output:
{{steps.typecheck.output}}

If EXIT: 0, do nothing and end with TYPECHECK_OK.
Otherwise the script edits introduced a new typecheck error. Fix it in the smallest possible diff. The new .mjs files should not be typechecked by tsc — if they are, either exclude them from tsconfig or add an appropriate jsconfig/JSDoc stub. Re-run \`npx tsc --noEmit\`. End with TYPECHECK_OK.`,
      verification: { type: 'exit_code' },
    })

    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: `npx tsc --noEmit 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
    })

    .step('regression-cli-tests', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: `npx vitest run src/cli 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'fixer',
      dependsOn: ['regression-cli-tests'],
      timeoutMs: 600_000,
      task: `Vitest output:
{{steps.regression-cli-tests.output}}

If all green, end with NO_REGRESSIONS.
If anything broke, the bundling changes should not have touched src/ — investigate and fix the root cause. End with NO_REGRESSIONS.`,
      verification: { type: 'exit_code' },
    })

    .step('regression-cli-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: `npx vitest run src/cli 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 9: Summary ─────────────────────────────────────────────
    .step('summary', {
      type: 'deterministic',
      dependsOn: ['regression-cli-tests-final'],
      command: `echo "=== Files changed ==="
git status --short
echo ""
echo "=== Diff summary ==="
git diff --stat
echo ""
echo "All green. The tarball will now ship node_modules/@agent-relay/utils"
echo "and the post-publish verifier will catch this regression class going forward."`,
      captureOutput: true,
      failOnError: false,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 5_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log('Steps completed:', Object.keys(result.steps || {}));
  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch((error) => {
  console.error('Workflow failed:', error);
  process.exit(1);
});
