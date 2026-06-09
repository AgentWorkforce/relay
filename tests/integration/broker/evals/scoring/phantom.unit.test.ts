import { describe, expect, it } from 'vitest';

import { detectIntents, detectPhantomsForAgent } from './phantom.js';
import { inbound, stream } from './fixtures.js';

describe('detectIntents', () => {
  it('detects forward-looking intent with a target', () => {
    const spans = detectIntents("Okay, I'll tell Lead the result now.");
    expect(spans).toHaveLength(1);
    expect(spans[0].verb).toBe('tell');
    expect(spans[0].target).toBe('lead');
  });

  it('detects present-continuous narration', () => {
    const spans = detectIntents('Messaging Bob about the result.');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[0].verb).toBe('messaging');
    expect(spans[0].target).toBe('bob');
  });

  it('ignores past-tense narration', () => {
    expect(detectIntents('I told Bob the answer and I sent the code.')).toHaveLength(0);
  });

  it('ignores negated phrasings', () => {
    expect(detectIntents('I wrote the text without sending it.')).toHaveLength(0);
    expect(detectIntents("Do not post to the channel.")).toHaveLength(0);
  });

  it('filters stopword targets', () => {
    const spans = detectIntents("I'll reply to you shortly.");
    expect(spans).toHaveLength(1);
    expect(spans[0].target).toBeUndefined();
  });
});

describe('detectPhantomsForAgent', () => {
  it('no phantom when intent is backed by a matching send', () => {
    const events = [
      stream('Bob', "I'll reply to Alice with PONG."),
      inbound('Bob', 'Alice', 'PONG'),
    ];
    const r = detectPhantomsForAgent(events, 'Bob');
    expect(r.totalIntents).toBe(1);
    expect(r.phantoms).toHaveLength(0);
    expect(r.satisfiedIntents).toBe(1);
  });

  it('flags a phantom when intent has no send', () => {
    const events = [stream('Bob', "I'll tell Alice the result.")];
    const r = detectPhantomsForAgent(events, 'Bob');
    expect(r.phantoms).toHaveLength(1);
    expect(r.phantoms[0].agent).toBe('Bob');
    expect(r.phantoms[0].target).toBe('alice');
  });

  it('a targeted intent is satisfied by any send (used the tool, wrong target)', () => {
    const events = [
      stream('Bob', "I'll tell Lead the status."),
      inbound('Bob', 'SomeoneElse', 'status'),
    ];
    expect(detectPhantomsForAgent(events, 'Bob').phantoms).toHaveLength(0);
  });

  it('flags the unbacked intent when there are more intents than sends', () => {
    const events = [
      stream('Bob', "I'll message Alice. Then I will notify Carol."),
      inbound('Bob', 'Alice', 'hi'),
    ];
    const r = detectPhantomsForAgent(events, 'Bob');
    expect(r.totalIntents).toBe(2);
    expect(r.phantoms).toHaveLength(1);
    expect(r.phantoms[0].target).toBe('carol');
  });

  it('zero intents and zero sends yields no phantoms', () => {
    const events = [stream('Bob', 'Just thinking out loud about the problem.')];
    const r = detectPhantomsForAgent(events, 'Bob');
    expect(r.totalIntents).toBe(0);
    expect(r.phantoms).toHaveLength(0);
  });

  it('strips ANSI before matching', () => {
    const events = [stream('Bob', "\x1b[32mI'll post READY to #general\x1b[0m")];
    const r = detectPhantomsForAgent(events, 'Bob');
    expect(r.totalIntents).toBe(1);
    expect(r.phantoms).toHaveLength(1);
  });
});
