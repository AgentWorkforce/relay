import { describe, expect, it, vi } from 'vitest';

import {
  HARNESS_TARGETS,
  fetchSkill,
  findHarnessTarget,
  installSkill,
  parseSkill,
  type SkillWriter,
  type TargetContext,
} from './skills-install.js';

const SAMPLE = [
  '---',
  'name: orchestrating-agent-relay',
  'description: Use when you orchestrate agents.',
  '---',
  '',
  '# Orchestrate',
  '',
  'Body with """quotes""" and a \\ backslash.',
  '',
].join('\n');

const CTX: TargetContext = { projectRoot: '/proj', homeDir: '/home/me' };

function memoryWriter(): { writer: SkillWriter; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    writer: {
      exists: (p) => files.has(p),
      write: (p, c) => {
        files.set(p, c);
      },
    },
  };
}

describe('parseSkill', () => {
  it('splits frontmatter from body', () => {
    const skill = parseSkill(SAMPLE);
    expect(skill.name).toBe('orchestrating-agent-relay');
    expect(skill.description).toBe('Use when you orchestrate agents.');
    expect(skill.body.startsWith('# Orchestrate')).toBe(true);
    expect(skill.body).not.toContain('---');
  });

  it('treats a frontmatter-less document as all body', () => {
    const skill = parseSkill('# Just a heading\n\ntext');
    expect(skill.name).toBeUndefined();
    expect(skill.body).toBe('# Just a heading\n\ntext');
  });

  it('strips surrounding quotes from frontmatter scalars', () => {
    const skill = parseSkill('---\nname: "quoted"\n---\nbody');
    expect(skill.name).toBe('quoted');
  });
});

describe('installSkill', () => {
  it('writes one file per harness with harness-correct paths', () => {
    const { writer, files } = memoryWriter();
    const skill = parseSkill(SAMPLE);
    const results = installSkill({ skill, scope: 'project', harnesses: HARNESS_TARGETS, ctx: CTX, writer });

    expect(results.every((r) => r.status === 'installed')).toBe(true);
    expect(files.get('/proj/.claude/skills/orchestrate/SKILL.md')).toContain(
      'name: orchestrating-agent-relay'
    );
    // Codex discovers skills as `.agents/skills/<name>/SKILL.md`.
    expect(files.has('/proj/.agents/skills/orchestrate/SKILL.md')).toBe(true);
    expect(files.has('/proj/.cursor/commands/orchestrate.md')).toBe(true);
    expect(files.has('/proj/.gemini/commands/orchestrate.toml')).toBe(true);
    // OpenCode uses the plural `commands/` directory.
    expect(files.has('/proj/.opencode/commands/orchestrate.md')).toBe(true);
  });

  it('resolves global paths under the home directory', () => {
    const { writer, files } = memoryWriter();
    installSkill({
      skill: parseSkill(SAMPLE),
      scope: 'global',
      harnesses: HARNESS_TARGETS,
      ctx: CTX,
      writer,
    });
    expect(files.has('/home/me/.claude/skills/orchestrate/SKILL.md')).toBe(true);
    // Codex user-level skills live under ~/.agents/skills.
    expect(files.has('/home/me/.agents/skills/orchestrate/SKILL.md')).toBe(true);
    // OpenCode's global config lives under ~/.config/opencode/commands.
    expect(files.has('/home/me/.config/opencode/commands/orchestrate.md')).toBe(true);
  });

  it('gives Claude and Codex the full skill but OpenCode only the body', () => {
    const { writer, files } = memoryWriter();
    installSkill({
      skill: parseSkill(SAMPLE),
      scope: 'project',
      harnesses: HARNESS_TARGETS,
      ctx: CTX,
      writer,
    });
    expect(files.get('/proj/.claude/skills/orchestrate/SKILL.md')).toContain('description:');
    expect(files.get('/proj/.agents/skills/orchestrate/SKILL.md')).toContain('description:');
    expect(files.get('/proj/.opencode/commands/orchestrate.md')).not.toContain('description:');
    expect(files.get('/proj/.opencode/commands/orchestrate.md')).toContain('# Orchestrate');
  });

  it('renders Gemini TOML with an escaped prompt block', () => {
    const { writer, files } = memoryWriter();
    installSkill({
      skill: parseSkill(SAMPLE),
      scope: 'project',
      harnesses: HARNESS_TARGETS,
      ctx: CTX,
      writer,
    });
    const toml = files.get('/proj/.gemini/commands/orchestrate.toml') ?? '';
    expect(toml).toContain('description = "Use when you orchestrate agents."');
    expect(toml).toContain('prompt = """');
    // `"""` inside the body must be escaped so it can't close the TOML string.
    expect(toml).toContain('\\"\\"\\"quotes\\"\\"\\"');
  });

  it('reports overwrite when the file already exists', () => {
    const { writer } = memoryWriter();
    const claude = [findHarnessTarget('claude')!];
    installSkill({ skill: parseSkill(SAMPLE), scope: 'project', harnesses: claude, ctx: CTX, writer });
    const second = installSkill({
      skill: parseSkill(SAMPLE),
      scope: 'project',
      harnesses: claude,
      ctx: CTX,
      writer,
    });
    expect(second[0].status).toBe('overwritten');
  });

  it('records a failure without throwing when the writer throws', () => {
    const writer: SkillWriter = {
      exists: () => false,
      write: () => {
        throw new Error('EACCES');
      },
    };
    const results = installSkill({
      skill: parseSkill(SAMPLE),
      scope: 'project',
      harnesses: [findHarnessTarget('claude')!],
      ctx: CTX,
      writer,
    });
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('EACCES');
  });
});

describe('fetchSkill', () => {
  it('returns the response text on success', async () => {
    const stub = vi.fn(async () => new Response('hello skill', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    await expect(fetchSkill('https://example.com/skill.md')).resolves.toBe('hello skill');
    vi.unstubAllGlobals();
  });

  it('throws a clear error on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    );
    await expect(fetchSkill('https://example.com/skill.md')).rejects.toThrow(/HTTP 404/);
    vi.unstubAllGlobals();
  });

  it('throws when the skill body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('   ', { status: 200 }))
    );
    await expect(fetchSkill('https://example.com/skill.md')).rejects.toThrow(/empty/);
    vi.unstubAllGlobals();
  });

  it('aborts and reports a timeout when the download stalls', async () => {
    // A fetch that never resolves until its signal aborts.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      )
    );
    await expect(fetchSkill('https://example.com/skill.md', 10)).rejects.toThrow(/Timed out/);
    vi.unstubAllGlobals();
  });
});
