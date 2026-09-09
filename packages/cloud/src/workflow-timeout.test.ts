import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS,
  MAX_WORKFLOW_LAUNCH_TIMEOUT_MS,
  MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS,
  inferWorkflowLaunchTimeoutMs,
  resolveWorkflowLaunchTimeoutMs,
} from './workflow-timeout.js';

describe('workflow launch timeout inference', () => {
  it('reads an underscored TypeScript builder timeout without executing the workflow', () => {
    const source = "const result = await workflow('proof').timeout(3_300_000).run();";
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(3_300_000);
  });

  it('trims whitespace and masked comments around a TypeScript builder timeout literal', () => {
    const source = "const result = await workflow('proof').timeout( /* budget */ 600_000 /* ms */ ).run();";
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(600_000);
  });

  it('omits inference for the checked-in workflow timeout beyond the metadata limit', () => {
    const source = readFileSync(new URL('../../../workflows/verify-features.ts', import.meta.url), 'utf8');
    expect(source).toContain('.timeout(3_600_000)');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBeUndefined();
  });

  it('ignores timeout-shaped text in TypeScript comments, strings, and templates', () => {
    const source = [
      "// workflow('comment').timeout(3_300_000)",
      "/* workflow('block').timeout(3_200_000) */",
      'const quoted = ".timeout(3_100_000)";',
      'const template = `.timeout(3_000_000)`;',
      "workflow('real').timeout(900_000).run();",
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('ignores timeout-shaped text in TypeScript regular expressions', () => {
    expect(
      inferWorkflowLaunchTimeoutMs(
        'const pattern = /foo.timeout(600_000)/; if (ready) /workflow("fake").timeout(500_000)/;',
        'ts'
      )
    ).toBeUndefined();
  });

  it('ignores a regular-expression timeout while inferring the real builder timeout', () => {
    const source = 'const pattern = /foo.timeout(600_000)/; workflow("real").timeout(900_000).run();';
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not mistake a regex after a control paren containing a quoted close paren for code', () => {
    expect(
      inferWorkflowLaunchTimeoutMs('if (foo(")")) /workflow("fake").timeout(600_000)/;', 'ts')
    ).toBeUndefined();
  });

  it('does not rescan a large slash-heavy source from the beginning for every slash', () => {
    class NoRescanString extends String {
      override replace(): never {
        throw new Error('source.replace() indicates a whole-prefix rescan');
      }

      override slice(): never {
        throw new Error('source.slice() indicates a whole-prefix rescan');
      }
    }

    const source = new NoRescanString('/ '.repeat(100_000)) as unknown as string;
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBeUndefined();
  });

  it('does not rescan the suffix for repeated malformed timeout candidates', () => {
    const source = "workflow('malformed').timeout(".repeat(8_000);
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBeUndefined();
  });

  it('resolves repeated fluent timeout calls without rescanning their call chain', () => {
    const source = "workflow('root')" + '.timeout(600_000)'.repeat(12_000);
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(600_000);
  });

  it('ignores timeout methods on unrelated objects', () => {
    expect(
      inferWorkflowLaunchTimeoutMs(
        'httpClient.timeout(600_000); httpClient().timeout(600_000); makeThing().timeout(600_000);',
        'ts'
      )
    ).toBeUndefined();
  });

  it('does not treat a bare workflow object identifier as a builder', () => {
    expect(
      inferWorkflowLaunchTimeoutMs('const workflow = {}; workflow.timeout(600_000);', 'ts')
    ).toBeUndefined();
  });

  it('masks a regular expression after a block statement', () => {
    expect(
      inferWorkflowLaunchTimeoutMs('if (ready) {} /workflow("fake").timeout(500_000)/;', 'ts')
    ).toBeUndefined();
  });

  it.each(['break', 'continue', 'debugger'])('masks a regular expression after ASI keyword %s', (keyword) => {
    const source = `while (ready) { ${keyword}\n/workflow("fake").timeout(600_000)/.test(value); }`;
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBeUndefined();
  });

  it('masks a regular expression after a labelled ASI break', () => {
    const source =
      'workflow("real").timeout(900_000); while (ready) { break label\n/workflow("fake").timeout(600_000)/.test(value); }';
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it.each([
    `π: while (ready) { break π\n/workflow("fake").timeout(600_000)/.test(value); }`,
    String.raw`\u03c0: while (ready) { break \u03c0
/workflow("fake").timeout(600_000)/.test(value); }`,
    `𐐀: while (ready) { break 𐐀\n/workflow("fake").timeout(600_000)/.test(value); }`,
    String.raw`\u{10400}: while (ready) { break \u{10400}
/workflow("fake").timeout(600_000)/.test(value); }`,
  ])('masks a regular expression after a Unicode labelled ASI break', (statement) => {
    expect(inferWorkflowLaunchTimeoutMs(statement, 'ts')).toBeUndefined();
    const source = `workflow("real").timeout(900_000); ${statement}`;
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('keeps ASI regex masking through comments after break and continue', () => {
    for (const keyword of ['break', 'continue']) {
      const source =
        `workflow("real").timeout(900_000); while (ready) { ${keyword} /* comment\n */ label\n` +
        '/workflow("fake").timeout(600_000)/.test(value); }';
      expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
    }
  });

  it.each(['\u2028', '\u2029'])(
    'keeps ASI regex masking after Unicode line terminator %j',
    (lineTerminator) => {
      for (const keyword of ['break', 'continue', 'debugger']) {
        const source =
          `workflow("real").timeout(900_000); while (ready) { ${keyword}${lineTerminator}` +
          '/workflow("fake").timeout(600_000)/.test(value); }';
        expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
      }
    }
  );

  it('does not treat multiline Python keyword arguments as assignments', () => {
    const source = ['wf = workflow(', '  "real",', '  option=other,', ')', 'wf.timeout(900_000)'].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('does not treat multiline Python call keyword arguments as assignments', () => {
    const source = [
      'from library import wf',
      'register(',
      '  wf=workflow("real"),',
      ')',
      'wf.timeout(900_000)',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBeUndefined();
  });

  it('does not treat multiline Python function defaults as assignments', () => {
    const source = ['def build(', '  wf=workflow("fake"),', '):', '  pass', 'wf.timeout(900_000)'].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBeUndefined();
  });

  it('keeps multiline Python assignments as builder bindings', () => {
    const source = ['wf = workflow(', '  "real",', '  option=other,', ')', 'wf.timeout(900_000)'].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('does not let a shadowed non-builder identifier create an ambiguous timeout', () => {
    const source = [
      "const wf = workflow('real');",
      'wf.timeout(900_000);',
      '{',
      '  const wf = {};',
      '  wf.timeout(600_000);',
      '}',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('keeps scope-aware direct workflow calls from using a shadowed function', () => {
    const source = [
      "workflow('real').timeout(900_000);",
      '{',
      '  const workflow = fakeWorkflow;',
      '  workflow("fake").timeout(600_000);',
      '}',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not let a function parameter shadowing a builder create an ambiguous timeout', () => {
    const source = [
      "const wf = workflow('real');",
      'function run(wf) {',
      '  wf.timeout(600_000);',
      '}',
      'wf.timeout(900_000);',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not let a function parameter shadowing workflow create an ambiguous timeout', () => {
    const source = [
      "workflow('real').timeout(900_000);",
      'function run(workflow) {',
      '  workflow("fake").timeout(600_000);',
      '}',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('tracks typed function parameters through return annotations', () => {
    const source = [
      "workflow('real').timeout(900_000);",
      'function run(workflow: unknown): void {',
      '  workflow("fake").timeout(600_000);',
      '}',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not treat identifiers inside TypeScript parameter types as runtime shadows', () => {
    const source = [
      "const wf = workflow('real');",
      'function run(options: { wf: string }) {',
      '  wf.timeout(600_000);',
      '}',
      'wf.timeout(900_000);',
    ].join('\n');
    expect(() => inferWorkflowLaunchTimeoutMs(source, 'ts')).toThrow(/multiple distinct/);
  });

  it('skips object types nested in typed function return annotations', () => {
    const source = [
      "workflow('real').timeout(900_000);",
      'function run(workflow: unknown): Promise<{ ok: boolean }> {',
      '  workflow("fake").timeout(600_000);',
      '}',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('tracks generic function parameters without executing TypeScript', () => {
    const source = [
      "workflow('real').timeout(900_000);",
      "function run<T>(workflow: T): Promise<void> { workflow('fake').timeout(600_000); }",
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('tracks generic object-method parameters as lexical shadows', () => {
    const source = [
      "workflow('real').timeout(900_000);",
      "const runner = { run<T>(workflow: T): void { workflow('fake').timeout(600_000); } };",
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('tracks typed arrow parameters through return annotations', () => {
    const source = [
      "const wf = workflow('real');",
      'const run = (wf: unknown): void => {',
      '  wf.timeout(600_000);',
      '};',
      'wf.timeout(900_000);',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it.each([
    'const run = (workflow) => workflow("fake").timeout(600_000);',
    'const run = workflow => workflow("fake").timeout(600_000);',
    'const run=workflow=>workflow("fake").timeout(600_000);',
    'const run = <T>(workflow: T): T => workflow("fake").timeout(600_000);',
  ])('tracks expression-bodied arrow parameters as lexical shadows: %s', (arrow) => {
    expect(inferWorkflowLaunchTimeoutMs(arrow, 'ts')).toBeUndefined();
    const source = [`workflow('real').timeout(900_000);`, arrow].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it.each([
    `consume(workflow => workflow('fake').timeout(600_000), workflow('real').timeout(900_000));`,
    `[workflow => workflow('fake').timeout(600_000), workflow('real').timeout(900_000)];`,
    `ready ? workflow => workflow('fake').timeout(600_000) : workflow('real').timeout(900_000);`,
  ])('ends expression-bodied arrow scope at its enclosing expression boundary: %s', (source) => {
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('keeps a conditional expression inside an arrow body in the arrow scope', () => {
    const source = [
      `const run=workflow=>ready`,
      `  ? workflow('fake-a').timeout(600_000)`,
      `  : workflow('fake-b').timeout(600_000);`,
      `workflow('real').timeout(900_000);`,
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not treat a TypeScript function-type arrow as a value scope', () => {
    const source =
      `const runner: (workflow: unknown) => unknown = ` + `makeRunner(workflow('real').timeout(900_000));`;
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('reads parameters from an arrow whose return type contains a function type', () => {
    const source = [
      `workflow('real').timeout(900_000);`,
      `const run = (workflow: unknown): (() => void) => workflow('fake').timeout(600_000);`,
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not borrow parameters from an earlier typed declaration for an arrow', () => {
    const source = [
      `declare function prior(): void;`,
      `const run = (workflow) => workflow('fake').timeout(600_000);`,
      `workflow('real').timeout(900_000);`,
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it.each([
    `class Runner { ['run'](workflow: unknown) { workflow('fake').timeout(600_000); } }`,
    `const runner = { ['run'](workflow: unknown) { workflow('fake').timeout(600_000); } };`,
    `class Runner { [Symbol.iterator](workflow: unknown) { workflow('fake').timeout(600_000); } }`,
  ])('tracks computed method parameters as lexical shadows: %s', (method) => {
    expect(inferWorkflowLaunchTimeoutMs(method, 'ts')).toBeUndefined();
    const source = [`workflow('real').timeout(900_000);`, method].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('preserves a computed method parameter scope nested in an expression-bodied arrow', () => {
    const nested =
      `const make = () => ({ ` + `['run'](workflow: unknown) { workflow('fake').timeout(600_000); } ` + `});`;
    expect(inferWorkflowLaunchTimeoutMs(nested, 'ts')).toBeUndefined();
    expect(inferWorkflowLaunchTimeoutMs(`${nested}\nworkflow('real').timeout(900_000);`, 'ts')).toBe(900_000);
  });

  it('preserves catch and var shadows nested in an expression-bodied arrow', () => {
    const source = [
      `const wf = workflow('real');`,
      `const make = () => class Runner {`,
      `  run() {`,
      `    try {} catch (workflow) { workflow('fake').timeout(600_000); }`,
      `    { var wf = {}; }`,
      `    wf.timeout(600_000);`,
      `  }`,
      `};`,
      `wf.timeout(900_000);`,
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('tracks catch bindings as lexical shadows', () => {
    const source = [
      "const wf = workflow('real');",
      'try {} catch (wf) {',
      '  wf.timeout(600_000);',
      '}',
      'wf.timeout(900_000);',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('hoists var declarations in a catch block to the enclosing function scope', () => {
    const source = ["try {} catch (e) { var wf = workflow('real'); }", 'wf.timeout(900_000);'].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('does not treat a catch block as the var-hoist function scope', () => {
    const source = [
      "workflow('root').timeout(900_000);",
      'function outer() {',
      "  try {} catch (e) { var wf = workflow('inner'); }",
      '  wf.timeout(600_000);',
      '}',
    ].join('\n');
    expect(() => inferWorkflowLaunchTimeoutMs(source, 'ts')).toThrow(/multiple distinct/);
  });

  it('hoists var builder bindings to the surrounding function scope', () => {
    const source = ['{', "  var wf = workflow('real');", '}', 'wf.timeout(900_000);'].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('tracks arrow-function parameters as lexical shadows', () => {
    const source = [
      "const wf = workflow('real');",
      'const run = (wf) => {',
      '  wf.timeout(600_000);',
      '};',
      'wf.timeout(900_000);',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('keeps var shadows inside a function from changing the outer binding', () => {
    const source = [
      "const wf = workflow('real');",
      'function run() {',
      '  {',
      '    var wf = {};',
      '  }',
      '  wf.timeout(600_000);',
      '}',
      'wf.timeout(900_000);',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('supports the fluent and assigned RelayFlow builder shapes used by workflows', () => {
    expect(
      inferWorkflowLaunchTimeoutMs("const wf = workflow('real').description('demo').timeout(900_000);", 'ts')
    ).toBe(900_000);
    expect(inferWorkflowLaunchTimeoutMs("const wf = workflow('real'); wf.timeout(600_000);", 'ts')).toBe(
      600_000
    );
  });

  it('supports typed TypeScript builder declarations', () => {
    for (const declaration of [
      `const wf: WorkflowBuilder = workflow('real');`,
      `const wf: WorkflowBuilder & { marker: () => void; } = workflow('real');`,
    ]) {
      expect(inferWorkflowLaunchTimeoutMs(`${declaration} wf.timeout(900_000);`, 'ts')).toBe(900_000);
    }
  });

  it('reads Python literals while ignoring comments and string bodies', () => {
    const source = [
      '# workflow("comment").timeout(3_300_000)',
      'description = """.timeout(3_200_000)"""',
      'workflow("real").timeout(600_000).run()',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(600_000);
  });

  it('tracks Python function parameters through indentation scopes', () => {
    const source = [
      "workflow('real').timeout(900_000)",
      'def run(workflow):',
      "    workflow('fake').timeout(600_000)",
      "workflow('real').timeout(900_000)",
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('tracks Python parameters declared by a multiline function signature', () => {
    const definition = [
      'def run(',
      '    workflow,',
      '):',
      '    pass',
      `    workflow('fake').timeout(600_000)`,
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(definition, 'py')).toBeUndefined();
    const source = [`workflow('real').timeout(900_000)`, definition].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it.each([
    `def run(workflow) -> None:\n    workflow('fake').timeout(600_000)`,
    `def run(\n    workflow,\n) -> dict[str, int]:\n    workflow('fake').timeout(600_000)`,
    `def run(workflow) -> None: workflow('fake').timeout(600_000)`,
    `def outer():\n    def run(workflow) -> None:\n        workflow('fake').timeout(600_000)`,
  ])('tracks Python parameters in return-annotated definitions: %s', (definition) => {
    expect(inferWorkflowLaunchTimeoutMs(definition, 'py')).toBeUndefined();
    expect(inferWorkflowLaunchTimeoutMs(`${definition}\nworkflow('real').timeout(900_000)`, 'py')).toBe(
      900_000
    );
  });

  it('does not treat Python parameter annotations or defaults as bindings', () => {
    const source = [`def run(value: workflow = workflow):`, `    workflow('real').timeout(900_000)`].join(
      '\n'
    );
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('tracks Python parameters in a one-line function suite', () => {
    const definition = `def run(workflow): workflow('fake').timeout(600_000)`;
    expect(inferWorkflowLaunchTimeoutMs(definition, 'py')).toBeUndefined();
    const source = [`workflow('real').timeout(900_000)`, definition].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('tracks Python lambda parameters through expression scope', () => {
    const source = [
      "workflow('real').timeout(900_000)",
      "run = lambda workflow: workflow('fake').timeout(600_000)",
      "workflow('real').timeout(900_000)",
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it.each([`fn = lambda wf={'x': 1}: wf.timeout(600_000)`, `fn = lambda wf=items[1:2]: wf.timeout(600_000)`])(
    'tracks Python lambda parameters with colon-containing defaults: %s',
    (lambda) => {
      const source = [lambda, `wf = workflow('real')`, 'wf.timeout(900_000)'].join('\n');
      expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
    }
  );

  it('ends a default lambda scope before the enclosing lambda body', () => {
    const source =
      `fn = lambda value=lambda workflow: workflow('fake').timeout(600_000): ` +
      `workflow('real').timeout(900_000)`;
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it.each([
    `wf = workflow('real')\nif wf == other:\n    pass\nwf.timeout(900_000)`,
    `wf = workflow('real')\nregister(wf=wf)\nwf.timeout(900_000)`,
  ])('keeps Python builder bindings through non-assignment equals forms: %s', (source) => {
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('supports typed Python builder declarations', () => {
    const source = `wf: WorkflowBuilder = workflow('real')\nwf.timeout(900_000)`;
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(900_000);
  });

  it('keeps timeout-shaped text inside escaped Python triple-quoted delimiters masked', () => {
    const doubleQuoted = String.raw`s = """abc \""" workflow("fake").timeout(600_000) still string"""`;
    const singleQuoted = String.raw`s = '''abc \''' workflow("fake").timeout(600_000) still string'''`;
    expect(inferWorkflowLaunchTimeoutMs(doubleQuoted, 'py')).toBeUndefined();
    expect(inferWorkflowLaunchTimeoutMs(singleQuoted, 'py')).toBeUndefined();
  });

  it('ignores timeout methods on unrelated Python call expressions', () => {
    expect(inferWorkflowLaunchTimeoutMs('http_client().timeout(600_000)', 'py')).toBeUndefined();
  });

  it('uses the legacy five-minute floor for shorter workflow deadlines', () => {
    expect(inferWorkflowLaunchTimeoutMs("workflow('fast').timeout(1_000).run()", 'ts')).toBe(
      DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS
    );
  });

  it('does not guess dynamic timeout expressions', () => {
    expect(
      inferWorkflowLaunchTimeoutMs("workflow('dynamic').timeout(timeoutMs).run()", 'ts')
    ).toBeUndefined();
  });

  it('does not infer a literal when another builder timeout is dynamic', () => {
    const source = "workflow('dynamic').timeout(timeoutMs); workflow('literal').timeout(900_000);";
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBeUndefined();
  });

  it('keeps malformed Python timeout candidates linear in their whitespace suffixes', () => {
    const source = ('.timeout(' + '\t'.repeat(2_000)).repeat(2_000);
    const startedAt = performance.now();
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('keeps repeated single-parameter block arrows near-linear', () => {
    const measure = (count: number): number => {
      const source = `workflow('real').timeout(600_000);\n` + 'const f = value => {};\n'.repeat(count);
      const startedAt = performance.now();
      expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(600_000);
      return performance.now() - startedAt;
    };

    measure(1_000);
    const small = measure(4_000);
    const large = measure(16_000);
    expect(large / small).toBeLessThan(8);
  }, 15_000);

  it('keeps nested Python lambda scope discovery near-linear', () => {
    const measure = (count: number): number => {
      const source = 'run = ' + 'lambda value: '.repeat(count) + `workflow('real').timeout(600_000)`;
      const startedAt = performance.now();
      expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(600_000);
      return performance.now() - startedAt;
    };

    measure(500);
    const small = measure(2_000);
    const large = measure(8_000);
    expect(large / small).toBeLessThan(8);
  }, 15_000);

  it('requires an explicit override when distinct builder timeouts are present', () => {
    const source = "workflow('a').timeout(600_000); workflow('b').timeout(900_000);";
    expect(() => inferWorkflowLaunchTimeoutMs(source, 'ts')).toThrow(/multiple distinct/);
    expect(resolveWorkflowLaunchTimeoutMs(source, 'ts', 1_200_000)).toBe(1_200_000);
  });

  it('rejects non-integer and oversized explicit budgets', () => {
    expect(() => resolveWorkflowLaunchTimeoutMs('', 'ts', Number.NaN)).toThrow(/safe integer/);
    expect(() =>
      resolveWorkflowLaunchTimeoutMs('', 'ts', MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS - 1)
    ).toThrow(/must be at least/);
    expect(() => resolveWorkflowLaunchTimeoutMs('', 'ts', MAX_WORKFLOW_LAUNCH_TIMEOUT_MS + 1)).toThrow(
      /must not exceed/
    );
  });
});
