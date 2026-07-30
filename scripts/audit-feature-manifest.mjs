#!/usr/bin/env node
/**
 * Audit .agentworkforce/features/manifest.yaml against the CLI's real surface.
 *
 * The manifest is the input to every feature-verification run, so drift there
 * silently shrinks coverage: a command nobody documented is a command nobody
 * verifies. `manifest-contract.test.ts` only checks a hand-maintained list, so
 * it can never notice a *newly added* command or MCP tool. This script derives
 * the surface instead of asserting a snapshot of it.
 *
 * Two surfaces are derived:
 *   1. The Commander leaf-command tree, by walking `--help` recursively.
 *   2. The MCP tool list, by a `tools/list` JSON-RPC call over stdio.
 *
 * Usage:
 *   node scripts/audit-feature-manifest.mjs
 *   node scripts/audit-feature-manifest.mjs --json
 *   node scripts/audit-feature-manifest.mjs --cli "node packages/cli/dist/cli/index.js"
 *
 * Exit codes:
 *   0  manifest matches the derived surface
 *   1  drift found (undocumented or stale entries)
 *   2  the audit itself could not run (CLI missing, help unparseable)
 *
 * Exit 2 is deliberately distinct: "the audit broke" must never be reported as
 * "the manifest is clean".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const manifestPath = join(repoRoot, '.agentworkforce/features/manifest.yaml');

const asJson = process.argv.includes('--json');
const cliArgIndex = process.argv.indexOf('--cli');
const cliCommand =
  cliArgIndex !== -1 && process.argv[cliArgIndex + 1]
    ? process.argv[cliArgIndex + 1]
    : process.env.RELAY_CLI || `node ${join(repoRoot, 'packages/cli/dist/cli/index.js')}`;

/**
 * Commands that exist but are intentionally absent from the manifest.
 *
 * Keep this list short and justified — every entry is coverage we are choosing
 * not to have. `help` is Commander's own builtin, not a relay feature.
 */
const UNDOCUMENTED_ALLOWLIST = new Set(['help']);

/** Subcommand trees too costly or destructive to walk during an audit. */
const NO_WALK = new Set(['help', 'uninstall']);

/**
 * Commands that dispatch on a positional argument instead of a subcommand, so
 * their documented usages (`relay telemetry enable`) are real but never appear
 * as leaves in the Commander tree.
 *
 * Keep this explicit. Treating any surviving parent as proof would mean a
 * removed child command could never be detected, because `deriveCliLeaves`
 * records every parent group as a leaf too.
 */
const POSITIONAL_DISPATCH = new Set(['telemetry']);

// ── surface derivation: CLI ───────────────────────────────────────────────────

function runHelp(argPath) {
  const [bin, ...prefix] = cliCommand.split(/\s+/);
  try {
    return execFileSync(bin, [...prefix, ...argPath, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: '1', AGENT_RELAY_DISABLE_UPDATE_CHECK: '1' },
    });
  } catch (err) {
    // Commander exits non-zero for some help paths but still writes usage.
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (out.includes('Usage:')) return out;
    throw new Error(`\`${cliCommand} ${argPath.join(' ')} --help\` failed: ${err.message}`);
  }
}

/**
 * Parse the "Commands:" block of a Commander help screen.
 *
 * Commander wraps long descriptions onto continuation lines that are indented
 * further than the command names, so a naive per-line split invents commands
 * out of description text. Anchor on the indentation of the first entry.
 */
function parseSubcommands(helpText) {
  const lines = helpText.split('\n');
  const start = lines.findIndex((line) => /^Commands:/.test(line.trim()));
  if (start === -1) return [];

  const names = [];
  let entryIndent = null;

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // left the Commands block
    if (entryIndent === null) entryIndent = indent;
    if (indent > entryIndent) continue; // wrapped description line

    const name = line.trim().split(/\s+/)[0];
    if (!name || name.startsWith('-')) continue;
    // Commander renders aliases as "status|st"; the first token is canonical.
    names.push(name.split('|')[0]);
  }

  return names;
}

/** Walk the command tree and return every leaf command path. */
function deriveCliLeaves() {
  const leaves = [];
  const visit = (path, depth) => {
    if (depth > 4) return; // relay's tree is 3 deep; guard against a help loop
    const children = parseSubcommands(runHelp(path));
    const walkable = children.filter((child) => !NO_WALK.has(child));

    // A no-walk child is still part of the surface — record it without
    // recursing, or the audit reports it as stale when the manifest has it.
    for (const child of children) {
      if (!NO_WALK.has(child)) continue;
      if (!UNDOCUMENTED_ALLOWLIST.has(child)) leaves.push([...path, child].join(' '));
    }

    if (walkable.length === 0) {
      if (path.length > 0) leaves.push(path.join(' '));
      return;
    }

    for (const child of walkable) visit([...path, child], depth + 1);

    // A group can also be a runnable leaf (e.g. `relay mcp` with subcommands).
    if (path.length > 0) leaves.push(path.join(' '));
  };

  visit([], 0);
  return [...new Set(leaves)].sort();
}

// ── surface derivation: MCP ───────────────────────────────────────────────────

/**
 * List MCP tools via a stdio JSON-RPC handshake against `relay mcp`.
 *
 * Resolves to null (rather than throwing) when the server cannot be reached, so
 * a broken MCP path degrades to an explicit "could not derive" in the report
 * instead of an empty tool list that would read as "every tool is stale".
 */
function deriveMcpTools() {
  return new Promise((resolve) => {
    const [bin, ...prefix] = cliCommand.split(/\s+/);
    const child = spawn(bin, [...prefix, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', AGENT_RELAY_DISABLE_UPDATE_CHECK: '1' },
    });

    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 20_000);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            finish(msg.result.tools.map((tool) => tool.name).sort());
          }
        } catch {
          // Partial frame — wait for the rest.
        }
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      finish(null);
    });

    // A broken pipe here — spawn failure, or our own SIGTERM in finish() — must
    // not surface as an uncaught 'error' event. That is not a promise
    // rejection, so it would escape main().catch and exit 1, which the audit
    // workflow reads as confirmed drift and acts on.
    child.stdin.on('error', () => finish(null));

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'feature-manifest-audit', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

/**
 * MCP tool names the server source still registers, whether or not a default
 * stdio probe exposes them. Used to tell "removed" apart from "conditional".
 */
function mcpToolsRegisteredInSource() {
  const names = new Set();

  // Registrations are spread across the whole CLI tree, not just `mcp/`:
  // `submit_result` lives in cli/agent-relay-mcp.ts. Scan recursively so a tool
  // is never called stale merely because it is declared in a sibling file.
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // No source tree (running against a published CLI) — callers then see
      // every probe-missing tool as stale, the safe direction for an audit.
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
      // `registerTool(` and its name argument sit on separate lines here, so
      // this must be a whole-file match rather than a line-based grep.
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)) {
        names.add(match[1]);
      }
    }
  };

  walk(join(repoRoot, 'packages/cli/src/cli'));
  return names;
}

/**
 * Warn when the built CLI is older than the sources it is derived from.
 *
 * The audit can only see what the built CLI exposes, so a stale `dist` makes it
 * under-report and print MANIFEST_CLEAN while real commands go undocumented.
 * That is exactly what happened here: a stale dist hid 16 shipped commands
 * (`agent me`, `agent presence`, the whole `cloud room` and `cloud integration`
 * trees) across several audit runs that all reported clean.
 *
 * @returns A warning string, or null when the build is current or unknowable.
 */
function staleBuildWarning() {
  const distEntry = join(repoRoot, 'packages/cli/dist/cli/index.js');
  const srcDir = join(repoRoot, 'packages/cli/src');

  let distMtime;
  try {
    distMtime = statSync(distEntry).mtimeMs;
  } catch {
    return null; // auditing a published CLI, not this checkout
  }

  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // unreadable file; ignore
      }
    }
  };
  walk(srcDir);

  if (newest === 0 || newest <= distMtime) return null;
  const minutes = Math.round((newest - distMtime) / 60_000);
  return (
    `packages/cli/dist is ${minutes} minute(s) older than packages/cli/src. ` +
    `This audit only sees what the BUILT CLI exposes, so newer commands are invisible ` +
    `and a "clean" result understates drift. Rebuild first: npm run build --workspace=agent-relay`
  );
}

// ── manifest ─────────────────────────────────────────────────────────────────

function loadManifest() {
  const manifest = parse(readFileSync(manifestPath, 'utf8'));
  const features = [];
  for (const [categoryKey, category] of Object.entries(manifest.categories ?? {})) {
    for (const feature of category.features ?? []) {
      features.push({ ...feature, category: categoryKey });
    }
  }
  return { manifest, features };
}

/**
 * Reduce a documented `cli:` string to its command path.
 *
 * Manifest entries carry usage decoration — `relay agent add <name> [options]`
 * — so strip anything that is not a bare command word.
 */
function documentedCommandPath(cliString) {
  const tokens = cliString.trim().split(/\s+/);
  if (tokens[0] === 'relay' || tokens[0] === 'agent-relay') tokens.shift();
  const path = [];
  for (const token of tokens) {
    // Underscores are load-bearing: `set_topic`, `mark_read`, `send_group`.
    if (/^[a-z][a-z0-9_-]*$/.test(token)) path.push(token);
    else break; // hit <arg>, [opt], or --flag
  }
  return path.join(' ');
}

// ── report ───────────────────────────────────────────────────────────────────

async function main() {
  const { manifest, features } = loadManifest();

  let cliLeaves;
  try {
    cliLeaves = deriveCliLeaves();
  } catch (err) {
    const failure = { ok: false, auditable: false, error: err.message };
    console.error(asJson ? JSON.stringify(failure, null, 2) : `AUDIT_ERROR: ${err.message}`);
    process.exit(2);
  }

  const mcpTools = await deriveMcpTools();
  const staleBuild = staleBuildWarning();

  const documentedCommands = new Set(
    features.flatMap((f) => (f.cli ? [documentedCommandPath(f.cli)] : [])).filter(Boolean)
  );
  const documentedMcp = new Set(features.flatMap((f) => (f.mcp ? [f.mcp] : [])));

  // A parent command counts as covered when a child of it is documented:
  // `relay message` needs no entry of its own if `relay message post` has one.
  const coveredPrefixes = new Set();
  for (const cmd of documentedCommands) {
    const parts = cmd.split(' ');
    for (let i = 1; i <= parts.length; i++) coveredPrefixes.add(parts.slice(0, i).join(' '));
  }

  const undocumentedCommands = cliLeaves.filter(
    (leaf) => !coveredPrefixes.has(leaf) && !UNDOCUMENTED_ALLOWLIST.has(leaf)
  );

  const cliLeafSet = new Set(cliLeaves);

  // Some commands dispatch on a positional argument rather than a subcommand
  // (`relay telemetry enable` is `telemetry [action]`), so those documented
  // usages have no leaf of their own.
  //
  // Accepting *any* surviving prefix would hide almost every real removal:
  // deleting `fleet spawn` still leaves `fleet`, so the entry would validate
  // against its own parent and never be reported. A documented command must
  // therefore match a real leaf exactly, unless its parent is a known
  // positional-dispatch command listed above.
  const staleCommands = [...documentedCommands].filter((cmd) => {
    if (cliLeafSet.has(cmd)) return false;
    const parts = cmd.split(' ');
    const parent = parts.slice(0, -1).join(' ');
    if (parts.length > 1 && POSITIONAL_DISPATCH.has(parent) && cliLeafSet.has(parent)) return false;
    return true;
  });

  const undocumentedMcp = mcpTools ? mcpTools.filter((tool) => !documentedMcp.has(tool)) : [];

  // A documented tool missing from a default stdio probe is not automatically
  // stale: `list_actions`/`invoke_action`/`submit_result` only register when an
  // actions surface is wired in (see mcp/action-tools.ts). Split the two cases
  // on whether the server source still registers the tool at all — absent from
  // both the probe and the source is genuine drift; absent from only the probe
  // is coverage we did not exercise, and is reported as such.
  const registeredInSource = mcpToolsRegisteredInSource();
  const documentedMcpMissing = mcpTools ? [...documentedMcp].filter((tool) => !mcpTools.includes(tool)) : [];
  const staleMcp = documentedMcpMissing.filter((tool) => !registeredInSource.has(tool));
  const conditionalMcp = documentedMcpMissing.filter((tool) => registeredInSource.has(tool));

  const drift = undocumentedCommands.length + staleCommands.length + undocumentedMcp.length + staleMcp.length;

  // Half an audit is not a clean audit. If the MCP surface could not be
  // derived, MCP drift was never checked, so reporting "clean" would be a
  // false negative of exactly the kind this script exists to prevent. Exit 2
  // marks it unrunnable rather than clean or drifted.
  if (mcpTools === null) {
    const failure = {
      ok: false,
      auditable: false,
      error:
        'MCP tool list could not be derived, so MCP drift was not checked. ' +
        'Refusing to report a partial audit as clean.',
      cliCommand,
      undocumentedCommands,
      staleCommands,
    };
    console.error(asJson ? JSON.stringify(failure, null, 2) : `AUDIT_ERROR: ${failure.error}`);
    process.exit(2);
  }

  const report = {
    ok: drift === 0,
    auditable: true,
    manifestVersion: manifest.version,
    manifestUpdated: manifest.updated,
    cliCommand,
    mcpDerivable: mcpTools !== null,
    staleBuildWarning: staleBuild,
    counts: {
      cliLeaves: cliLeaves.length,
      documentedCommands: documentedCommands.size,
      mcpTools: mcpTools?.length ?? null,
      documentedMcp: documentedMcp.size,
      features: features.length,
    },
    undocumentedCommands,
    staleCommands,
    undocumentedMcp,
    staleMcp,
    conditionalMcp,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Feature Manifest Audit ===`);
    console.log(`manifest ${manifest.version} (updated ${manifest.updated})`);
    console.log(`CLI: ${cliCommand}`);
    console.log(
      `derived ${cliLeaves.length} CLI leaves, ${mcpTools?.length ?? 'n/a'} MCP tools; ` +
        `manifest documents ${documentedCommands.size} commands, ${documentedMcp.size} MCP tools ` +
        `across ${features.length} features`
    );
    if (staleBuild) {
      console.log(`\nWARN  ${staleBuild}`);
    }
    if (mcpTools === null) {
      console.log('\nWARN  MCP tool list could not be derived — MCP drift not checked.');
    }
    const section = (title, items) => {
      if (items.length === 0) return;
      console.log(`\n${title} (${items.length}):`);
      for (const item of items) console.log(`  - ${item}`);
    };
    section('UNDOCUMENTED commands (exist in CLI, missing from manifest)', undocumentedCommands);
    section('STALE commands (in manifest, not in CLI)', staleCommands);
    section('UNDOCUMENTED MCP tools', undocumentedMcp);
    section('STALE MCP tools (in manifest, not registered anywhere)', staleMcp);
    section('CONDITIONAL MCP tools (registered in source, not in this probe)', conditionalMcp);
    console.log(drift === 0 ? '\nMANIFEST_CLEAN' : `\nMANIFEST_DRIFT: ${drift} item(s)`);
  }

  process.exit(drift === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`AUDIT_ERROR: ${err.message}`);
  process.exit(2);
});
