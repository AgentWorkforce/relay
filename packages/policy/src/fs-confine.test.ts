/**
 * Adversarial tests for filesystem confinement.
 *
 * Two contracts are tested separately, because conflating them is what produced
 * the worst defect this code has had — a refusal that deleted the file it was
 * protecting:
 *
 *   C1  SECURITY REFUSAL — a refusal mutates nothing observable. Every negative
 *       case asserts the refusal *and* that pre-existing state is byte-identical
 *       afterwards. A test that checks only the return value passes against an
 *       implementation that destroys your data and then reports failure.
 *
 *   C2  WRITE ATOMICITY — an authorized write either fully replaces the target
 *       or leaves it exactly as it was.
 *
 * The positive controls are not filler. A confinement layer that refuses
 * legitimate writes is as broken as one that permits escapes, and every fix
 * here risks becoming a blanket refusal.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfinedRoot, ConfinementError } from './fs-confine.js';

const VICTIM = 'IMPORTANT PRE-EXISTING CONTENT';

interface Sandbox {
  base: string;
  root: string;
  outside: string;
  victim: string;
}

const created: string[] = [];
const roots: ConfinedRoot[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) r.close();
  for (const base of created.splice(0)) rmSync(base, { recursive: true, force: true });
});

function sandbox(): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'confine-')));
  const root = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const victim = join(outside, 'secret.txt');
  writeFileSync(victim, VICTIM);
  created.push(base);
  return { base, root, outside, victim };
}

function open(root: string): ConfinedRoot {
  const cr = new ConfinedRoot(root);
  roots.push(cr);
  return cr;
}

/** Relative path -> content (or a marker), for every entry under `dir`. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string, rel: string): void => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) out[key] = '<broken>';
      else if (st.isDirectory()) {
        out[key] = '<dir>';
        walk(full, key);
      } else if (st.isFile()) out[key] = readFileSync(full, 'utf8');
      else out[key] = '<special>';
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Assert C1: the write is refused with `code`, nothing pre-existing changed, and
 * the payload landed nowhere.
 *
 * Additions made by the *adversary* are expected — planting a symlink is the
 * attack, not a defect — so only pre-existing entries are compared.
 */
function expectRefusal(s: Sandbox, code: string, run: () => void, payload = 'PWNED'): void {
  const before = snapshot(s.base);

  // Run exactly once. These cases mutate the tree from inside a hook, so a
  // second invocation would face a different filesystem than the first and
  // assert against the wrong state.
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }

  expect(thrown, 'expected the write to be refused').toBeInstanceOf(ConfinementError);
  expect((thrown as ConfinementError).code).toBe(code);

  const after = snapshot(s.base);
  for (const [key, value] of Object.entries(before)) {
    expect(after[key], `pre-existing entry ${key} was mutated or deleted`).toBe(value);
  }
  for (const [key, value] of Object.entries(after)) {
    expect(value, `payload leaked into ${key}`).not.toBe(payload);
  }
}

describe('ConfinedRoot — resolution mode', () => {
  it('reports which guarantee it is providing', () => {
    const s = sandbox();
    const cr = open(s.root);
    // descriptor-relative on Linux (via /proc/self/fd); pinned-path elsewhere.
    // Asserted so a regression to the weaker mode is visible, not silent.
    expect(['descriptor-relative', 'pinned-path']).toContain(cr.resolutionMode);
    if (process.platform === 'linux') expect(cr.resolutionMode).toBe('descriptor-relative');
  });
});

describe('ConfinedRoot — refusals mutate nothing (C1)', () => {
  it('refuses ../ traversal above the root', () => {
    const s = sandbox();
    const cr = open(s.root);
    expectRefusal(s, 'dot_segment', () => cr.writeFile('../outside/secret.txt', 'PWNED'));
  });

  it('refuses an absolute path', () => {
    const s = sandbox();
    const cr = open(s.root);
    expectRefusal(s, 'absolute_path', () => cr.writeFile(s.victim, 'PWNED'));
  });

  it('refuses a final component that is a symlink pointing outside', () => {
    const s = sandbox();
    symlinkSync(s.victim, join(s.root, 'link.txt'));
    const cr = open(s.root);
    expectRefusal(s, 'symlink_target', () => cr.writeFile('link.txt', 'PWNED'));
  });

  it('refuses an intermediate directory that is a symlink', () => {
    const s = sandbox();
    symlinkSync(s.outside, join(s.root, 'docs'));
    const cr = open(s.root);
    expectRefusal(s, 'symlink_component', () => cr.writeFile('docs/secret.txt', 'PWNED'));
  });

  it('refuses a hardlink inside the root to a file outside it', () => {
    // realpath cannot help: a hardlink has no target to resolve. Link count is
    // the only signal that the name is not the file's only name.
    const s = sandbox();
    linkSync(s.victim, join(s.root, 'hard.txt'));
    const cr = open(s.root);
    expectRefusal(s, 'hardlink', () => cr.writeFile('hard.txt', 'PWNED'));
  });

  it('refuses a fifo rather than blocking on it forever', () => {
    // open(fifo, O_WRONLY) blocks until a reader appears. Without O_NONBLOCK a
    // named pipe planted in the root hangs the process indefinitely — in an
    // agent, worse than a refused write.
    const s = sandbox();
    try {
      execFileSync('mkfifo', [join(s.root, 'pipe')]);
    } catch {
      return; // platform without mkfifo
    }
    const cr = open(s.root);
    expectRefusal(s, 'not_regular_file', () => cr.writeFile('pipe', 'PWNED'));
  });
});

describe('ConfinedRoot — concurrent mutation', () => {
  it('refuses when the final component is swapped for a symlink after inspection', () => {
    const s = sandbox();
    const cr = open(s.root);
    expectRefusal(s, 'symlink_target', () =>
      cr.writeFile('notes.md', 'PWNED', {
        beforeOpen: () => symlinkSync(s.victim, join(s.root, 'notes.md')),
      }),
    );
  });

  it('refuses when an intermediate component is swapped after the walk', () => {
    const s = sandbox();
    mkdirSync(join(s.root, 'docs'));
    const cr = open(s.root);
    expectRefusal(s, 'component_swapped', () =>
      cr.writeFile('docs/notes.md', 'PWNED', {
        beforeOpen: () => {
          rmSync(join(s.root, 'docs'), { recursive: true, force: true });
          symlinkSync(s.outside, join(s.root, 'docs'));
        },
      }),
    );
  });

  it('does not delete a pre-existing outside file while refusing a swap', () => {
    // The defect this whole file exists for. With an intermediate directory
    // swapped to an outside symlink AND a file already present outside at the
    // same final name, an earlier implementation refused correctly and deleted
    // that file: it inferred "I created this" from a pre-swap stat, then removed
    // a recomputed path that by then named something else entirely.
    const s = sandbox();
    mkdirSync(join(s.root, 'docs'));
    writeFileSync(join(s.outside, 'notes.md'), 'VICTIM FILE');
    const cr = open(s.root);

    expectRefusal(s, 'component_swapped', () =>
      cr.writeFile('docs/notes.md', 'PWNED', {
        beforeOpen: () => {
          rmSync(join(s.root, 'docs'), { recursive: true, force: true });
          symlinkSync(s.outside, join(s.root, 'docs'));
        },
      }),
    );
    expect(readFileSync(join(s.outside, 'notes.md'), 'utf8')).toBe('VICTIM FILE');
  });

  it('refuses a multi-level ancestor swap', () => {
    const s = sandbox();
    mkdirSync(join(s.root, 'a'));
    mkdirSync(join(s.root, 'a', 'b'));
    const cr = open(s.root);
    expectRefusal(s, 'component_swapped', () =>
      cr.writeFile('a/b/c.md', 'PWNED', {
        beforeOpen: () => {
          rmSync(join(s.root, 'a'), { recursive: true, force: true });
          const shim = join(s.base, 'shim');
          mkdirSync(shim, { recursive: true });
          symlinkSync(s.outside, join(shim, 'b'));
          symlinkSync(shim, join(s.root, 'a'));
        },
      }),
    );
  });

  it('refuses a hardlink created on an existing target after validation', () => {
    const s = sandbox();
    writeFileSync(join(s.root, 'late.md'), 'ORIGINAL');
    const cr = open(s.root);
    expectRefusal(s, 'hardlink', () =>
      cr.writeFile('late.md', 'PWNED', {
        afterValidate: () => linkSync(join(s.root, 'late.md'), join(s.outside, 'late-link.md')),
      }),
    );
  });

  it('survives sustained concurrent parent swapping without damaging outside state', () => {
    // Deterministic hooks prove the guard fires at one exact interleaving. This
    // hammers real ones. Every outcome must be a clean refusal or a correct
    // write — never a corrupted or deleted victim.
    const s = sandbox();
    writeFileSync(join(s.outside, 'target.md'), 'VICTIM FILE');
    mkdirSync(join(s.root, 'race'));
    const cr = open(s.root);

    for (let i = 0; i < 200; i++) {
      try {
        rmSync(join(s.root, 'race'), { recursive: true, force: true });
        if (i % 2 === 0) symlinkSync(s.outside, join(s.root, 'race'));
        else mkdirSync(join(s.root, 'race'));
      } catch {
        /* mutator raced itself; irrelevant */
      }
      try {
        cr.writeFile('race/target.md', `ITERATION ${i}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementError);
      }
    }

    expect(readFileSync(join(s.outside, 'target.md'), 'utf8')).toBe('VICTIM FILE');
  });
});

describe('ConfinedRoot — write atomicity (C2)', () => {
  it('writes large content completely rather than short', () => {
    const s = sandbox();
    const cr = open(s.root);
    const big = 'X'.repeat(5 * 1024 * 1024);
    const out = cr.writeFile('big.md', big);
    expect(out.bytesWritten).toBe(big.length);
    expect(readFileSync(join(s.root, 'big.md'), 'utf8')).toBe(big);
  });

  it('leaves the original intact when refusing after validation', () => {
    const s = sandbox();
    const target = join(s.root, 'keep.md');
    writeFileSync(target, 'ORIGINAL');
    const cr = open(s.root);
    try {
      cr.writeFile('keep.md', 'REPLACEMENT', {
        afterValidate: () => linkSync(target, join(s.outside, 'keep-link.md')),
      });
    } catch {
      /* expected */
    }
    // Never empty, never partial — a naive truncate-then-write would leave both.
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  it('leaves no temporary-file debris', () => {
    const s = sandbox();
    const cr = open(s.root);
    cr.writeFile('debris/one.md', 'A');
    cr.writeFile('debris/two.md', 'B');
    expect(readdirSync(join(s.root, 'debris')).filter((f) => f.includes('tmp'))).toEqual([]);
  });
});

describe('ConfinedRoot — positive controls', () => {
  it('creates a new file inside the root', () => {
    const s = sandbox();
    const cr = open(s.root);
    const out = cr.writeFile('new.md', 'CREATED');
    expect(out.relativePath).toBe('new.md');
    expect(readFileSync(join(s.root, 'new.md'), 'utf8')).toBe('CREATED');
  });

  it('replaces an existing file inside the root', () => {
    const s = sandbox();
    writeFileSync(join(s.root, 'exists.md'), 'OLD');
    const cr = open(s.root);
    cr.writeFile('exists.md', 'NEW');
    expect(readFileSync(join(s.root, 'exists.md'), 'utf8')).toBe('NEW');
  });

  it('creates nested directories', () => {
    const s = sandbox();
    const cr = open(s.root);
    cr.writeFile('a/b/c/deep.md', 'NESTED');
    expect(readFileSync(join(s.root, 'a/b/c/deep.md'), 'utf8')).toBe('NESTED');
  });

  it('supports a root that is itself a symlink', () => {
    // Common and legitimate: /var -> /private/var on Darwin. The root is
    // resolved exactly once at construction, before any adversary-influenced
    // component appears.
    const s = sandbox();
    const linked = join(s.base, 'repo-link');
    symlinkSync(s.root, linked);
    const cr = open(linked);
    cr.writeFile('docs/ok.md', 'LEGITIMATE');
    expect(readFileSync(join(s.root, 'docs/ok.md'), 'utf8')).toBe('LEGITIMATE');
  });

  it('accepts case-variant spellings on either filesystem', () => {
    // The old lexical prefix comparison got this wrong on APFS: <root>/Docs/x
    // and <root>/docs/x are the same file but different strings. Deciding
    // containment by identity rather than spelling is what fixed it.
    const s = sandbox();
    const cr = open(s.root);
    cr.writeFile('docs/case.md', 'lower');
    cr.writeFile('Docs/case.md', 'upper');
    expect(existsSync(join(s.root, 'docs/case.md'))).toBe(true);
  });
});
