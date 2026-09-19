import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROOF_ACTIONS, pullRequestAction, pullRequestNumber } from './event-from-input.mjs';

const delivery = (type, extra = {}) => ({
  approver: 'someone',
  event: { type, payload: { pull_request: { number: 1792 }, ...extra } },
});

describe('listener event type', () => {
  it('accepts the `pull_request.<action>` names Cloud actually delivers', () => {
    // Every hosted run failed at the proof's first step on this: the listener
    // sends `pull_request.synchronize`, and an exact `pull_request` check
    // rejected it as a deployment misconfiguration.
    for (const action of PROOF_ACTIONS) {
      assert.equal(pullRequestNumber(delivery(`pull_request.${action}`)), 1792, action);
    }
  });

  it('still accepts a bare `pull_request` type and an envelope with no type', () => {
    assert.equal(pullRequestNumber(delivery('pull_request')), 1792);
    assert.equal(pullRequestNumber({ event: { payload: { pull_request: { number: 7 } } } }), 7);
  });

  it('refuses another event kind loudly, naming what arrived', () => {
    assert.throws(
      () => pullRequestNumber(delivery('issues.opened')),
      /proves pull requests; the listener delivered a "issues.opened" event/
    );
    // A look-alike prefix is a different kind, not a pull_request action.
    assert.throws(() => pullRequestNumber(delivery('pull_request_review.submitted')), /delivered a/);
  });
});

describe('proof-worthy actions', () => {
  it('reads the action from the event name or the webhook payload', () => {
    assert.equal(pullRequestAction(delivery('pull_request.synchronize')), 'synchronize');
    assert.equal(pullRequestAction(delivery('pull_request', { action: 'labeled' })), 'labeled');
    assert.equal(pullRequestAction(delivery('pull_request')), null);
  });

  it('covers exactly the actions the Actions dispatcher subscribed to', () => {
    assert.deepEqual([...PROOF_ACTIONS].sort(), [
      'edited',
      'opened',
      'ready_for_review',
      'reopened',
      'synchronize',
    ]);
    for (const ignored of ['labeled', 'closed', 'assigned', 'review_requested']) {
      assert.equal(PROOF_ACTIONS.has(ignored), false, ignored);
    }
  });
});
