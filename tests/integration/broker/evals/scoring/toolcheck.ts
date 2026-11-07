/**
 * Wrong-tool-name trap (deterministic).
 *
 * Onboarding that tells agents to call a tool the MCP server doesn't register is
 * a real, silent failure mode: the agent "messages" but nothing is sent. This
 * cross-references the tool names referenced in onboarding docs against the names
 * the server actually registers, and flags any that an agent could not call.
 *
 * Pure functions only — the CLI (`toolcheck-cli.ts`) supplies the real inputs.
 */
export interface ToolRef {
  raw: string;
  prefix: string;
  name: string;
}

export interface ToolMismatch {
  raw: string;
  reason: string;
}

export interface ToolCheckResult {
  registered: string[];
  referenced: ToolRef[];
  mismatches: ToolMismatch[];
  ok: boolean;
}

/** Parse `mcp__<prefix>__<name>` into its parts. */
export function parseToolRef(raw: string): ToolRef | null {
  const m = /^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.exec(raw);
  if (!m) return null;
  return { raw, prefix: m[1], name: m[2] };
}

/** Extract every `mcp__*__*` reference from arbitrary text. */
export function extractToolRefs(text: string): string[] {
  return Array.from(text.matchAll(/mcp__[a-z0-9-]+__[a-z0-9_]+/g), (m) => m[0]);
}

/**
 * Check referenced tool names against the registered set. A reference fails if
 * its server prefix is not `serverName`, or its action name is not registered.
 */
export function checkToolNames(
  registered: string[],
  referencedRaw: string[],
  serverName = 'agent-relay'
): ToolCheckResult {
  const regSet = new Set(registered);
  const seen = new Set<string>();
  const referenced: ToolRef[] = [];
  const mismatches: ToolMismatch[] = [];

  for (const raw of referencedRaw) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const ref = parseToolRef(raw);
    if (!ref) {
      mismatches.push({ raw, reason: 'unparseable tool reference' });
      continue;
    }
    referenced.push(ref);
    if (ref.prefix !== serverName) {
      mismatches.push({
        raw,
        reason: `wrong server prefix "${ref.prefix}" (registered server is "${serverName}")`,
      });
    } else if (!regSet.has(ref.name)) {
      mismatches.push({ raw, reason: `no such tool "${ref.name}" on the server` });
    }
  }

  return { registered, referenced, mismatches, ok: mismatches.length === 0 };
}
