#!/usr/bin/env node
/**
 * Deterministic gates for the native-delivery migration
 * (`docs/native-delivery-migration.md`).
 *
 * This file is the campaign's single source of truth. `PHASES` below states,
 * per phase, exactly which paths may change, which sources must exist, which
 * feature-manifest rows must be registered, which invariant tests must be
 * named, and which suites must be green. `flows/migrate/native-delivery.spec.ts`
 * imports `PHASES` and compiles it into a Relayflows v2 spec, so the flow and
 * the gates cannot drift apart.
 *
 * Every verdict here is computed from recorded evidence, never from an agent's
 * word. `record` runs a command, captures exit code and output tail, and writes
 * `evidence/<name>.json`; `require-green` reads those files back. An agent that
 * wants a green gate has to make the command pass.
 *
 *   node scripts/migrate/native-delivery-gates.mjs <action> --phase <n> \
 *     --artifact <dir> --run-id <id> [action options]
 *
 * Actions: preflight, contract, record, require-green, require-artifacts,
 * edit-gate, manifest-gate, targeted-gate, seam-rules, unlaunched-gate,
 * seal, accept, commit-if-green.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const MANIFEST = '.agentworkforce/features/manifest.yaml';
const MATRIX = 'tests/relayflows/cleanroom/relay.matrix.json';
const PLANNER = 'scripts/verify-features/targeted-pr-plan.mjs';

/**
 * The five suites the migration doc names as the readiness gate. They assert
 * PTY behaviour today; the whole point is that the same assertions pass with
 * the backend swapped, so every phase reruns all five.
 */
const PARITY = {
  'parity-orch-to-worker': 'npx tsx tests/parity/orch-to-worker.ts',
  'parity-multi-worker': 'npx tsx tests/parity/multi-worker.ts',
  'parity-broadcast': 'npx tsx tests/parity/broadcast.ts',
  'parity-continuity-handoff': 'npx tsx tests/parity/continuity-handoff.ts',
  'parity-stability-soak': 'npx tsx tests/parity/stability-soak.ts',
};

/**
 * The four seam rules from Phase 0 of the doc, as test names that must exist
 * and pass. Naming them here is what stops "we thought about double delivery"
 * from passing as "double delivery cannot happen".
 */
const SEAM_INVARIANTS = [
  'falls_back_only_before_write',
  'never_resends_on_doubt',
  'records_route_for_each_send',
  'never_acks_without_observation',
];

const INVARIANT_TEST_FILE = 'crates/broker/tests/delivery_seam_invariants.rs';

/** Phases, ordered as the doc orders them. Phase 6 is independent. */
export const PHASES = {
  0: {
    slug: 'seam',
    title: 'Delivery-backend seam beside the PTY injector',
    /**
     * The lane, widened four times — each time because a gate this campaign
     * owns demanded an edit the lane forbade.
     *
     * `node_control.rs` and `worker.rs` are the last two, and they are not
     * scope creep: R2-1's repair needs the fleet ACK cursor to express
     * "never confirmable" (`abandon_unconfirmed_delivery`), and R2-2's needs a
     * real write-commit boundary in the PTY worker. Both were identified by
     * adversarial review as REQUIRED to satisfy the seam rules, so a lane that
     * excluded them made the phase unsatisfiable by construction.
     */
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/src/broker/',
      'crates/broker/src/lib.rs',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
      'crates/broker/src/node_control.rs',
      'crates/broker/src/worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: [
      'crates/broker/src/delivery/mod.rs',
      'crates/broker/src/delivery/backend.rs',
      'crates/broker/src/delivery/pty.rs',
      INVARIANT_TEST_FILE,
    ],
    features: [
      {
        id: 'delivery-backend-seam',
        category: 'broker',
        location: 'crates/broker/src/delivery/',
        verify_tier: 6,
      },
    ],
    /**
     * The exit criterion is "the PTY injector becomes ONE IMPLEMENTATION", not
     * "a trait exists". The first run produced a trait, a coordinator and four
     * passing invariant tests with nothing behind them: no code path called the
     * seam and the PTY backend wrote nothing. `edit-gate` passed it — files
     * changed, required sources present — and the shadow reviewer caught what
     * the gate could not, that a green parity suite on that tree cannot
     * distinguish "seam works" from "seam absent".
     *
     * A signal that an artifact EXISTS never proves anything ACTS on it. So the
     * consumer is named here, by file.
     */
    wiring: [{ symbol: 'DeliveryBackend', from: 'crates/broker/src/runtime/delivery.rs' }],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {},
    unlaunched: false,
    exit: 'The parity suite is green, unchanged, with the PTY backend behind the new trait.',
  },
  1: {
    slug: 'codex-queue',
    title: 'Codex native delivery over `codex queue`',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/src/codex_thread.rs',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml', MATRIX],
    requiredSources: [
      'crates/broker/src/delivery/codex_queue.rs',
      'crates/broker/src/codex_thread.rs',
      INVARIANT_TEST_FILE,
    ],
    requiredArtifacts: ['decisions/D1-codex-thread-id.md'],
    features: [
      {
        id: 'codex-queue-delivery',
        category: 'broker',
        location: 'crates/broker/src/delivery/codex_queue.rs, crates/broker/src/codex_thread.rs',
        verify_tier: 4,
      },
    ],
    wiring: [{ symbol: 'CodexQueueBackend', outside: 'crates/broker/src/delivery/codex_queue.rs' }],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'eval-codex':
        'npm run eval:build && cd tests/integration/broker && RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --harness=codex',
    },
    e2e: {},
    unlaunched: ['codex'],
    exit: 'Parity plus `eval:matrix` for codex, plus a delivery into a codex session relay did not launch.',
  },
  2: {
    slug: 'claude-native',
    title: 'Claude terminal inbox socket and `--cloud` delivery',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/src/claude_registry.rs',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml', MATRIX],
    requiredSources: [
      'crates/broker/src/delivery/claude_socket.rs',
      'crates/broker/src/delivery/claude_cloud.rs',
      'crates/broker/src/claude_registry.rs',
      INVARIANT_TEST_FILE,
    ],
    features: [
      {
        id: 'claude-socket-delivery',
        category: 'broker',
        location: 'crates/broker/src/delivery/claude_socket.rs, crates/broker/src/claude_registry.rs',
        verify_tier: 4,
      },
      {
        id: 'claude-cloud-delivery',
        category: 'broker',
        location: 'crates/broker/src/delivery/claude_cloud.rs',
        verify_tier: 5,
      },
    ],
    wiring: [
      { symbol: 'ClaudeSocketBackend', outside: 'crates/broker/src/delivery/claude_socket.rs' },
      { symbol: 'ClaudeCloudBackend', outside: 'crates/broker/src/delivery/claude_cloud.rs' },
    ],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'eval-claude':
        'npm run eval:build && cd tests/integration/broker && RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --harness=claude',
    },
    e2e: {},
    unlaunched: ['claude'],
    exit: 'Parity plus `eval:claude`, plus a delivery into a claude session relay did not launch.',
  },
  3: {
    slug: 'acp',
    title: 'One ACP backend for grok, opencode and devin',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/delivery/acp.rs', INVARIANT_TEST_FILE],
    features: [
      {
        id: 'acp-delivery',
        category: 'harnesses',
        location: 'crates/broker/src/delivery/acp.rs',
        verify_tier: 4,
      },
    ],
    wiring: [{ symbol: 'AcpBackend', outside: 'crates/broker/src/delivery/acp.rs' }],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'eval-acp-harnesses':
        'npm run eval:build && cd tests/integration/broker && RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --harness=grok,opencode,devin',
    },
    e2e: {},
    unlaunched: false,
    exit: '`eval:matrix` per ACP harness, with the PTY still green for everything else.',
  },
  4: {
    slug: 'pty-retained',
    title: 'What stays on the PTY: muse and cursor-agent',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/delivery/routing.rs', INVARIANT_TEST_FILE],
    features: [
      {
        id: 'delivery-route-selection',
        category: 'broker',
        location: 'crates/broker/src/delivery/routing.rs',
        verify_tier: 2,
      },
    ],
    wiring: [{ symbol: 'select_route', outside: 'crates/broker/src/delivery/routing.rs' }],
    invariants: [...SEAM_INVARIANTS, 'muse_and_cursor_select_pty'],
    /**
     * `muse session-message` refuses outsiders with `sender_unverified`. The
     * doc calls that a security boundary, not an obstacle, so any attempt to
     * spoof past it fails this phase outright.
     */
    forbidden: [{ pattern: 'sender_unverified', where: 'crates/broker/src/delivery/', unless: 'refuse' }],
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {},
    unlaunched: false,
    exit: 'Route selection provably picks the PTY for muse and cursor-agent, and the muse ancestry check is untouched.',
  },
  5: {
    slug: 'detached-spawn',
    title: 'Decouple spawning from wrapping',
    scope: [
      'crates/broker/src/spawner.rs',
      'crates/broker/src/delivery/',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', 'packages/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/spawner.rs', INVARIANT_TEST_FILE],
    features: [
      {
        id: 'detached-agent-spawn',
        category: 'local-agents',
        location: 'crates/broker/src/spawner.rs',
        verify_tier: 4,
      },
    ],
    /** The four things the doc says must survive detachment. */
    wiring: [{ symbol: 'DeliveryBackend', from: 'crates/broker/src/spawner.rs' }],
    invariants: [
      ...SEAM_INVARIANTS,
      'detached_spawn_keeps_parent_lineage',
      'detached_spawn_emits_agent_spawned',
      'detached_spawn_records_spawn_source',
      'detached_spawn_keeps_workforce_metadata',
    ],
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {
      'e2e-fleet': 'npx vitest run --config vitest.e2e.config.ts tests/e2e/fleet',
    },
    unlaunched: false,
    exit: 'The two-node fleet matrix and the stability soak pass with detached, natively-delivered agents.',
  },
  6: {
    slug: 'config-hygiene',
    title: 'Stop writing into user config for grok, opencode and cursor',
    scope: ['crates/broker/src/snippets.rs', 'crates/broker/src/cli_mcp_args.rs', 'crates/broker/tests/'],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/cli_mcp_args.rs', 'crates/broker/tests/config_isolation.rs'],
    features: [
      {
        id: 'cli-config-isolation',
        category: 'harnesses',
        location: 'crates/broker/src/cli_mcp_args.rs, crates/broker/src/snippets.rs',
        verify_tier: 1,
      },
    ],
    invariants: [
      'grok_uses_isolated_config_home',
      'opencode_does_not_write_workspace_config',
      'cursor_does_not_write_workspace_config',
      'gemini_and_droid_are_untouched',
    ],
    invariantTestFile: 'crates/broker/tests/config_isolation.rs',
    /**
     * Out of scope per the doc. A diff here means the phase overreached.
     */
    untouched: ['configure_gemini_droid_mcp'],
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {},
    unlaunched: false,
    exit: 'No grok, opencode or cursor launch mutates a file the user owns, and gemini/droid are byte-identical.',
  },
};

/**
 * Tests already failing on this tree before the campaign touched it.
 *
 * A regression gate asks "did I break anything", not "is the repo perfect".
 * Demanding a wholly green suite makes the gate unsatisfiable for reasons that
 * have nothing to do with the change, and the usual escape — deleting or
 * skipping the test — is exactly the weakening this campaign forbids.
 *
 * Every entry is justified, and the justification is that the change cannot
 * reach it: `git status --porcelain -- <subject>` reports zero changed files
 * for each subject below. Re-derive that before adding a row. A row is a
 * standing claim that a failure is someone else's, so it must be cheap to
 * disprove.
 */
const KNOWN_FAILURES = [
  {
    match: "reports the child's pid the moment it is spawned",
    why: 'packages/harness-driver unchanged; the test spawns a stub shell script, never the broker binary, so no Rust change can reach it. Fails on a 200ms startup budget under load.',
  },
  {
    match: 'reaps the broker child when startup never reports an API port',
    why: 'Same file, same stub-script fixture, same 200ms budget.',
  },
  {
    match: 'derives the current-main command surface without conflating it',
    why: 'packages/cli/src/cli/commands unchanged; asserts a CLI command-surface inventory count (expects 36, tree has 35).',
  },
];

/**
 * Pass when every failing test is a declared known failure. New failures are
 * the regression this gate exists to catch; a known failure that has started
 * passing is reported but not fatal.
 */
function regressionGate() {
  const art = artifactRoot();
  const name = option('--name', 'unit-tests');
  const file = path.join(art, 'evidence', `${name}.json`);
  if (!existsSync(file)) {
    fail(`regression-gate: ${name} never ran`);
    return;
  }
  const evidence = readJson(file);
  const failing = [
    ...new Set(
      (evidence.tail.match(/^\s*FAIL\s+.+$/gm) ?? []).map((line) => line.replace(/^\s*FAIL\s+/, '').trim())
    ),
  ];
  const unexplained = failing.filter((entry) => !KNOWN_FAILURES.some((known) => entry.includes(known.match)));
  if (unexplained.length > 0) {
    fail(
      `regression-gate ${name}: ${unexplained.length} failure(s) not in the known-failure baseline\n  ` +
        unexplained.join('\n  ')
    );
    return;
  }
  const fixed = KNOWN_FAILURES.filter((known) => !failing.some((entry) => entry.includes(known.match)));
  pass(
    `regression-gate ${name} failing=${failing.length} all-known` +
      (fixed.length > 0
        ? ` (${fixed.length} baseline entr${fixed.length === 1 ? 'y' : 'ies'} now passing — prune it)`
        : '')
  );
}

// ───────────────────────────── plumbing ─────────────────────────────

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function list(name) {
  const raw = option(name, '');
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function phaseConfig() {
  const phase = option('--phase');
  const config = PHASES[phase];
  if (!config) throw new Error(`unknown phase ${phase}; known: ${Object.keys(PHASES).join(', ')}`);
  return { phase, config };
}

function artifactRoot() {
  const dir = option('--artifact');
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  return dir;
}

/**
 * Every verdict is also appended to `<artifact>/gate-log.txt`.
 *
 * Not belt-and-braces: a gate invoked as a Relayflows `subprocess_gate` runs
 * under `stdio: 'inherit'`, and the daemon's stdio is captured nowhere — the
 * journal records `exit=1` with empty stdout and stderr tails, and
 * `relayflowd.log` stays empty too (AgentWorkforce/flows#511). Writing the
 * verdict to a file is the only way such a failure stays diagnosable.
 */
function journal(line) {
  const index = process.argv.indexOf('--artifact');
  if (index < 0) return;
  const dir = process.argv[index + 1];
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'gate-log.txt'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A gate must never fail because its own audit line could not be written.
  }
}

function fail(message) {
  process.stderr.write(`GATE_FAILED ${message}\n`);
  journal(`GATE_FAILED ${message.replace(/\n\s*/g, ' | ')}`);
  process.exitCode = 1;
}

function pass(message) {
  process.stdout.write(`GATE_PASSED ${message}\n`);
  journal(`GATE_PASSED ${message}`);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Files this campaign has touched, relative to the repo root.
 *
 * Working-tree status ALONE is wrong: it goes blind the moment the work is
 * committed, and `edit-gate` then reports NO_CHANGES for a branch full of
 * changes. So the campaign's recorded base (context.json `baseSha`, or
 * `--base`) is diffed as well, and the two sets are merged — uncommitted work
 * counts before the commit, committed work counts after it.
 */
function changedFiles() {
  const committed = (() => {
    const explicit = process.argv.indexOf('--base');
    let base = explicit >= 0 ? process.argv[explicit + 1] : undefined;
    if (!base) {
      const index = process.argv.indexOf('--artifact');
      const contextPath = index >= 0 ? path.join(process.argv[index + 1] ?? '', 'context.json') : '';
      if (contextPath && existsSync(contextPath)) base = readJson(contextPath).baseSha;
    }
    if (!base) return [];
    try {
      // `main` rather than the recorded sha when the sha is an ancestor of the
      // campaign's own tooling commits: the merge-base is what the PR diffs.
      const mergeBase = execFileSync('git', ['merge-base', 'HEAD', base], { encoding: 'utf8' }).trim();
      return execFileSync('git', ['diff', '--name-only', mergeBase], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  })();
  return [...new Set([...committed, ...workingTreeChanges()])].sort();
}

/** Uncommitted changes, tracked or not. */
function workingTreeChanges() {
  const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  const out = new Set();
  const entries = porcelain.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename carries its source in the following NUL-separated field.
    if (status.includes('R')) index += 1;
    if (file) out.add(file);
  }
  return [...out].sort();
}

function withinScope(file, scope) {
  return scope.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

// ───────────────────────────── actions ─────────────────────────────

/**
 * Establish that the run can produce a mergeable result at all: a real repo,
 * a phase branch rather than main, a toolchain, and no pre-existing block.
 * Everything here is an external blocker in the 80-to-100 sense — the flow
 * cannot repair a missing cargo, so it refuses up front rather than failing
 * halfway through.
 */
function preflight() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const runId = option('--run-id');
  const problems = [];

  let branch = '';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    problems.push('not a git repository');
  }
  const wanted = `feat/native-delivery-phase-${phase}-${config.slug}`;
  if (branch === 'main' || branch === 'master') {
    // CLAUDE.md: never work on main. Branching is the one mutation preflight
    // performs, because the alternative is a run that cannot be merged safely.
    git(['checkout', '-b', wanted]);
    branch = wanted;
  }

  for (const [tool, args] of [
    ['git', ['--version']],
    ['node', ['--version']],
    ['npx', ['--version']],
  ]) {
    try {
      execFileSync(tool, args, { stdio: 'ignore' });
    } catch {
      problems.push(`missing required tool: ${tool}`);
    }
  }
  if (config.rust) {
    const cargo = process.env.CARGO ?? `${process.env.HOME}/.cargo/bin/cargo`;
    if (!existsSync(cargo)) {
      try {
        execFileSync('cargo', ['--version'], { stdio: 'ignore' });
      } catch {
        problems.push('phase needs a Rust toolchain and cargo is not on PATH');
      }
    }
  }
  for (const file of [MANIFEST, MATRIX, PLANNER, 'docs/native-delivery-migration.md']) {
    if (!existsSync(file)) problems.push(`missing campaign input: ${file}`);
  }
  if (existsSync(path.join(art, 'BLOCKED_NO_COMMIT.md'))) {
    problems.push('a previous run left BLOCKED_NO_COMMIT.md; resolve and clear it before rerunning');
  }

  const baseSha = git(['rev-parse', 'HEAD']);
  writeJson(path.join(art, 'context.json'), {
    schemaVersion: 1,
    kind: 'native-delivery-context',
    runId,
    phase: Number(phase),
    slug: config.slug,
    title: config.title,
    exit: config.exit,
    branch,
    baseSha,
    startedAt: new Date().toISOString(),
  });

  if (problems.length > 0) {
    writeFileSync(
      path.join(art, 'BLOCKED_NO_COMMIT.md'),
      `# Blocked before implementation\n\nrun: ${runId}\nphase: ${phase} (${config.slug})\n\n` +
        problems.map((problem) => `- ${problem}`).join('\n') +
        '\n'
    );
    fail(`preflight: ${problems.join('; ')}`);
    return;
  }
  pass(`preflight phase=${phase} slug=${config.slug} branch=${branch} base=${baseSha}`);
}

/**
 * Write the phase contract agents read. Nothing here is negotiable by an
 * agent: it is `PHASES` rendered to disk so a prompt can point at a file
 * instead of restating rules that would then drift.
 */
function contract() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  writeJson(path.join(art, 'phase-contract.json'), {
    schemaVersion: 1,
    kind: 'native-delivery-phase-contract',
    phase: Number(phase),
    ...config,
    parityCommands: Object.fromEntries((config.parity ?? []).map((name) => [name, PARITY[name]])),
    seamRules: [
      'Fall back to another transport only on a strictly pre-write error.',
      'Never re-send on doubt.',
      'Record which route each send took, and settle by that route’s rules.',
      'Never claim an acknowledgement you did not observe.',
    ],
  });
  pass(`contract phase=${phase}`);
}

/** Run one command through /bin/bash, collecting combined output. */
function runOnce(command, chunks) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: '/bin/bash', env: process.env });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(Buffer.from(`spawn error: ${error.message}\n`));
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
}

/**
 * Run a command and journal its real result. The step that calls this always
 * exits 0 so a red command becomes repair work rather than a dead run; the
 * truth lives in the evidence file that `require-green` and `accept` read.
 */
async function record() {
  const art = artifactRoot();
  const name = option('--name');
  // Commands carry `&&`, pipes and quotes. Base64 has nothing for the calling
  // shell to reinterpret, so the command the flow wrote is the command that
  // runs. `-- <argv>` stays available for hand-invocation.
  const encoded = process.argv.indexOf('--command-base64');
  const separator = process.argv.indexOf('--');
  const command =
    encoded >= 0
      ? Buffer.from(process.argv[encoded + 1] ?? '', 'base64').toString('utf8')
      : separator >= 0
        ? process.argv.slice(separator + 1).join(' ')
        : '';
  if (!command.trim()) throw new Error('record needs `--command-base64 <b64>` or `-- <command>`');
  const expect = list('--expect');
  const forbid = list('--forbid');

  /**
   * Re-run a red command this many times before recording the result.
   *
   * This does NOT weaken the gate: the command must still pass, and the
   * recorded verdict is the final attempt's. It only stops a transient
   * failure from being treated as a regression.
   *
   * Earned: the five parity suites run back to back, and that contention makes
   * `broadcast` report `Verified: 2/3, Failed: 0` — one verification arriving
   * outside the window, nothing actually failing. It passes 3/3 on three
   * consecutive standalone runs. Without a retry, that flake killed a run 35
   * steps deep whose real regression had just been fixed.
   */
  const retries = Number(option('--retry-on-red', '0'));
  const startedAt = Date.now();
  let chunks = [];
  let exitCode = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    chunks = [];
    exitCode = await runOnce(command, chunks);
    if (exitCode === 0) {
      if (attempt > 0) chunks.push(Buffer.from(`\n[record] passed on attempt ${attempt + 1}\n`));
      break;
    }
    if (attempt < retries) {
      process.stdout.write(`RETRY ${name} attempt ${attempt + 1} exited ${exitCode}; re-running\n`);
    }
  }
  const output = Buffer.concat(chunks).toString('utf8');
  const missing = expect.filter((marker) => !output.includes(marker));
  const present = forbid.filter((marker) => output.includes(marker));
  const verdict = exitCode === 0 && missing.length === 0 && present.length === 0 ? 'green' : 'red';

  writeJson(path.join(art, 'evidence', `${name}.json`), {
    schemaVersion: 1,
    kind: 'native-delivery-evidence',
    name,
    /**
     * The run that produced this. A `record` step always exits 0 so a red
     * command becomes repair work, which also makes every recorder step
     * REUSABLE by `flows run --reuse-from` — the step succeeded even though the
     * command it wrapped did not. Reuse then carries the old evidence file
     * forward untouched, and a later gate reads a verdict from a tree that no
     * longer exists. Observed: run g reused `ts-typecheck` from run f and kept
     * its exit=2, recorded before the missing workspace link that caused it was
     * repaired.
     *
     * Stamping lets a gate say so. `final-evidence` re-records everything
     * before acceptance, so the flow already self-heals; this makes a stale
     * read visible instead of silent.
     */
    runId: option('--run-id', 'unknown'),
    command,
    exitCode,
    verdict,
    missingExpected: missing,
    forbiddenPresent: present,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    // Enough context to diagnose, bounded so a soak log cannot fill the disk.
    tail: output.slice(-20_000),
  });
  process.stdout.write(`EVIDENCE ${name} verdict=${verdict} exit=${exitCode}\n`);
  process.stdout.write(`${output.slice(-4_000)}\n`);
}

/** Read recorded evidence back. This is the only thing that says "green". */
function requireGreen() {
  const art = artifactRoot();
  const names = list('--names');
  if (names.length === 0) throw new Error('--names is required');
  const problems = [];
  for (const name of names) {
    const file = path.join(art, 'evidence', `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`${name}: never ran`);
      continue;
    }
    let evidence;
    try {
      evidence = readJson(file);
    } catch (error) {
      problems.push(`${name}: unreadable evidence (${error.message})`);
      continue;
    }
    if (evidence.kind !== 'native-delivery-evidence' || evidence.name !== name) {
      problems.push(`${name}: evidence identity does not match`);
      continue;
    }
    const runId = option('--run-id', 'unknown');
    if (evidence.runId !== undefined && evidence.runId !== runId) {
      process.stdout.write(
        `STALE_EVIDENCE ${name} was recorded by run "${evidence.runId}", not "${runId}"\n`
      );
    }
    if (evidence.verdict !== 'green') {
      const detail = [
        `exit=${evidence.exitCode}`,
        evidence.missingExpected?.length ? `missing=${evidence.missingExpected.join('|')}` : '',
        evidence.forbiddenPresent?.length ? `forbidden=${evidence.forbiddenPresent.join('|')}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      problems.push(`${name}: ${detail}`);
    }
  }
  if (problems.length > 0) {
    fail(`require-green\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`require-green ${names.join(',')}`);
}

/** Named artifacts must exist and carry real content, not a placeholder. */
function requireArtifacts() {
  const art = artifactRoot();
  const names = list('--names');
  const problems = [];
  for (const name of names) {
    const file = path.join(art, name);
    if (!existsSync(file)) {
      problems.push(`${name}: missing`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    if (text.trim().length < 200) problems.push(`${name}: too short to be a real artifact`);
    if (text.includes('native-delivery-permission-placeholder'))
      problems.push(`${name}: still a placeholder`);
  }
  if (problems.length > 0) {
    fail(`require-artifacts\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`require-artifacts ${names.join(',')}`);
}

/**
 * Did the implementation actually land, and did it stay inside its lane?
 * `git status --short` rather than `git diff --quiet`, because a new backend
 * module is an untracked file and `git diff` cannot see it.
 */
function editGate() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const which = option('--scope', 'all');
  const scope =
    which === 'rust'
      ? config.scope
      : which === 'ts'
        ? (config.tsScope ?? [])
        : [...config.scope, ...(config.tsScope ?? [])];
  const files = changedFiles();
  const inScope = files.filter((file) => withinScope(file, scope));
  const problems = [];

  if (inScope.length === 0) problems.push(`NO_CHANGES under ${scope.join(', ')}`);

  if (which !== 'rust') {
    for (const source of config.requiredSources ?? []) {
      if (!existsSync(source)) problems.push(`required source missing: ${source}`);
    }
    for (const artifact of config.requiredArtifacts ?? []) {
      if (!existsSync(path.join(art, artifact))) problems.push(`required artifact missing: ${artifact}`);
    }
    // Anything outside the declared lane is scope creep, and scope creep in a
    // delivery migration is how double-delivery ships.
    const allowed = [
      ...config.scope,
      ...(config.tsScope ?? []),
      '.workflow-artifacts/',
      'scripts/migrate/',
      'flows/migrate/',
      // The harness adapter and the e2e wiring the phase needed: campaign
      // tooling, not product, and so not manifest-routable either.
      'scripts/flows/',
      'package.json',
      'vitest.e2e.config.ts',
      '.gitignore',
      // Trail writes these as agents work; CLAUDE.md requires them tracked, so
      // they are legitimate output of a run rather than scope creep.
      '.agentworkforce/trajectories/',
      'CHANGELOG.md',
      'docs/',
    ];
    const strays = files.filter((file) => !withinScope(file, allowed));
    if (strays.length > 0) problems.push(`out-of-scope changes: ${strays.slice(0, 20).join(', ')}`);
  }

  writeJson(path.join(art, 'changed-files.json'), files);
  if (problems.length > 0) {
    fail(`edit-gate phase=${phase} scope=${which}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`edit-gate phase=${phase} scope=${which} files=${inScope.length}`);
}

/**
 * #1812's selector fails closed: an unmapped runtime path drops the PR into
 * the complete smoke profile. So every new backend file has to be routed by a
 * manifest `location:` in the same change that introduces it, and the phase's
 * declared feature rows have to exist with the criticality the doc requires.
 */
function manifestGate() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const manifest = parseYaml(readFileSync(MANIFEST, 'utf8'));
  const categories = manifest?.categories ?? {};
  const problems = [];

  const byId = new Map();
  const locations = [];
  for (const [category, value] of Object.entries(categories)) {
    for (const feature of value?.features ?? []) {
      byId.set(feature.id, { ...feature, category, criticality: value.criticality });
      for (const location of String(feature.location ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        locations.push(location);
      }
    }
  }

  for (const declared of config.features ?? []) {
    const feature = byId.get(declared.id);
    if (!feature) {
      problems.push(`feature not registered: ${declared.id} (expected in category ${declared.category})`);
      continue;
    }
    if (feature.category !== declared.category)
      problems.push(`${declared.id}: category ${feature.category}, expected ${declared.category}`);
    // "Delivery is critical" — the doc's words, enforced.
    if (feature.criticality !== 'critical' && declared.category === 'broker')
      problems.push(
        `${declared.id}: category ${feature.category} is ${feature.criticality}, delivery must be critical`
      );
    if (Number(feature.verify_tier) < Number(declared.verify_tier))
      problems.push(
        `${declared.id}: verify_tier ${feature.verify_tier} is below the required ${declared.verify_tier}`
      );
    for (const wanted of String(declared.location)
      .split(',')
      .map((entry) => entry.trim())) {
      if (!String(feature.location ?? '').includes(wanted))
        problems.push(`${declared.id}: location does not route ${wanted}`);
    }
  }

  // Every changed runtime file in this phase's lane must be routed by some
  // location, or the selector will fall back to the full smoke profile.
  const runtime = changedFiles().filter(
    (file) =>
      withinScope(file, config.scope) || (file.startsWith('packages/') && /\.(ts|tsx|mjs|js)$/.test(file))
  );
  const unrouted = runtime.filter(
    (file) =>
      !locations.some((location) => (location.endsWith('/') ? file.startsWith(location) : location === file))
  );
  if (unrouted.length > 0) problems.push(`unrouted runtime files: ${unrouted.join(', ')}`);

  writeJson(path.join(art, 'manifest-gate.json'), { phase: Number(phase), unrouted, problems });
  if (problems.length > 0) {
    fail(`manifest-gate phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`manifest-gate phase=${phase} features=${(config.features ?? []).length}`);
}

/**
 * Run the real selector over this phase's changed files.
 *
 * The verdict is NOT "mode must be targeted". A PR that registers a new feature
 * must edit `manifest.yaml`, and editing it trips the selector's own self-check
 * (`targeted-pr-plan.mjs:242-259`, `selfCheckChanged`), which forces
 * `full-smoke` unconditionally. Requiring `targeted` would therefore be
 * unsatisfiable for exactly the changes this campaign produces — the first run
 * to reach this gate proved it, with `unmatchedRuntimeFiles: []` and the
 * phase's feature correctly selected.
 *
 * What actually matters is the hazard the migration doc names: an UNMAPPED
 * runtime path. So the gate reads the plan's own fields rather than its mode.
 */
function targetedGate() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const filesJson = path.join(art, 'changed-files.json');
  const planPath = path.join(art, 'targeted-plan.json');
  writeJson(filesJson, changedFiles());
  try {
    execFileSync('node', [PLANNER, 'plan', '--files-json', filesJson, '--output', planPath], {
      stdio: 'inherit',
    });
  } catch (error) {
    fail(`targeted-gate: planner refused (${error.message})`);
    return;
  }
  const plan = readJson(planPath);
  const problems = [];

  /**
   * The doc's actual requirement: every new PRODUCT runtime file is routed.
   *
   * The campaign's own harness is not a product feature and has no manifest
   * row to earn — registering it would be inventing a feature to silence a
   * check. It is excluded here by the same paths `edit-gate` allows, and
   * nowhere else, so a stray product file still fails.
   */
  // Same set edit-gate allows: campaign tooling is not a product feature and
  // has no manifest row to earn.
  const HARNESS = [
    'scripts/migrate/',
    'flows/migrate/',
    'scripts/flows/',
    'package.json',
    'vitest.e2e.config.ts',
    '.gitignore',
  ];
  const unmatched = (plan.unmatchedRuntimeFiles ?? []).filter(
    (file) => !HARNESS.some((prefix) => file.startsWith(prefix))
  );
  if (unmatched.length > 0) {
    problems.push(`unmapped runtime paths, so every migration PR runs a full smoke: ${unmatched.join(', ')}`);
  }

  // The phase's declared features must be the ones the selector picked up.
  const selected = new Set(plan.selectedFeatures ?? []);
  for (const feature of config.features ?? []) {
    if (!selected.has(feature.id)) problems.push(`selector did not select ${feature.id}`);
  }

  // A full-smoke for any reason OTHER than the manifest self-check is real.
  if (plan.mode === 'full-smoke' && plan.fallbackReason) {
    problems.push(`selector fell back to full-smoke: ${plan.fallbackReason}`);
  }
  if (plan.mode === 'skip') {
    problems.push('selector found nothing to verify, which cannot be right for a delivery change');
  }

  if (problems.length > 0) {
    fail(`targeted-gate phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(
    `targeted-gate phase=${phase} mode=${plan.mode} features=${[...selected].join(',')} ` +
      `unmapped=0 scenarios=${plan.scenarios.length}` +
      (plan.mode === 'full-smoke' ? ' (full-smoke from the manifest self-check, which is expected)' : '')
  );
}

function seamRules() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const problems = [];
  const testFile = config.invariantTestFile ?? INVARIANT_TEST_FILE;

  if (!existsSync(testFile)) {
    problems.push(`invariant test file missing: ${testFile}`);
  } else {
    const source = readFileSync(testFile, 'utf8');
    for (const invariant of config.invariants ?? []) {
      if (!new RegExp(`fn\\s+${invariant}\\s*\\(`).test(source))
        problems.push(`invariant test not defined: ${invariant}`);
    }
  }

  for (const rule of config.forbidden ?? []) {
    const dir = rule.where;
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(rule.pattern) && !text.includes(rule.unless))
        problems.push(`${file} touches ${rule.pattern} without ${rule.unless}`);
    }
  }

  for (const symbol of config.untouched ?? []) {
    const diff = execFileSync('git', ['diff', 'HEAD', '--unified=0', '--', 'crates/broker/src/snippets.rs'], {
      encoding: 'utf8',
    });
    if (diff.includes(symbol)) problems.push(`${symbol} is declared out of scope but appears in the diff`);
  }

  /**
   * Wiring: the seam has to be reachable from the real path, not merely
   * compiled. Grep is crude and it is exactly the right crudeness here — the
   * question is "does any file outside this module name the symbol", and a
   * false pass needs someone to write the name somewhere it does nothing.
   */
  for (const rule of config.wiring ?? []) {
    if (rule.from) {
      if (!existsSync(rule.from)) {
        problems.push(`wiring target missing: ${rule.from} must reference ${rule.symbol}`);
      } else if (!readFileSync(rule.from, 'utf8').includes(rule.symbol)) {
        problems.push(
          `${rule.symbol} is never referenced from ${rule.from}: the seam compiles but nothing routes through it`
        );
      }
      continue;
    }
    const callers = walk('crates/broker/src')
      .concat(existsSync('crates/broker/tests') ? walk('crates/broker/tests') : [])
      .filter((file) => file !== rule.outside && file.endsWith('.rs'))
      .filter((file) => readFileSync(file, 'utf8').includes(rule.symbol));
    if (callers.length === 0) {
      problems.push(`${rule.symbol} is defined in ${rule.outside} and referenced nowhere else`);
    }
  }

  /**
   * Mutation scaffolding must not survive the proof that used it.
   *
   * This gate exists because it already happened. The campaign requires a
   * mutation transcript — mutate the guarded code, watch the test fail, restore
   * it — and an implementation did the first two steps and skipped the third,
   * leaving this on a LIVE delivery path in shipping code:
   *
   *   // MUTATION: drop the addressee and truncate the body.
   *   if std::env::var("RELAY_MUTATION_LOSSY_FORMAT").is_ok() {
   *       return format!("Relay message from {}:\n\n{}", delivery.from, &delivery.body[..1]);
   *   }
   *
   * `&body[..1]` panics on a multi-byte first character. Every deterministic
   * gate in this campaign passed it; only the adversarial reviewer caught it
   * (claude-review-1, F1).
   *
   * A requirement that induces a hazard has to gate the hazard too.
   */
  const mutationResidue = [];
  for (const dir of ['crates/broker/src', 'crates/relay-pty/src']) {
    if (!existsSync(dir)) continue;
    for (const file of walk(dir).filter((entry) => entry.endsWith('.rs'))) {
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (/RELAY_MUTATION|^\s*\/\/\s*MUTATION\b/.test(line)) {
          mutationResidue.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
  }
  if (mutationResidue.length > 0) {
    problems.push(
      `mutation scaffolding left in product source — restore the code after proving the test bites:\n    ` +
        mutationResidue.join('\n    ')
    );
  }

  // The standing order in this repo: a test that cannot fail is not evidence.
  const mutation = path.join(art, 'evidence', 'mutation-proof.md');
  if (!existsSync(mutation)) {
    problems.push(
      'evidence/mutation-proof.md missing: mutate the guarded code and paste the failing transcript'
    );
  } else {
    const text = readFileSync(mutation, 'utf8');
    for (const invariant of config.invariants ?? []) {
      const index = text.indexOf(invariant);
      if (index === -1) {
        problems.push(`mutation-proof.md does not name invariant: ${invariant}`);
        continue;
      }
      const nextIndex = (config.invariants ?? [])
        .filter((candidate) => candidate !== invariant)
        .map((candidate) => text.indexOf(candidate, index + invariant.length))
        .filter((candidateIndex) => candidateIndex !== -1)
        .sort((a, b) => a - b)[0];
      const section = text.slice(index, nextIndex ?? text.length);
      if (!/FAILED|panicked|assertion .*failed|test result: FAILED/.test(section)) {
        problems.push(`mutation-proof.md has no failing transcript for invariant: ${invariant}`);
      }
    }
  }

  if (problems.length > 0) {
    fail(`seam-rules phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`seam-rules phase=${phase} invariants=${(config.invariants ?? []).length}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * The gate the doc says does not exist yet: a scenario that delivers into a
 * session relay did not launch. Without it there is no proof of the thing the
 * migration is for, so it is a first-class gate rather than a nice-to-have.
 */
function unlaunchedGate() {
  const { phase, config } = phaseConfig();
  if (!config.unlaunched) {
    pass(`unlaunched-gate phase=${phase} not-required`);
    return;
  }
  const matrix = readJson(MATRIX);
  const problems = [];
  const smokeLanes = new Set(matrix.profiles?.smoke?.lanes ?? []);
  for (const cli of config.unlaunched) {
    const id = `unlaunched-${cli}-delivery`;
    const lane = (matrix.lanes ?? []).find((candidate) =>
      (candidate.scenarios ?? []).some((scenario) => scenario.id === id)
    );
    if (!lane) {
      problems.push(`scenario missing from ${MATRIX}: ${id}`);
      continue;
    }
    const scenario = lane.scenarios.find((candidate) => candidate.id === id);
    if (!smokeLanes.has(lane.id))
      problems.push(`${id} sits in lane ${lane.id}, which is not in the smoke profile`);
    if (scenario.kind === 'coverage-gap')
      problems.push(`${id} is still declared a coverage-gap, not an executable scenario`);
    if (scenario.evidence !== 'integration')
      problems.push(`${id} evidence is ${scenario.evidence}, must be integration`);
    if (!Array.isArray(scenario.command) || scenario.command.length === 0)
      problems.push(`${id} has no command`);
    if (!(scenario.forbidOutput ?? []).includes('# SKIP'))
      problems.push(`${id} must forbid "# SKIP" so a skipped test cannot read as a pass`);
  }
  if (problems.length > 0) {
    fail(`unlaunched-gate phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`unlaunched-gate phase=${phase} clis=${config.unlaunched.join(',')}`);
}

/** Hash every artifact so a reviewer reviews a fixed set, not a moving one. */
function seal() {
  const { phase } = phaseConfig();
  const art = artifactRoot();
  const label = option('--label', 'final');
  const files = walk(art)
    .filter((file) => !file.endsWith(`seal-${label}.json`))
    .sort();
  const entries = files.map((file) => ({
    path: path.relative(art, file),
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }));
  /**
   * Hash the PRODUCT tree too, not just the evidence directory.
   *
   * Sealing only the artifacts means a reviewer signs off on a digest of
   * evidence FILES, while the source those files describe can change
   * afterwards without disturbing the digest. Raised as a valid finding
   * against this harness by codex-fix-1 (F7/F2): "the seal implementation
   * still hashes artifact files rather than recomputing and hashing every
   * changed product path immediately before acceptance."
   *
   * Computed at seal time from the live tree, so `artifactSetSha256` now
   * changes if either the evidence or the code moves.
   */
  const sourceEntries = changedFiles()
    .filter((file) => existsSync(file) && statSync(file).isFile())
    .map((file) => ({
      path: file,
      bytes: statSync(file).size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    }));
  const setDigest = createHash('sha256')
    .update([...entries, ...sourceEntries].map((entry) => `${entry.path}:${entry.sha256}`).join('\n'))
    .digest('hex');
  writeJson(path.join(art, `seal-${label}.json`), {
    schemaVersion: 1,
    kind: 'native-delivery-seal',
    phase: Number(phase),
    label,
    sealedAt: new Date().toISOString(),
    headSha: git(['rev-parse', 'HEAD']),
    artifactSetSha256: setDigest,
    entries,
    sourceEntries,
  });
  pass(`seal label=${label} digest=${setDigest} artifacts=${entries.length} source=${sourceEntries.length}`);
}

/**
 * Final acceptance. Recomputed from evidence and signoffs, never from a
 * summary. This is the step that decides whether a commit is allowed.
 */
function accept() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const problems = [];

  if (existsSync(path.join(art, 'BLOCKED_NO_COMMIT.md'))) problems.push('BLOCKED_NO_COMMIT.md is present');

  /**
   * Say so, loudly, when the campaign's own harness changed during the run.
   *
   * `scripts/migrate/` is in edit-gate's allowed set because it IS campaign
   * tooling, and that has already paid off once: an agent found that the
   * mutation-proof check accepted a single failing transcript for any one
   * invariant and tightened it to require one per invariant. A real hole,
   * correctly closed.
   *
   * The same door lets a gate be WEAKENED to pass, which would be far worse and
   * would look identical from inside the run. This does not forbid the edit —
   * forbidding it would have cost the fix above — it records it, so a harness
   * change reaches the acceptance record and the signoff reviewers instead of
   * passing silently. The seal already hashes these files; this names them.
   */
  const harnessChanged = changedFiles().filter(
    (file) => file.startsWith('scripts/migrate/') || file.startsWith('flows/migrate/')
  );
  if (harnessChanged.length > 0) {
    process.stdout.write(
      `HARNESS_MODIFIED during this campaign: ${harnessChanged.join(', ')}\n` +
        '  Review these as carefully as product code: a gate edited to pass is indistinguishable\n' +
        '  from a gate edited to be correct, from inside the run.\n'
    );
  }

  const required = [
    'rust-fmt',
    'rust-clippy',
    'rust-build',
    'invariant-tests',
    'ts-typecheck',
    'unit-tests',
    ...(config.parity ?? []),
    ...Object.keys(config.evals ?? {}),
    ...Object.keys(config.e2e ?? {}),
  ].filter((name) => (config.rust ? true : !name.startsWith('rust-')));

  for (const name of required) {
    const file = path.join(art, 'evidence', `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`evidence missing: ${name}`);
      continue;
    }
    const evidence = readJson(file);
    if (evidence.verdict !== 'green') problems.push(`evidence red: ${name} (exit ${evidence.exitCode})`);
  }

  for (const action of ['edit-gate', 'manifest-gate', 'targeted-gate', 'seam-rules', 'unlaunched-gate']) {
    const file = path.join(art, 'evidence', `${action}-final.json`);
    if (!existsSync(file)) problems.push(`final gate never ran: ${action}`);
    else if (readJson(file).verdict !== 'green') problems.push(`final gate red: ${action}`);
  }

  for (const provider of ['claude', 'codex']) {
    const file = path.join(art, 'reviews', `signoff-${provider}.json`);
    if (!existsSync(file)) {
      problems.push(`missing adversarial signoff: ${provider}`);
      continue;
    }
    let signoff;
    try {
      signoff = readJson(file);
    } catch (error) {
      problems.push(`${provider} signoff is not valid JSON (${error.message})`);
      continue;
    }
    if (signoff.kind !== 'native-delivery-signoff') problems.push(`${provider} signoff identity is wrong`);
    if (signoff.verdict !== 'pass') problems.push(`${provider} signoff verdict is ${signoff.verdict}`);
    if (Array.isArray(signoff.findings) && signoff.findings.length > 0)
      problems.push(`${provider} signoff passes while carrying ${signoff.findings.length} findings`);
    // The reviewer must have reviewed the sealed set, not an earlier one.
    const sealFile = path.join(art, 'seal-final.json');
    if (existsSync(sealFile) && signoff.artifactSetSha256 !== readJson(sealFile).artifactSetSha256)
      problems.push(`${provider} signoff cites a different artifact set than seal-final.json`);
  }

  writeJson(path.join(art, 'acceptance.json'), {
    schemaVersion: 1,
    kind: 'native-delivery-acceptance',
    phase: Number(phase),
    verdict: problems.length === 0 ? 'pass' : 'blocked',
    problems,
    decidedAt: new Date().toISOString(),
  });
  if (problems.length > 0) {
    fail(`accept phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`accept phase=${phase}`);
}

/**
 * Commit only on recomputed green. A red acceptance writes BLOCKED_NO_COMMIT.md
 * and exits 0: a handled blocked state, not a crashed workflow.
 *
 * Push and PR are opt-in (`NATIVE_DELIVERY_PUSH=1`) and never target main.
 */
function commitIfGreen() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  accept();
  const acceptance = readJson(path.join(art, 'acceptance.json'));
  if (acceptance.verdict !== 'pass') {
    writeFileSync(
      path.join(art, 'BLOCKED_NO_COMMIT.md'),
      `# Blocked, no commit\n\nphase: ${phase} (${config.slug})\n\n` +
        acceptance.problems.map((problem) => `- ${problem}`).join('\n') +
        '\n'
    );
    process.exitCode = 0;
    process.stdout.write(`BLOCKED_NO_COMMIT phase=${phase} problems=${acceptance.problems.length}\n`);
    return;
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'main' || branch === 'master') {
    fail('refusing to commit on main');
    return;
  }
  const scope = [...config.scope, ...(config.tsScope ?? [])];
  execFileSync('git', ['add', '--', ...scope], { stdio: 'inherit' });
  const subject = `feat(delivery): phase ${phase} — ${config.title}`;
  execFileSync(
    'git',
    [
      'commit',
      '-m',
      subject,
      '-m',
      `Exit criterion: ${config.exit}\n\nEvidence: ${path.relative(process.cwd(), art)}`,
      '-m',
      'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    ],
    { stdio: 'inherit' }
  );
  if (process.env.NATIVE_DELIVERY_PUSH === '1') {
    execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });
  }
  pass(`commit-if-green phase=${phase} branch=${branch} pushed=${process.env.NATIVE_DELIVERY_PUSH === '1'}`);
}

const ACTIONS = {
  preflight,
  contract,
  record,
  'require-green': requireGreen,
  'regression-gate': regressionGate,
  'require-artifacts': requireArtifacts,
  'edit-gate': editGate,
  'manifest-gate': manifestGate,
  'targeted-gate': targetedGate,
  'seam-rules': seamRules,
  'unlaunched-gate': unlaunchedGate,
  seal,
  accept,
  'commit-if-green': commitIfGreen,
};

async function main() {
  const action = process.argv[2];
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`usage: native-delivery-gates.mjs <${Object.keys(ACTIONS).join('|')}>`);
  await handler();
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((error) => {
    process.stderr.write(`GATE_ERROR ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
}
