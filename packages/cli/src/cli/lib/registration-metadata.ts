/**
 * Caller-declared workforce identity attached to a spawn.
 *
 * One assembly shared by every surface that can start an agent — the MCP
 * `spawn` tool and `agent-relay fleet spawn` — so the declared semantics cannot
 * drift between them. It mirrors the broker's `AgentRegistrationMetadata`
 * (`crates/broker/src/fleet_wire.rs`), including the rule that `objective`
 * falls back to the spawn's task and is never derived from the agent's name.
 */
export interface DeclaredWorkforceInput {
  organization?: string;
  project?: string;
  workstream?: string;
  role?: string;
  objective?: string;
}

export type DeclaredWorkforceMetadata = Partial<Record<keyof DeclaredWorkforceInput, string>>;

/**
 * Build the declared metadata bag, omitting anything blank.
 *
 * Every key is conditional, `objective` included: emitting `objective:
 * undefined` would leave the object non-empty when nothing was declared, so
 * callers that branch on `Object.keys(...).length` would always take the
 * "something was declared" path.
 */
export function declaredWorkforceMetadata(
  input: DeclaredWorkforceInput,
  task?: string
): DeclaredWorkforceMetadata {
  // A blank declared objective counts as "not declared", so the task fallback
  // still applies. `??` alone would keep the blank, suppress the fallback, and
  // then drop the key at the trim step below — leaving no objective at all. The
  // broker filters blanks the same way before its fallback
  // (`AgentRegistrationMetadata::from_spawn_input` via `declared_string`).
  const objective = input.objective?.trim() ? input.objective : task;
  const declared: Array<[keyof DeclaredWorkforceInput, string | undefined]> = [
    ['organization', input.organization],
    ['project', input.project],
    ['workstream', input.workstream],
    ['role', input.role],
    ['objective', objective],
  ];
  const metadata: DeclaredWorkforceMetadata = {};
  for (const [key, value] of declared) {
    const trimmed = value?.trim();
    if (trimmed) metadata[key] = trimmed;
  }
  return metadata;
}
