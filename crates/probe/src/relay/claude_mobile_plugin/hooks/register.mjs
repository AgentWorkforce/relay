// The private core authenticates the mobile sender and the native Claude PID. No peer
// inbox content, sender label, or model instruction can create a native turn.
// Native HTTP opens the socket from Claude itself, never a tool subprocess.
const PREFIX = '/claude/mobile-handoff/';
const PERIOD_MS = 2000;
const MAX_RESULTS = 32;
const PERMISSION_WAIT_MS = 300000;
// UTF-16 code units use at most three UTF-8 bytes each; keep the payload
// comfortably below the core's 96 KiB limit, including the visible notice.
const MAX_ANSWER_UNITS = 24000;

function mobileAnswer(text) {
  if (text.length <= MAX_ANSWER_UNITS) return text;
  let end = MAX_ANSWER_UNITS;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return (
    text.slice(0, end) +
    '\n\n[Answer shortened for mobile. The complete answer is in Claude on your computer.]'
  );
}

function absolute(path) {
  return typeof path === 'string' && !path.includes('\0') && path.startsWith('/');
}

let bridge;
let polling = false;
let sending = false;
let confirming = false;
let session;
let timer;
let attempted = new Set();
let results = [];
let submitted = [];
let mobileTurn;
let controlToken;
let turnTokens = new Map();
let permissionSequence = 0;

async function request($, route, body) {
  if (!bridge) {
    const config = JSON.parse(await $.fs.read(`${$.plugin.root}/bridge.json`));
    if (!absolute(config.socket)) {
      throw new Error('Agent Relay mobile bridge is not configured.');
    }
    bridge = config;
  }
  const response = await $.http.fetch('http://relay' + PREFIX + route, {
    socketPath: bridge.socket,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Agent Relay is unavailable.');
  const value = JSON.parse(response.text);
  if (value.error || value.ok === false) throw new Error('Agent Relay refused the request.');
  return value.data ?? value;
}

// Answers go out when their turn completes and are retried by later ticks.
// One sender at a time keeps them in order; a session switch may clear the
// queue while a send is in flight, so only the answer just sent is removed.
// The core refuses answers to a submission it has not confirmed yet, so they
// wait for the acknowledgment.
async function flush($) {
  if (sending) return;
  sending = true;
  try {
    while (results.length && !confirming) {
      const answer = results[0];
      try {
        await request($, 'result', answer);
      } catch {
        break;
      }
      if (results[0] === answer) results.shift();
    }
  } finally {
    sending = false;
  }
}

async function tick($) {
  if (polling) return;
  polling = true;
  try {
    const current = await $.session.id();
    if (session !== current) {
      session = current;
      attempted.clear();
      results.length = 0;
      submitted.length = 0;
      mobileTurn = undefined;
      controlToken = undefined;
      turnTokens.clear();
    }
    // Results have a provider turn ID and the core uses an idempotency key.
    // They may be retried; a native prompt may never be retried this way.
    // A delayed answer must not prevent polling for the next user turn.
    await flush($);
    const version = await $.session.version();
    const action = await request($, 'poll', { version: version.version });
    if (!action.action || !action.lease_id || attempted.has(action.lease_id)) return;
    if ((await $.session.id()) !== current) return;
    if (action.action !== 'submit' || typeof action.control_token !== 'string' || !action.control_token)
      return;
    attempted.add(action.lease_id);
    if (typeof action.text !== 'string' || !action.text.trim()) {
      await request($, 'ack', { lease_id: action.lease_id, outcome: 'failed' });
      return;
    }
    // The mod remains identifiable to hooks and policy gates. asUser is the
    // documented native input path for text authenticated as the user's.
    // A teammate's message (forward_answer false) keeps the owner's
    // approval authority for its turn but neither sends its answer to the
    // owner's phone nor engages the owner's reply subscription.
    const forward = action.forward_answer !== false;
    submitted.push({ lease: action.lease_id, text: action.text, token: action.control_token, forward });
    confirming = true;
    try {
      const admitted = await $.prompt.submit({ text: action.text, asUser: true });
      if (admitted?.drop !== undefined) {
        const at = submitted.findIndex((item) => item.lease === action.lease_id);
        if (at >= 0) submitted.splice(at, 1);
      } else if (forward) {
        controlToken = action.control_token;
      }
      await request($, 'ack', {
        lease_id: action.lease_id,
        outcome: admitted?.drop === undefined ? 'started' : 'failed',
      });
    } finally {
      confirming = false;
    }
    await flush($);
  } catch {
    // A lost response might follow an accepted native prompt. Never replay
    // it. The durable core journal surfaces uncertainty to the owner.
  } finally {
    polling = false;
  }
}

export function register(on) {
  bridge = undefined;
  polling = false;
  sending = false;
  confirming = false;
  session = undefined;
  timer = undefined;
  attempted = new Set();
  results = [];
  submitted = [];
  mobileTurn = undefined;
  controlToken = undefined;
  turnTokens = new Map();
  permissionSequence = 0;
  on('session.start', async ($, event, next) => {
    const result = await next(event);
    if (timer) timer.cancel();
    timer = $.clock.every(PERIOD_MS, () => tick($));
    return result;
  });

  on('turn.start', async ($, event, next) => {
    if (event.agentId) return next(event);
    const at = submitted.findIndex((item) => item.text === event.text);
    const item = at < 0 ? undefined : submitted[at];
    const token = item ? item.token : controlToken;
    mobileTurn = item ? { id: event.turnId, token } : undefined;
    if (token && (!item || item.forward)) turnTokens.set(event.turnId, token);
    if (at >= 0) submitted.splice(at, 1);
    return next(event);
  });

  on('classic.PermissionRequest', async ($, event, next) => {
    const result = await next(event);
    // Preserve decisions from the person's existing hooks. Only a turn that
    // originated in the verified mobile queue uses the remote approval path.
    if (!mobileTurn || result?.decision || result?.block !== undefined || result?.preventContinuation)
      return result;
    try {
      const body = {
        request_id: mobileTurn.id + '-' + ++permissionSequence,
        tool_name: event.tool_name,
        tool_input: event.tool_input,
        control_token: mobileTurn.token,
      };
      const until = (await $.clock.now()) + PERMISSION_WAIT_MS;
      // Native HTTP has a fixed 30-second deadline. Each server poll waits
      // at most 15 seconds while retaining one idempotent permission ticket.
      for (let attempt = 0; attempt < 24 && (await $.clock.now()) < until; attempt++) {
        const reply = await request($, 'permission', body);
        if (!reply.handled) return result;
        if (reply.pending === true) continue;
        if (reply.decision?.behavior !== 'allow' && reply.decision?.behavior !== 'deny') {
          throw new Error('Unrecognized native permission decision.');
        }
        return { ...result, decision: reply.decision };
      }
      throw new Error('The mobile permission request expired.');
    } catch {
      return {
        ...result,
        decision: {
          behavior: 'deny',
          message: 'Agent Relay could not confirm your approval. Try again when it reconnects.',
        },
      };
    }
  }).catch(($, event, next) => next(event));

  on('turn.complete', async ($, event, next) => {
    const result = await next(event);
    if (event.agentId) return result;
    if (event.turnId === mobileTurn?.id) mobileTurn = undefined;
    const token = turnTokens.get(event.turnId);
    turnTokens.delete(event.turnId);
    const answer = result.text ?? event.answer;
    if (token && answer?.trim() && results.length < MAX_RESULTS) {
      const current = await $.session.id();
      if (current === session) {
        results.push({
          turn_id: event.turnId,
          text: mobileAnswer(answer),
          reason: event.reason,
          control_token: token,
        });
        // The owner's verification can take a Cloud round trip; never hold
        // the turn's completion on it.
        void flush($);
      }
    }
    return result;
  });
}
