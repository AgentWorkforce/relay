/**
 * Sibling-package link setup for workflows that consume a package living in
 * a sibling repo / worktree on disk.
 *
 * Problem it solves: agents running inside a workflow sometimes find that
 * `npm install` (or `pip install`) resolved an older version of a package
 * than the one the workflow actually needs — for example when the consumer
 * workflow runs before the producer has published a new release. Rather
 * than letting agents see a stale interface (and react by augmenting the
 * module or writing fallback implementations), linking redirects the
 * package resolution at dev-time to the sibling's on-disk build output.
 *
 * Usage (ESM):
 *
 *   import { workflow, applySiblingLinks } from '@agent-relay/sdk/workflows';
 *
 *   const base = workflow('my-feature').pattern('dag').agent('impl', ...);
 *   const wf = applySiblingLinks(base, {
 *     dependsOn: ['install-deps'],
 *     links: [
 *       {
 *         name: '@agent-assistant/proactive',
 *         path: '../agent-assistant/packages/proactive',
 *         expect: ['recordSignal', 'drainSignals'],
 *       },
 *       {
 *         name: '@agent-assistant/surfaces',
 *         path: '../agent-assistant/packages/surfaces',
 *         expect: ['classifySlackPresenceSignal'],
 *       },
 *     ],
 *   });
 *
 *   await wf.step('plan', { agent: 'impl', dependsOn: ['setup-sibling-links'], task: ... })
 *     .run({ cwd: process.cwd() });
 *
 * MVP language support: npm (package.json), Python (pyproject.toml /
 * setup.py / setup.cfg). Auto-detects from the sibling's manifest. Fails
 * fast on missing path, unknown manifest, or missing expected exports.
 */

/** A single sibling package to link into the workflow's working directory. */
export interface SiblingLink {
  /**
   * Package name as it appears in imports (e.g. "@agent-assistant/proactive",
   * "my_python_pkg"). For Python, use the import name (underscored), not the
   * distribution name.
   */
  name: string;

  /**
   * Path to the sibling package root, relative to the workflow's cwd.
   * For npm, this is the directory containing package.json.
   * For Python, the directory containing pyproject.toml / setup.py.
   */
  path: string;

  /**
   * Optional list of top-level named exports / attributes the workflow
   * expects to find on the linked package post-setup. When provided, a
   * language-appropriate import smoke test runs and fails the step if any
   * are missing.
   */
  expect?: string[];
}

export interface SiblingLinkOptions {
  /** Link declarations. All must succeed (fail-fast on any error). */
  links: SiblingLink[];

  /**
   * Step name for the setup step emitted by this helper.
   * Defaults to `"setup-sibling-links"`.
   */
  stepName?: string;

  /**
   * dependsOn for the setup step. Typically `['install-deps']` so that
   * `npm install` / `pip install` has run first.
   * Defaults to `['install-deps']`.
   */
  dependsOn?: string[];
}

/** Minimal builder shape — accepts anything with a chainable `.step()` method. */
interface StepChain {
  step: (name: string, cfg: unknown) => StepChain;
}

/**
 * Adds a single deterministic step to the workflow that links each sibling
 * package into the workflow's working directory using the appropriate
 * language-specific mechanism, then smoke-tests each linked package for
 * expected exports.
 *
 * The step fails fast on:
 *   - Sibling path missing
 *   - Unknown manifest (no package.json / pyproject.toml / setup.py)
 *   - Link command failure
 *   - Missing expected export
 */
export function applySiblingLinks<T>(wf: T, opts: SiblingLinkOptions): T {
  if (opts.links.length === 0) {
    return wf;
  }

  const stepName = opts.stepName ?? 'setup-sibling-links';
  const dependsOn = opts.dependsOn ?? ['install-deps'];

  const script = buildSiblingLinkScript(opts.links);
  const chain = wf as unknown as StepChain;
  chain.step(stepName, {
    type: 'deterministic',
    dependsOn,
    command: `bash -c ${shSingleQuote(script)}`,
    captureOutput: true,
    failOnError: true,
  });
  return wf;
}

// ─── Internal: shell-script generation ─────────────────────────────────────

/** Shell-quote a string for safe single-quoted inclusion in a bash command. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** JSON-encode a string for safe inclusion inside a shell double-quoted string. */
function shJsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Builds a bash script that:
 *   1. For each link, detects its manifest and applies the right link command.
 *   2. After all links succeed, runs one import smoke test per link that
 *      declared expected exports.
 *
 * Exported for test visibility; not part of the public API.
 */
export function buildSiblingLinkScript(links: SiblingLink[]): string {
  const lines: string[] = ['set -euo pipefail', 'echo "=== applySiblingLinks: setting up ==="'];

  for (const link of links) {
    const escapedName = shJsonString(link.name);
    const escapedPath = shJsonString(link.path);
    // Bind the shell vars BEFORE echoing so we don't interpolate unescaped
    // link.name / link.path (which may contain `"`, `$`, backticks) into a
    // double-quoted echo. Use them via $SIBLING_NAME / $SIBLING_PATH, which
    // are already quoted-safe because shJsonString produced them.
    lines.push(linkOneBlock(link, escapedName, escapedPath));
  }

  lines.push('echo "=== applySiblingLinks: verifying exports ==="');
  for (const link of links) {
    if (!link.expect || link.expect.length === 0) {
      continue;
    }
    lines.push(verifyExportsBlock(link));
  }

  lines.push('echo "APPLY_SIBLING_LINKS_OK"');
  return lines.join('\n');
}

function linkOneBlock(link: SiblingLink, jsonName: string, jsonPath: string): string {
  void link;
  return [
    `SIBLING_PATH=${jsonPath}`,
    `SIBLING_NAME=${jsonName}`,
    'echo "--- link: $SIBLING_NAME <- $SIBLING_PATH ---"',
    'if [ ! -d "$SIBLING_PATH" ]; then',
    '  echo "SIBLING_PATH_MISSING: $SIBLING_PATH" >&2',
    '  exit 1',
    'fi',
    'if [ -f "$SIBLING_PATH/package.json" ]; then',
    '  echo "detected: npm"',
    '  ( cd "$SIBLING_PATH" && npm link --silent )',
    '  npm link --silent "$SIBLING_NAME"',
    'elif [ -f "$SIBLING_PATH/pyproject.toml" ] || [ -f "$SIBLING_PATH/setup.py" ] || [ -f "$SIBLING_PATH/setup.cfg" ]; then',
    '  echo "detected: python"',
    // Try uv first (fastest when available), but uv refuses to install
    // outside a venv without --system. Pass --system explicitly so uv
    // works in non-venv sandboxes (common CI/agent runner shape).
    // If uv still fails (e.g. broken install), fall through to pip/pip3
    // via the explicit OR chain rather than relying on `set -e` to
    // short-circuit between elif branches.
    '  if command -v uv >/dev/null 2>&1 && uv pip install --system -e "$SIBLING_PATH" --quiet 2>/dev/null; then',
    '    :',
    '  elif command -v pip >/dev/null 2>&1; then',
    '    pip install -e "$SIBLING_PATH" --quiet',
    '  elif command -v pip3 >/dev/null 2>&1; then',
    '    pip3 install -e "$SIBLING_PATH" --quiet',
    '  else',
    '    echo "NO_PYTHON_INSTALLER: uv / pip / pip3 not found or all failed" >&2',
    '    exit 1',
    '  fi',
    'else',
    '  echo "UNKNOWN_MANIFEST: expected package.json / pyproject.toml / setup.py / setup.cfg at $SIBLING_PATH" >&2',
    '  exit 1',
    'fi',
  ].join('\n');
}

function verifyExportsBlock(link: SiblingLink): string {
  const jsonName = shJsonString(link.name);
  const jsonPath = shJsonString(link.path);
  const expectList = JSON.stringify(link.expect ?? []);
  // Pick the smoke-test runtime based on what manifest type the sibling had.
  return [
    `SIBLING_PATH=${jsonPath}`,
    `SIBLING_NAME=${jsonName}`,
    `EXPECT=${shJsonString(expectList)}`,
    'if [ -f "$SIBLING_PATH/package.json" ]; then',
    nodeVerifyCommand(),
    'else',
    pythonVerifyCommand(),
    'fi',
  ].join('\n');
}

function nodeVerifyCommand(): string {
  const script = [
    'const want = JSON.parse(process.env.APPLY_SIBLING_LINKS_EXPECT);',
    'const name = process.env.APPLY_SIBLING_LINKS_NAME;',
    'const mod = await import(name);',
    'const missing = want.filter((k) => !(k in mod));',
    'if (missing.length) {',
    '  console.error(`MISSING_EXPORTS in ${name}: ${missing.join(",")}`);',
    '  process.exit(1);',
    '}',
    'console.log(`${name} OK: ${want.join(",")}`);',
  ].join(' ');
  return `  APPLY_SIBLING_LINKS_NAME="$SIBLING_NAME" APPLY_SIBLING_LINKS_EXPECT="$EXPECT" node --input-type=module -e ${shSingleQuote(script)}`;
}

function pythonVerifyCommand(): string {
  // Python < 3.12 forbids backslashes inside f-string expressions, so we
  // can't inline `{",".join(missing)}` (which needs `\",\".` when written
  // as a JS string literal). Bind the separator to a name outside the
  // f-string first.
  const script = [
    'import json, os, importlib',
    'name = os.environ["APPLY_SIBLING_LINKS_NAME"]',
    'want = json.loads(os.environ["APPLY_SIBLING_LINKS_EXPECT"])',
    'mod = importlib.import_module(name)',
    'missing = [k for k in want if not hasattr(mod, k)]',
    'sep = ","',
    'if missing:',
    '    print(f"MISSING_EXPORTS in {name}: {sep.join(missing)}", flush=True)',
    '    raise SystemExit(1)',
    'print(f"{name} OK: {sep.join(want)}", flush=True)',
  ].join('\n');
  return [
    '  APPLY_SIBLING_LINKS_NAME="$SIBLING_NAME" APPLY_SIBLING_LINKS_EXPECT="$EXPECT" \\',
    `  python3 -c ${shSingleQuote(script)} 2>/dev/null || \\`,
    `  APPLY_SIBLING_LINKS_NAME="$SIBLING_NAME" APPLY_SIBLING_LINKS_EXPECT="$EXPECT" python -c ${shSingleQuote(script)}`,
  ].join('\n');
}
