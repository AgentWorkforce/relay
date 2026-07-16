#!/usr/bin/env node
// Changelog fragment tooling — zero-dependency.
//
// Pending user-visible changes live as one small file per change under
// `changelog.d/` instead of being written directly into the [Unreleased]
// section of CHANGELOG.md. That way two PRs never edit the same lines, so a
// changelog entry can't merge-conflict or land under the wrong (already
// released) version heading.
//
// Subcommands:
//   add       Scaffold a new fragment file.
//   preview   Print what [Unreleased] will render as, from the fragments.
//   check     Validate every fragment (and CHANGELOG.md sanity). CI entry point.
//   release   Compile fragments into a new dated version section, then delete.
//
// Run `node scripts/changelog.mjs help` for flag details.

import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAGMENT_DIR = path.join(ROOT, 'changelog.d');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

/** Keep a Changelog sections plus Relay's major-change extras, in render order. */
const SECTIONS = [
  'Breaking Changes',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  'Migration Guidance',
];
const SECTION_LOOKUP = new Map(SECTIONS.map((s) => [s.toLowerCase(), s]));

const LEVELS = ['patch', 'minor', 'major'];
const LEVEL_RANK = new Map(LEVELS.map((l, i) => [l, i]));

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

// ---------------------------------------------------------------------------
// Fragment parsing
// ---------------------------------------------------------------------------

/**
 * Parse a fragment's raw text into { type, level, body }.
 * @throws Error with a human-readable message on any validation failure.
 */
function parseFragment(raw, name) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`${name}: missing \`---\` frontmatter block`);
  }
  const [, frontmatter, bodyRaw] = match;

  const fields = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`${name}: frontmatter line is not \`key: value\`: "${line}"`);
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    fields[key] = line.slice(idx + 1).trim();
  }

  const typeRaw = (fields.type ?? '').trim();
  const type = SECTION_LOOKUP.get(typeRaw.toLowerCase());
  if (!type) {
    throw new Error(
      `${name}: invalid or missing \`type\` (${JSON.stringify(typeRaw)}). ` +
        `Expected one of: ${SECTIONS.join(', ')}`
    );
  }

  const level = (fields.level ?? '').trim().toLowerCase();
  if (!LEVEL_RANK.has(level)) {
    throw new Error(
      `${name}: invalid or missing \`level\` (${JSON.stringify(fields.level ?? '')}). ` +
        `Expected one of: ${LEVELS.join(', ')}`
    );
  }

  const body = bodyRaw.trim();
  if (!body) {
    throw new Error(`${name}: empty body — write the changelog entry after the frontmatter`);
  }

  return { type, level, body, name };
}

/** List fragment filenames (excludes README and dotfiles). */
function fragmentFiles() {
  let entries;
  try {
    entries = readdirSync(FRAGMENT_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md' && !f.startsWith('.'))
    .sort();
}

/** Read and parse every fragment. Throws an aggregated error if any are invalid. */
function loadFragments() {
  const errors = [];
  const fragments = [];
  for (const file of fragmentFiles()) {
    try {
      fragments.push(parseFragment(readFileSync(path.join(FRAGMENT_DIR, file), 'utf8'), file));
    } catch (err) {
      errors.push(err?.message ?? String(err));
    }
  }
  if (errors.length) {
    throw new Error(`Invalid changelog fragment(s):\n  - ${errors.join('\n  - ')}`);
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Turn a fragment body into a bullet, indenting any continuation lines. */
function toBullet(body) {
  const lines = body.split(/\r?\n/);
  const [first, ...rest] = lines;
  const head = `- ${first.trim()}`;
  const tail = rest.map((l) => (l.trim() ? `  ${l.trim()}` : ''));
  return [head, ...tail].join('\n');
}

/** Group entries (fragments and/or pre-parsed bullets) by section into ordered markdown. */
function renderSections(entriesByType) {
  const blocks = [];
  for (const section of SECTIONS) {
    const bullets = entriesByType.get(section);
    if (!bullets || bullets.length === 0) continue;
    blocks.push(`### ${section}\n\n${bullets.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** Highest SemVer level across fragments, or null if there are none. */
function highestLevel(fragments) {
  let best = -1;
  for (const f of fragments) best = Math.max(best, LEVEL_RANK.get(f.level));
  return best === -1 ? null : LEVELS[best];
}

// ---------------------------------------------------------------------------
// CHANGELOG.md editing
// ---------------------------------------------------------------------------

/** Parse existing bullets already sitting under the [Unreleased] heading, by section. */
function parseUnreleasedBody(changelog) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+\[Unreleased/i.test(l));
  const byType = new Map();
  if (start === -1) return byType;

  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+\[/.test(line)) break; // next version heading
    const sectionMatch = /^###\s+(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      current = SECTION_LOOKUP.get(sectionMatch[1].trim().toLowerCase()) ?? null;
      continue;
    }
    if (/^\s*-\s+/.test(line) && current) {
      if (!byType.has(current)) byType.set(current, []);
      byType.get(current).push(line.replace(/^\s+/, ''));
    } else if (/^\s+\S/.test(line) && current && byType.get(current)?.length) {
      // continuation of the previous bullet
      const arr = byType.get(current);
      arr[arr.length - 1] += `\n${line.replace(/\s+$/, '')}`;
    }
  }
  return byType;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/`[^`]*`/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-') || 'change'
  );
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function cmdAdd(argv) {
  const { flags, positional } = parseFlags(argv);
  const type = SECTION_LOOKUP.get(String(flags.type ?? '').toLowerCase());
  const level = String(flags.level ?? '').toLowerCase();
  const text = (flags.text ?? positional.join(' ')).toString().trim();

  const problems = [];
  if (!type) problems.push(`--type must be one of: ${SECTIONS.join(', ')}`);
  if (!LEVEL_RANK.has(level)) problems.push(`--level must be one of: ${LEVELS.join(', ')}`);
  if (!text) problems.push('provide the entry text (positional arg or --text)');
  if (problems.length) {
    console.error(`changelog add: ${problems.join('; ')}`);
    process.exit(1);
  }

  const base = flags.slug ? slugify(String(flags.slug)) : slugify(text);
  const existing = new Set(fragmentFiles());
  let slug = base;
  let n = 2;
  while (existing.has(`${slug}.md`)) slug = `${base}-${n++}`;

  const file = path.join(FRAGMENT_DIR, `${slug}.md`);
  writeFileSync(file, `---\ntype: ${type}\nlevel: ${level}\n---\n\n${text}\n`);
  console.log(`Created ${path.relative(ROOT, file)}`);
}

function cmdPreview() {
  const fragments = loadFragments();
  if (fragments.length === 0) {
    console.log('## [Unreleased]\n\n_(no pending changelog fragments)_');
    return;
  }
  const byType = new Map();
  for (const f of fragments) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(toBullet(f.body));
  }
  const level = highestLevel(fragments);
  const heading = level ? `[Unreleased - ${level[0].toUpperCase()}${level.slice(1)}]` : '[Unreleased]';
  console.log(`## ${heading}\n\n${renderSections(byType)}`);
}

function cmdCheck() {
  const problems = [];
  try {
    loadFragments();
  } catch (err) {
    problems.push(err?.message ?? String(err));
  }
  try {
    const changelog = readFileSync(CHANGELOG, 'utf8');
    if (CONFLICT_MARKER.test(changelog)) {
      problems.push(
        'CHANGELOG.md contains an unresolved merge conflict marker (<<<<<<<, =======, or >>>>>>>)'
      );
    }
  } catch (err) {
    problems.push(`CHANGELOG.md: ${err?.message ?? String(err)}`);
  }

  if (problems.length) {
    console.error('changelog check failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const count = fragmentFiles().length;
  console.log(`changelog check passed (${count} pending fragment${count === 1 ? '' : 's'}).`);
}

function bumpVersion(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`Cannot parse current version: ${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function cmdRelease(argv) {
  const { flags } = parseFlags(argv);
  const fragments = loadFragments();
  if (fragments.length === 0) {
    console.error('changelog release: no fragments in changelog.d/ to release');
    process.exit(1);
  }

  const level = highestLevel(fragments);
  let version = flags.version ? String(flags.version).replace(/^v/, '') : null;
  if (!version) {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    version = bumpVersion(pkg.version, level);
  }
  const date = flags.date ? String(flags.date) : new Date().toISOString().slice(0, 10);

  // Merge fragments with any inline bullets already under [Unreleased].
  const changelog = readFileSync(CHANGELOG, 'utf8');
  const byType = parseUnreleasedBody(changelog);
  for (const f of fragments) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(toBullet(f.body));
  }
  const sections = renderSections(byType);

  // Rebuild the file: reset [Unreleased] to empty, insert the new version block.
  const lines = changelog.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => /^##\s+\[Unreleased/i.test(l));
  if (headingIdx === -1) throw new Error('CHANGELOG.md has no [Unreleased] heading');
  let nextIdx = lines.findIndex((l, i) => i > headingIdx && /^##\s+\[/.test(l));
  if (nextIdx === -1) nextIdx = lines.length;

  const rebuilt = [
    ...lines.slice(0, headingIdx),
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    '',
    sections,
    '',
    ...lines.slice(nextIdx),
  ].join('\n');

  writeFileSync(CHANGELOG, rebuilt.replace(/\n{3,}/g, '\n\n'));

  if (flags['keep-fragments']) {
    console.log('Kept fragments (--keep-fragments).');
  } else {
    for (const f of fragments) rmSync(path.join(FRAGMENT_DIR, f.name));
  }
  console.log(`Released ${version} (${level}) with ${fragments.length} fragment(s).`);
}

function cmdHelp() {
  console.log(`Changelog fragment tooling

Usage: node scripts/changelog.mjs <command> [flags]

Commands:
  add       Scaffold a fragment.
              --type <${SECTIONS.join('|')}>
              --level <${LEVELS.join('|')}>
              [--slug <name>] "<entry text>"
  preview   Render what [Unreleased] will look like from the fragments.
  check     Validate all fragments and CHANGELOG.md (CI entry point).
  release   Compile fragments into a dated version section and delete them.
              [--version <x.y.z>]  (default: bump package.json by highest level)
              [--date <YYYY-MM-DD>] (default: today)
              [--keep-fragments]
  help      Show this message.`);
}

const [, , command, ...rest] = process.argv;
try {
  switch (command) {
    case 'add':
      cmdAdd(rest);
      break;
    case 'preview':
      cmdPreview();
      break;
    case 'check':
      cmdCheck();
      break;
    case 'release':
      cmdRelease(rest);
      break;
    case 'help':
    case undefined:
      cmdHelp();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      cmdHelp();
      process.exit(1);
  }
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(1);
}
