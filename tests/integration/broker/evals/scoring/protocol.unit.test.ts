import { describe, expect, it } from 'vitest';

import { scoreAckDone, scoreChannelReply, scoreRelayChain } from './protocol.js';
import { inbound } from './fixtures.js';

describe('scoreAckDone', () => {
  it('full credit for ACK then DONE as DMs', () => {
    const events = [
      inbound('Worker', 'Lead', 'ACK: starting now'),
      inbound('Worker', 'Lead', 'DONE: result is 4'),
    ];
    const r = scoreAckDone(events, 'Worker');
    expect(r).toMatchObject({ ackPresent: true, donePresent: true, orderOk: true });
    expect(r.score).toBe(1);
  });

  it('counts DMs to the harness identity (simulated lead), not just a literal name', () => {
    const events = [
      inbound('Worker', 'test-harness-abc', 'ACK: starting now'),
      inbound('Worker', 'test-harness-abc', 'DONE: result is 4'),
    ];
    expect(scoreAckDone(events, 'Worker').score).toBe(1);
  });

  it('partial credit when DONE precedes ACK', () => {
    const events = [
      inbound('Worker', 'Lead', 'DONE: result is 4'),
      inbound('Worker', 'Lead', 'ACK: starting now'),
    ];
    const r = scoreAckDone(events, 'Worker');
    expect(r.orderOk).toBe(false);
    expect(r.score).toBeCloseTo(2 / 3);
  });

  it('one third credit when only ACK is present', () => {
    const events = [inbound('Worker', 'Lead', 'ACK: starting now')];
    expect(scoreAckDone(events, 'Worker').score).toBeCloseTo(1 / 3);
  });

  it('excludes channel posts (status must be a DM, not broadcast)', () => {
    const events = [
      inbound('Worker', '#general', 'ACK: starting now'),
      inbound('Worker', '#general', 'DONE: result is 4'),
    ];
    expect(scoreAckDone(events, 'Worker').score).toBe(0);
  });
});

describe('scoreChannelReply', () => {
  it('credits a reply in the expected channel', () => {
    const events = [inbound('Worker', '#proj-x', 'READY')];
    expect(scoreChannelReply(events, 'Worker', 'proj-x')).toEqual({
      repliedToShownChannel: true,
      wrongChannelReplies: 0,
    });
  });

  it('counts a DM to the sender as a wrong-channel reply', () => {
    const events = [inbound('Worker', 'Lead', 'READY')];
    expect(scoreChannelReply(events, 'Worker', 'proj-x')).toEqual({
      repliedToShownChannel: false,
      wrongChannelReplies: 1,
    });
  });

  it('counts a post to a different channel as wrong', () => {
    const events = [
      inbound('Worker', '#proj-x', 'READY'),
      inbound('Worker', '#random', 'oops'),
    ];
    expect(scoreChannelReply(events, 'Worker', 'proj-x')).toEqual({
      repliedToShownChannel: true,
      wrongChannelReplies: 1,
    });
  });
});

describe('scoreRelayChain', () => {
  const hops = [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
    { from: 'C', to: '#general' },
  ];

  it('full chain with intact payload', () => {
    const events = [
      inbound('A', 'B', 'code GH-1234'),
      inbound('B', 'C', 'code GH-1234'),
      inbound('C', '#general', 'FINAL: GH-1234'),
    ];
    expect(scoreRelayChain(events, hops, 'GH-1234', '#general')).toEqual({
      hopsCompleted: 3,
      payloadIntact: true,
    });
  });

  it('stops counting at the first broken hop', () => {
    const events = [inbound('A', 'B', 'code GH-1234')];
    expect(scoreRelayChain(events, hops, 'GH-1234', '#general')).toEqual({
      hopsCompleted: 1,
      payloadIntact: false,
    });
  });

  it('payload corruption fails the intact check', () => {
    const events = [
      inbound('A', 'B', 'code GH-1234'),
      inbound('B', 'C', 'code GH-1234'),
      inbound('C', '#general', 'FINAL: WRONG'),
    ];
    expect(scoreRelayChain(events, hops, 'GH-1234', '#general').payloadIntact).toBe(false);
  });
});
