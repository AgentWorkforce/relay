import { describe, expect, it } from 'vitest';
import { hash, readAssignment, type Assignment } from './protocol.js';
import { BridgeStore } from './store.js';
import golden from './__tests__/golden.json' with { type: 'json' };

describe('agreement with relay-chief', () => {
  // golden.json was written by relay-chief's own hash, readAssignment and reportSchema.
  const assignment = golden.assignment as Assignment;

  it('computes the same digest', () => {
    expect(hash(assignment)).toBe(golden.digest);
  });

  it('accepts what relay-chief accepts', () => {
    const read = readAssignment(
      {
        workspaceId: 'ws-1',
        senderAgentId: 'agent-chief',
        recipientAgentId: 'agent-worker',
        recipientAddress: 'worker@node',
      },
      { chief_assignment: assignment, assignment_digest: golden.digest },
      {
        chiefAgentId: 'agent-chief',
        chiefId: 'chief-1',
        organizationId: 'org-1',
        projectId: 'project-1',
        repositories: ['acme/app'],
        actions: ['investigate'],
        maxReservationMicros: 5000,
        maxEvidenceAgeMs: 3_600_000,
      },
      golden.now
    );
    expect(read.digest).toBe(golden.digest);
  });

  it('produces a report in the shape relay-chief parses', () => {
    const store = new BridgeStore(':memory:');
    store.claim({
      assignment,
      digest: golden.digest,
      agentName: 'agent',
      invocationKey: 'key',
      budgetMicros: 1_000_000,
      now: golden.now,
    });
    expect(store.dueReports(golden.now).map((due) => due.report)).toEqual([golden.report]);
    store.close();
  });
});
