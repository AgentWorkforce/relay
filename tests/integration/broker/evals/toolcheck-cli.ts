/**
 * Wrong-tool-name trap (CLI).
 *
 * Reads the tool names the MCP server registers and the names the
 * using-agent-relay onboarding skill tells agents to call, then reports any tool
 * an agent could not actually invoke. Exits non-zero on a mismatch.
 *
 *   npm run eval:toolcheck
 *
 * Deterministic — no broker, no agents, no tokens.
 */
import fs from 'node:fs';
import path from 'node:path';

import { checkToolNames, extractToolRefs } from './scoring/toolcheck.js';

function repoRoot(): string {
  // dist/evals/toolcheck-cli.js → up 5 to repo root.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..');
}

/** Registered tool names = first string arg of each `server.registerTool(`. */
function registeredToolNames(mcpSource: string): string[] {
  const names = new Set<string>();
  const re = /registerTool\(\s*['"]([a-z0-9_]+)['"]/g;
  for (const m of mcpSource.matchAll(re)) names.add(m[1]);
  return [...names].sort();
}

function main(): void {
  const root = repoRoot();
  const mcpPath = path.join(root, 'packages/cli/src/cli/agent-relay-mcp.ts');
  const skillPath = path.join(root, '.claude/skills/using-agent-relay/SKILL.md');

  if (!fs.existsSync(mcpPath) || !fs.existsSync(skillPath)) {
    console.error(`Cannot find sources:\n  ${mcpPath}\n  ${skillPath}`);
    process.exit(2);
  }

  const registered = registeredToolNames(fs.readFileSync(mcpPath, 'utf8'));
  const referenced = extractToolRefs(fs.readFileSync(skillPath, 'utf8'));
  const result = checkToolNames(registered, referenced);

  console.log(`Registered tools (${registered.length}): ${registered.join(', ')}`);
  console.log(`Referenced in skill (${result.referenced.length} unique)\n`);

  if (result.ok) {
    console.log('✓ All onboarding tool names map to a registered tool.');
    process.exit(0);
  }

  console.error(`✗ ${result.mismatches.length} onboarding tool name(s) an agent CANNOT call:\n`);
  for (const m of result.mismatches) console.error(`  ${m.raw} — ${m.reason}`);
  console.error(
    '\nAgents told to call these will silently fail to send. Reconcile ' +
      `${path.relative(root, skillPath)} with the server's registered tools.`
  );
  process.exit(1);
}

main();
