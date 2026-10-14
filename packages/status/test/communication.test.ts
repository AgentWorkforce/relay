import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  communicationDecisionInput,
  communicationReceipt,
  communicationStatus,
  decideCommunication,
  effectiveCommunicationStatus,
  readCommunicationStatus,
  communicationStatusSchemas,
} from '../src/communication.js';

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/communication-status.v1.json', import.meta.url), 'utf8')
);
describe('communication status v1 contract', () => {
  for (const fixture of fixtures.reads) {
    it(fixture.name, () => {
      expect(readCommunicationStatus(fixture.input, fixture.previous)).toEqual({
        status: fixture.expected,
        stale: fixture.stale,
      });
    });
  }
  it('the exported bundle matches the owned schemas and decision fixtures', () => {
    const bundle = JSON.parse(
      readFileSync(new URL('../contracts/communication-status.v1.json', import.meta.url), 'utf8')
    );
    expect(bundle.fixtures).toEqual(fixtures);
    expect(bundle.types).toEqual(
      Object.fromEntries(
        Object.entries(communicationStatusSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])
      )
    );
  });
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      const input = communicationDecisionInput.parse(fixture.input);
      expect(effectiveCommunicationStatus(input.status)).toBe(fixture.label);
      expect(decideCommunication(input)).toEqual(fixture.expected);
    });
  }
  const status = communicationStatus.parse(fixtures.cases[0].input.status);
  it('reconnecting and clearing Busy restores the saved admission policy', () => {
    const saved = {
      ...status,
      policy: {
        ...status.policy,
        admission: 'knock' as const,
        interruption: 'busy' as const,
      },
    };
    expect(effectiveCommunicationStatus({ ...saved, connection: 'offline' })).toBe('offline');
    expect(effectiveCommunicationStatus(saved)).toBe('busy');
    expect(
      effectiveCommunicationStatus({
        ...saved,
        policy: { ...saved.policy, interruption: 'available' },
      })
    ).toBe('knock');
  });
  it.each([
    null,
    {},
    { ...status, schemaVersion: 2 },
    { ...status, revision: 0 },
    { ...status, policy: { ...status.policy, admission: 'future_policy' } },
    { ...status, policy: { ...status.policy, revision: 0 } },
  ])('failed or unsupported reads cannot reset admission to Open', (input) => {
    expect(readCommunicationStatus(input, status)).toEqual({
      status,
      stale: true,
    });
  });
  it('a delivery decision is not a delivered receipt', () => {
    const input = communicationDecisionInput.parse(fixtures.cases[0].input);
    expect(decideCommunication(input).action).toBe('deliver');
    expect(communicationReceipt.safeParse(decideCommunication(input)).success).toBe(false);
  });
  it('an approval for another sender or recipient grants no access', () => {
    const input = communicationDecisionInput.parse(
      fixtures.cases.find((f: { name: string }) => f.name === 'approved knock admits that conversation').input
    );
    for (const side of ['sender', 'recipient'] as const) {
      const grants = input.grants.map((g) => ({
        ...g,
        [side]: { ...g[side], agentId: 'different_agent' },
      }));
      expect(decideCommunication({ ...input, grants }).action).toBe('request_approval');
    }
  });
});
