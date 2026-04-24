import { describe, expect, it, vi } from 'vitest';

import { applySiblingLinks, buildSiblingLinkScript } from '../sibling-links.js';

describe('buildSiblingLinkScript', () => {
  it('detects npm manifest and emits an npm link block', () => {
    const script = buildSiblingLinkScript([{ name: '@scope/pkg', path: '../sibling/packages/pkg' }]);
    expect(script).toContain('-f "$SIBLING_PATH/package.json"');
    expect(script).toContain('npm link --silent');
    expect(script).toContain('@scope/pkg');
    expect(script).toContain('../sibling/packages/pkg');
  });

  it('detects python manifest and emits a pip install -e block', () => {
    const script = buildSiblingLinkScript([{ name: 'my_pkg', path: '../py/pkg' }]);
    expect(script).toContain('-f "$SIBLING_PATH/pyproject.toml"');
    expect(script).toContain('pip install -e');
    expect(script).toContain('uv pip install --system -e');
  });

  it('fails-fast shell: script uses set -euo pipefail', () => {
    const script = buildSiblingLinkScript([{ name: 'x', path: './x' }]);
    expect(script.startsWith('set -euo pipefail')).toBe(true);
  });

  it('guards missing sibling path with explicit error', () => {
    const script = buildSiblingLinkScript([{ name: 'x', path: '../missing' }]);
    expect(script).toContain('SIBLING_PATH_MISSING');
    expect(script).toContain('exit 1');
  });

  it('guards unknown manifest with explicit error', () => {
    const script = buildSiblingLinkScript([{ name: 'x', path: './x' }]);
    expect(script).toContain('UNKNOWN_MANIFEST');
  });

  it('emits one verify block per link with expected exports', () => {
    const script = buildSiblingLinkScript([
      { name: 'pkg-a', path: '../a', expect: ['foo', 'bar'] },
      { name: 'pkg-b', path: '../b' },
      { name: 'pkg-c', path: '../c', expect: ['baz'] },
    ]);
    const verifyCount = (script.match(/APPLY_SIBLING_LINKS_EXPECT/g) ?? []).length;
    // Two verify blocks (for pkg-a + pkg-c), each referenced at least twice
    // (env var declaration + two command variants for node/python fallback).
    expect(verifyCount).toBeGreaterThanOrEqual(4);
    expect(script).toContain('APPLY_SIBLING_LINKS_OK');
  });

  it('JSON-encodes expected exports safely for shell and downstream JSON.parse', () => {
    const script = buildSiblingLinkScript([{ name: 'p', path: './p', expect: ["it's-ok", 'with"quote'] }]);
    // Expect list is embedded as: EXPECT=<shell-string-of-json-array>
    // so the inner JSON survives round-trip through bash env var into
    // Node.JSON.parse / Python json.loads.
    const expectedInner = JSON.stringify(["it's-ok", 'with"quote']);
    const expectedShellArg = JSON.stringify(expectedInner);
    expect(script).toContain(`EXPECT=${expectedShellArg}`);
  });

  it('emits both node and python verifiers wrapped in manifest-conditional', () => {
    const script = buildSiblingLinkScript([{ name: 'p', path: './p', expect: ['x'] }]);
    expect(script).toContain('node --input-type=module');
    expect(script).toContain('python3 -c');
    // The wrapping if/elif/else pattern keeps python as a fallback inside
    // the non-package.json branch.
    expect(script).toMatch(/if \[ -f "\$SIBLING_PATH\/package\.json" \]; then[\s\S]+?else[\s\S]+?python/);
  });

  it('echoes link name/path via shell vars, not raw interpolation (review: shell injection)', () => {
    // Fix for review: a name containing `"$(cmd)` previously broke out of the
    // echo's double-quoting and triggered command substitution. With the fix,
    // the echo happens AFTER the SIBLING_NAME / SIBLING_PATH assignments
    // (which use JSON-encoded safe literals) and references them via
    // $-expansion.
    const script = buildSiblingLinkScript([{ name: 'pkg"$(evil)', path: '../path"$(also-evil)' }]);
    const echoLines = script.split('\n').filter((l) => l.startsWith('echo "--- link:'));
    expect(echoLines).toHaveLength(1);
    expect(echoLines[0]).toBe('echo "--- link: $SIBLING_NAME <- $SIBLING_PATH ---"');
    const assignmentLines = script
      .split('\n')
      .filter((l) => l.startsWith('SIBLING_NAME=') || l.startsWith('SIBLING_PATH='));
    expect(assignmentLines.some((l) => l.includes(JSON.stringify('pkg"$(evil)')))).toBe(true);
    expect(assignmentLines.some((l) => l.includes(JSON.stringify('../path"$(also-evil)')))).toBe(true);
  });

  it('uv is invoked with --system and falls through to pip on failure (review: non-venv)', () => {
    // Fix for review: uv refuses to install outside a venv without --system.
    // The dispatch now uses --system AND wraps the uv attempt in an `if` so
    // failure falls through to pip/pip3 instead of exiting under `set -e`.
    const script = buildSiblingLinkScript([{ name: 'p', path: '../p' }]);
    expect(script).toContain('uv pip install --system -e');
    expect(script).toMatch(
      /if command -v uv[^\n]+uv pip install --system[^\n]+; then\s*\n\s*:\s*\n\s*elif command -v pip/
    );
  });

  it('python verifier avoids backslashes inside f-string expressions (review: Python < 3.12 SyntaxError)', () => {
    // Fix for review: backslashes (e.g. `\",\"`) inside f-string expression
    // braces are a SyntaxError on Python < 3.12. We bind `sep = ","` outside
    // the f-string and reference it from inside. The old escaped form must
    // not appear anywhere in the emitted script.
    const script = buildSiblingLinkScript([{ name: 'p', path: './p', expect: ['foo'] }]);
    expect(script).toContain('sep = ","');
    expect(script).toContain('sep.join(missing)');
    expect(script).toContain('sep.join(want)');
    expect(script).not.toContain('\\",\\".join(');
  });
});

describe('applySiblingLinks', () => {
  it('is a no-op when links is empty', () => {
    const builder = { step: vi.fn() };
    const result = applySiblingLinks(builder, { links: [] });
    expect(builder.step).not.toHaveBeenCalled();
    expect(result).toBe(builder);
  });

  it('adds a single deterministic step named setup-sibling-links by default', () => {
    const builder = { step: vi.fn(() => builder) };
    applySiblingLinks(builder, {
      links: [{ name: 'pkg', path: '../pkg' }],
    });
    expect(builder.step).toHaveBeenCalledTimes(1);
    const call = builder.step.mock.calls[0] as unknown as
      | [string, { command: string; [k: string]: unknown }]
      | undefined;
    if (!call) throw new Error('expected step call');
    const [stepName, cfg] = call;
    expect(stepName).toBe('setup-sibling-links');
    expect(cfg).toMatchObject({
      type: 'deterministic',
      dependsOn: ['install-deps'],
      captureOutput: true,
      failOnError: true,
    });
    expect(cfg.command).toContain("bash -c '");
  });

  it('honors custom stepName and dependsOn', () => {
    const builder = { step: vi.fn(() => builder) };
    applySiblingLinks(builder, {
      links: [{ name: 'pkg', path: '../pkg' }],
      stepName: 'custom-name',
      dependsOn: ['setup-branch'],
    });
    const call = builder.step.mock.calls[0] as unknown as
      | [string, { command: string; [k: string]: unknown }]
      | undefined;
    if (!call) throw new Error('expected step call');
    const [stepName, cfg] = call;
    expect(stepName).toBe('custom-name');
    expect(cfg).toMatchObject({ dependsOn: ['setup-branch'] });
  });

  it('escapes single quotes in the embedded script safely for bash -c', () => {
    const builder = { step: vi.fn(() => builder) };
    applySiblingLinks(builder, {
      links: [{ name: "has'quote", path: "./path'with-quote" }],
    });
    const call = builder.step.mock.calls[0] as unknown as [string, { command: string }] | undefined;
    if (!call) throw new Error('expected step call');
    const command = call[1].command;
    // Verify the bash -c wrapper is well-formed: starts with bash -c ' and
    // ends with matching close quote. The POSIX escape pattern is '\''
    // (close-quote, escaped-quote, re-open-quote) — the end result should
    // not have an odd number of unescaped single quotes.
    expect(command.startsWith(`bash -c '`)).toBe(true);
    expect(command.endsWith(`'`)).toBe(true);
  });
});
