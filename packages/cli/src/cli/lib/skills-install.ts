/**
 * Core logic for `agent-relay skills add` — fetching a published skill and
 * installing it into the right per-harness directory for either the current
 * project or the user's global config.
 *
 * This module is deliberately free of any interactive/TTY concerns so it can
 * be unit-tested in isolation. The TUI lives in `./skills-tui.ts` and the
 * command wiring in `../commands/skills.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where a skill is installed: into the current project or the user's home. */
export type SkillScope = 'project' | 'global';

/** The `/orchestrate` skill published at agentrelay.com. */
export const ORCHESTRATE_SKILL = {
  /** Slug used for the installed file/directory name (the slash command). */
  slug: 'orchestrate',
  /** Canonical source of the skill markdown. */
  url: 'https://agentrelay.com/skill.md',
} as const;

/** A skill split into its YAML frontmatter fields and markdown body. */
export interface ParsedSkill {
  /** Raw, unmodified source (frontmatter + body). */
  raw: string;
  /** `name:` from frontmatter, if present. */
  name?: string;
  /** `description:` from frontmatter, if present. */
  description?: string;
  /** Markdown body with the leading frontmatter block removed. */
  body: string;
}

/**
 * Parse a skill markdown document, extracting `name`/`description` from the
 * leading `---` YAML frontmatter block (if any) and the body that follows.
 * Tolerant by design: a document with no frontmatter yields `body === raw`.
 */
export function parseSkill(raw: string): ParsedSkill {
  const normalized = raw.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized);
  if (!match) {
    return { raw, body: normalized.trim() };
  }

  const frontmatter = match[1];
  const body = normalized.slice(match[0].length).trim();
  const name = readScalar(frontmatter, 'name');
  const description = readScalar(frontmatter, 'description');
  return { raw, body, name, description };
}

function readScalar(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
  const m = re.exec(frontmatter);
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/** Resolution context handed to each harness target. */
export interface TargetContext {
  projectRoot: string;
  homeDir: string;
}

/** A coding harness we know how to install a skill into. */
export interface HarnessTarget {
  /** Stable id, matches the CLI registry (`claude`, `codex`, …). */
  id: string;
  /** Human-friendly label shown in the TUI. */
  label: string;
  /** Absolute file path the skill is written to for the given scope. */
  resolvePath: (scope: SkillScope, ctx: TargetContext) => string;
  /** Render the on-disk content for this harness from the parsed skill. */
  render: (skill: ParsedSkill, slug: string) => string;
}

function tomlEscape(body: string): string {
  // Triple-quoted TOML strings only need `"""` and backslash escaped.
  return body.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

/**
 * The set of harnesses `skills add` can target. Each maps the skill onto the
 * harness's native custom-command / skill convention.
 */
export const HARNESS_TARGETS: HarnessTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    resolvePath: (scope, ctx) =>
      path.join(
        scope === 'global' ? ctx.homeDir : ctx.projectRoot,
        '.claude',
        'skills',
        ORCHESTRATE_SKILL.slug,
        'SKILL.md'
      ),
    // Claude skills are directories with a SKILL.md carrying frontmatter.
    render: (skill) => ensureTrailingNewline(skill.raw),
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    resolvePath: (scope, ctx) =>
      path.join(
        scope === 'global' ? ctx.homeDir : ctx.projectRoot,
        '.codex',
        'prompts',
        `${ORCHESTRATE_SKILL.slug}.md`
      ),
    // Codex custom prompts are plain markdown; frontmatter would be inert text.
    render: (skill) => ensureTrailingNewline(skill.body),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    resolvePath: (scope, ctx) =>
      path.join(
        scope === 'global' ? ctx.homeDir : ctx.projectRoot,
        '.cursor',
        'commands',
        `${ORCHESTRATE_SKILL.slug}.md`
      ),
    // Cursor commands accept frontmatter (it surfaces the description).
    render: (skill) => ensureTrailingNewline(skill.raw),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    resolvePath: (scope, ctx) =>
      path.join(
        scope === 'global' ? ctx.homeDir : ctx.projectRoot,
        '.gemini',
        'commands',
        `${ORCHESTRATE_SKILL.slug}.toml`
      ),
    // Gemini custom commands are TOML with a `prompt` field.
    render: (skill) => {
      const description = skill.description ?? `The /${ORCHESTRATE_SKILL.slug} skill`;
      return (
        `description = ${JSON.stringify(description)}\n` + `prompt = """\n${tomlEscape(skill.body)}\n"""\n`
      );
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    resolvePath: (scope, ctx) =>
      scope === 'global'
        ? path.join(ctx.homeDir, '.config', 'opencode', 'command', `${ORCHESTRATE_SKILL.slug}.md`)
        : path.join(ctx.projectRoot, '.opencode', 'command', `${ORCHESTRATE_SKILL.slug}.md`),
    // OpenCode commands are plain markdown prompts.
    render: (skill) => ensureTrailingNewline(skill.body),
  },
];

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Look up a harness target by id. */
export function findHarnessTarget(id: string): HarnessTarget | undefined {
  return HARNESS_TARGETS.find((t) => t.id === id);
}

/** Default resolution context: real project root + home directory. */
export function defaultTargetContext(projectRoot: string): TargetContext {
  return { projectRoot, homeDir: os.homedir() };
}

/** Outcome of installing into a single harness. */
export interface InstallResult {
  harnessId: string;
  label: string;
  path: string;
  status: 'installed' | 'overwritten' | 'failed';
  error?: string;
}

/** Side-effecting writer, injected so tests can capture without touching disk. */
export interface SkillWriter {
  exists: (filePath: string) => boolean;
  write: (filePath: string, content: string) => void;
}

/** Default writer: mkdir -p the parent and write the file. */
export const fsWriter: SkillWriter = {
  exists: (filePath) => fs.existsSync(filePath),
  write: (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  },
};

/**
 * Install the skill into each requested harness for the given scope.
 * Never throws for a single-harness failure — it is recorded in the result so
 * the caller can report a partial success.
 */
export function installSkill(opts: {
  skill: ParsedSkill;
  scope: SkillScope;
  harnesses: HarnessTarget[];
  ctx: TargetContext;
  writer?: SkillWriter;
  slug?: string;
}): InstallResult[] {
  const writer = opts.writer ?? fsWriter;
  const slug = opts.slug ?? ORCHESTRATE_SKILL.slug;
  return opts.harnesses.map((target) => {
    const filePath = target.resolvePath(opts.scope, opts.ctx);
    try {
      const existed = writer.exists(filePath);
      writer.write(filePath, target.render(opts.skill, slug));
      return {
        harnessId: target.id,
        label: target.label,
        path: filePath,
        status: existed ? 'overwritten' : 'installed',
      };
    } catch (err) {
      return {
        harnessId: target.id,
        label: target.label,
        path: filePath,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Fetch the published skill markdown over HTTPS. Throws a clear error on a
 * non-2xx response so the command can surface it to the user.
 */
export async function fetchSkill(url: string = ORCHESTRATE_SKILL.url): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'text/markdown, text/plain, */*' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reach ${url}: ${message}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to download skill from ${url} (HTTP ${res.status})`);
  }
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Skill at ${url} was empty`);
  }
  return text;
}
