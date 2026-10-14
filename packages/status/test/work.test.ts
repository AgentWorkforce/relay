import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  initialSessionWorkStatus,
  readSessionWorkStatus,
  sessionWorkEvent,
  sessionWorkStatus,
  transitionSessionWorkStatus,
  sessionStatusSchemas,
} from '../src/work.js';

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/session-status.v1.json', import.meta.url), 'utf8')
);
describe('work status v1 transition contract', () => {
  for (const fixture of fixtures.reads) {
    it(fixture.name, () => {
      expect(readSessionWorkStatus(fixture.input, fixture.previous)).toEqual({
        status: fixture.expected,
        stale: fixture.stale,
      });
    });
  }
  it('the exported bundle matches the owned schemas and transition fixtures', () => {
    const bundle = JSON.parse(
      readFileSync(new URL('../contracts/session-work.v1.json', import.meta.url), 'utf8')
    );
    expect(bundle.fixtures).toEqual(fixtures);
    expect(bundle.types).toEqual(
      Object.fromEntries(
        Object.entries(sessionStatusSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])
      )
    );
  });
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      let current = sessionWorkStatus.parse(fixture.initial);
      expect(initialSessionWorkStatus(current.identity)).toEqual(current);
      for (const step of fixture.steps) {
        const before = structuredClone(current);
        const result = transitionSessionWorkStatus(current, step.event);
        expect(result.outcome, step.event.eventId).toBe(step.outcome);
        expect(result.status, step.event.eventId).toEqual(sessionWorkStatus.parse(step.expected));
        expect(current).toEqual(before);
        current = result.status;
      }
    });
  }
  const working = sessionWorkStatus.parse(fixtures.cases[0].steps[0].expected);
  it.each([
    null,
    {},
    { ...working, schemaVersion: 2 },
    { ...working, state: 'future_state' },
    { ...working, revision: 0 },
    { ...working, identity: { ...working.identity, workspaceId: 'another' } },
  ])('retains the last supported snapshot after a failed or incompatible read', (input) => {
    expect(readSessionWorkStatus(input, working)).toEqual({
      status: working,
      stale: true,
    });
  });
  it('rejects malformed timestamps and unsafe revisions', () => {
    expect(
      sessionWorkStatus.safeParse({
        ...working,
        revision: Number.MAX_SAFE_INTEGER + 1,
      }).success
    ).toBe(false);
    expect(sessionWorkStatus.safeParse({ ...working, observedAt: 'yesterday' }).success).toBe(false);
    expect(
      sessionWorkEvent.safeParse({
        ...fixtures.cases[0].steps[0].event,
        sequence: -1,
      }).success
    ).toBe(false);
  });
  it('unknown producer names cannot mutate object prototypes', () => {
    const initial = initialSessionWorkStatus(working.identity);
    const result = transitionSessionWorkStatus(initial, {
      ...fixtures.cases[0].steps[0].event,
      producerId: '__proto__',
    });
    expect(result.outcome).toBe('applied');
    expect(Object.hasOwn(result.status.producerSequences, '__proto__')).toBe(true);
    expect(
      transitionSessionWorkStatus(result.status, {
        ...fixtures.cases[0].steps[0].event,
        producerId: '__proto__',
      }).outcome
    ).toBe('duplicate');
  });
});
