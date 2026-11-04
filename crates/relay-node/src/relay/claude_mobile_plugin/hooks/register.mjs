// The private core authenticates the mobile sender and the native Claude PID. No peer
// inbox content, sender label, or model instruction can create a native turn.
// Native HTTP opens the socket from Claude itself, never a tool subprocess. The
// one helper process, the doorbell's curl, only learns that something waits.
const PREFIX = "/claude/mobile-handoff/";
// Without a doorbell (curl missing), the plugin falls back to asking on a
// timer, as plugins before the doorbell did.
const PERIOD_MS = 2000;
// Reconnecting a closed doorbell: the core restarting, or refusing a
// session it cannot identify yet.
const RECONNECT_MS = [1000, 2000, 5000, 15000, 30000, 60000];
// Claude marks its session idle a moment after a turn completes; a message
// queued while it worked is collected on these retries, then on the next
// turn's completion or ring.
const IDLE_RETRY_MS = [250, 750, 2000, 5000, 15000, 30000];
// A poll or an answer that failed (the core restarting, the owner lookup
// briefly unavailable) is retried on these delays, the last repeating while
// answers remain; nothing is retried while nothing failed. A queued message
// the plugin still misses is rung again by the core while Claude is idle.
const FAILURE_RETRY_MS = [1000, 2000, 5000, 15000, 30000, 60000];
const MAX_RESULTS = 32;
const PERMISSION_WAIT_MS = 300000;
// UTF-16 code units use at most three UTF-8 bytes each; keep the payload
// comfortably below the core's 96 KiB limit, including the visible notice.
const MAX_ANSWER_UNITS = 24000;

// Do not forward arbitrary hook text to other devices. These are provider
// refusals, not transport failures, and none makes a submission retryable.
function refusalCode(reason) {
  switch (reason) {
    case "the session was stopped and nobody has sent input since":
    case "the prompt was removed from the queue before it ran": return "stopped";
    case "the host has ended its input": return "host_ended";
    case "the run reached its --max-turns limit": return "turn_limit";
    case "the run is past its --max-budget-usd limit": return "budget_limit";
    default: return undefined;
  }
}

function mobileAnswer(text) {
  if (text.length <= MAX_ANSWER_UNITS) return text;
  let end = MAX_ANSWER_UNITS;
  if (text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) end--;
  return text.slice(0, end) + "\n\n[Answer shortened for mobile. The complete answer is in Claude on your computer.]";
}

function absolute(path) {
  return typeof path === "string" && !path.includes("\0") && path.startsWith("/");
}

let bridge;
let polling = false;
let again = false;
let running = Promise.resolve();
let waiting = false;
let pending = false;
let pollFailures = 0;
let pollRetry;
let resultFailures = 0;
let resultRetry;
let retry;
let doorbell = 0;
let child;
let watched;
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

async function configured($) {
  if (!bridge) {
    const config = JSON.parse(await $.fs.read(`${$.plugin.root}/bridge.json`));
    if (!absolute(config.socket)) {
      throw new Error("Agent Relay mobile bridge is not configured.");
    }
    bridge = config;
  }
  return bridge;
}

async function request($, route, body) {
  if (!bridge) await configured($);
  const response = await $.http.fetch("http://relay" + PREFIX + route, {
    socketPath: bridge.socket, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Agent Relay is unavailable.");
  const value = JSON.parse(response.text);
  if (value.error || value.ok === false) throw new Error("Agent Relay refused the request.");
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
        await request($, "result", answer);
      } catch {
        break;
      }
      if (results[0] === answer) results.shift();
    }
  } finally {
    sending = false;
  }
  if (!results.length) {
    resultFailures = 0;
  } else if (!confirming && !resultRetry) {
    const delay = FAILURE_RETRY_MS[Math.min(resultFailures++, FAILURE_RETRY_MS.length - 1)];
    resultRetry = $.clock.after(delay, () => {
      resultRetry = undefined;
      void flush($);
    });
  }
}

// Collects the next message, if any. A ring arriving mid-collection runs
// one more collection after it, so none is lost.
function collect($) {
  if (polling) {
    again = true;
    return running;
  }
  polling = true;
  running = collecting($);
  return running;
}

async function collecting($) {
  let failed = false;
  try {
    do {
      again = false;
      failed = (await tick($)) === "failed";
    } while (again);
  } finally {
    polling = false;
  }
  if (pollRetry) pollRetry.cancel();
  pollRetry = undefined;
  if (!failed) {
    pollFailures = 0;
  } else if (pollFailures < FAILURE_RETRY_MS.length) {
    pollRetry = $.clock.after(FAILURE_RETRY_MS[pollFailures++], () => {
      pollRetry = undefined;
      void collect($);
    });
  }
}

async function tick($) {
  try {
    const current = await $.session.id();
    if (watched !== undefined && watched !== current) listen($);
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
    let action;
    try {
      action = await request($, "poll", { version: version.version });
    } catch {
      pending = true;
      return "failed";
    }
    waiting = action.waiting === true;
    // A message handed over may have others queued behind it; only a poll
    // with nothing at all says the queue is empty.
    pending = waiting || Boolean(action.action);
    if (!action.action || !action.lease_id || attempted.has(action.lease_id)) return;
    if (await $.session.id() !== current) return;
    if (action.action !== "submit" || typeof action.control_token !== "string" || !action.control_token) return;
    attempted.add(action.lease_id);
    if (typeof action.text !== "string" || !action.text.trim()) {
      await request($, "ack", { lease_id: action.lease_id, outcome: "failed" });
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
        // Claude stays idle, so the next queued message may go now.
        again = true;
      } else if (forward) {
        controlToken = action.control_token;
      }
      const acknowledgement = {
        lease_id: action.lease_id,
        outcome: admitted?.drop === undefined ? "started" : "failed",
      };
      const refusal = refusalCode(admitted?.drop);
      // Older cores accept exactly two fields. Negotiate diagnostics on
      // each action so a plugin upgrade or rollback cannot lose its ack.
      if (action.refusal_codes === true && refusal) acknowledgement.refusal = refusal;
      await request($, "ack", acknowledgement);
    } finally {
      confirming = false;
    }
    await flush($);
  } catch {
    // A lost response might follow an accepted native prompt. Never replay
    // it. The durable core journal surfaces uncertainty to the owner.
  }
}

// After a turn, collects what was queued while Claude worked, retrying
// briefly until Claude reports itself idle.
function collectWhenIdle($, attempt = 0) {
  if (retry) retry.cancel();
  retry = undefined;
  void collect($).then(() => {
    if (!waiting || attempt >= IDLE_RETRY_MS.length) return;
    retry = $.clock.after(IDLE_RETRY_MS[attempt], () => collectWhenIdle($, attempt + 1));
  });
}

// The doorbell: a helper process holds a response from the core open, and
// the core adds a line whenever this session has a message to collect. The
// line carries nothing; the message comes over `poll`, from Claude itself.
// Each call replaces the previous helper (session start, /clear, resume).
function listen($) {
  const generation = ++doorbell;
  if (child) void child.return();
  child = undefined;
  if (timer) timer.cancel();
  timer = undefined;
  void (async () => {
    let failures = 0;
    while (generation === doorbell) {
      let spawned = false;
      let started = false;
      try {
        const { socket } = await configured($);
        watched = await $.session.id();
        const stream = $.process.spawn({
          argv: ["curl", "-sSfN", "--unix-socket", socket, "http://relay" + PREFIX + "watch"],
        });
        child = stream;
        spawned = true;
        let line = "";
        for await (const { stream: from, text } of stream) {
          started = true;
          if (generation !== doorbell) break;
          if (from !== "stdout") continue;
          line += text;
          let end;
          while ((end = line.indexOf("\n")) >= 0) {
            if (line.slice(0, end).includes('"ring"')) {
              failures = 0;
              pending = true;
              void collect($);
            }
            line = line.slice(end + 1);
          }
          if (line.length > 4096) line = "";
        }
      } catch {
        // A helper that never started (no curl) cannot ring; ask on a timer.
        // An unreadable bridge file leaves nothing to ask; reconnecting
        // retries it.
        if (spawned && !started && generation === doorbell) {
          timer = $.clock.every(PERIOD_MS, () => collect($));
          return;
        }
      }
      if (generation !== doorbell) return;
      await $.clock.sleep(RECONNECT_MS[Math.min(failures++, RECONNECT_MS.length - 1)]);
    }
  })();
}

export function register(on) {
  bridge = undefined;
  polling = false;
  again = false;
  running = Promise.resolve();
  waiting = false;
  pending = false;
  pollFailures = 0;
  pollRetry = undefined;
  resultFailures = 0;
  resultRetry = undefined;
  retry = undefined;
  doorbell = 0;
  child = undefined;
  watched = undefined;
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
  on("session.start", async ($, event, next) => {
    const result = await next(event);
    listen($);
    return result;
  });

  // /clear and resume end one session and continue in another: listen for
  // the new one once it exists. The hook itself must stay fast.
  on("session.end", async ($, event, next) => {
    const result = await next(event);
    $.clock.after(1000, () => listen($));
    return result;
  });

  on("turn.start", async ($, event, next) => {
    if (event.agentId) return next(event);
    const at = submitted.findIndex((item) => item.text === event.text);
    const item = at < 0 ? undefined : submitted[at];
    const token = item ? item.token : controlToken;
    mobileTurn = item ? { id: event.turnId, token } : undefined;
    if (token && (!item || item.forward)) turnTokens.set(event.turnId, token);
    if (at >= 0) submitted.splice(at, 1);
    return next(event);
  });

  on("classic.PermissionRequest", async ($, event, next) => {
    const result = await next(event);
    // Preserve decisions from the person's existing hooks. Only a turn that
    // originated in the verified mobile queue uses the remote approval path.
    if (!mobileTurn || result?.decision || result?.block !== undefined || result?.preventContinuation) return result;
    try {
      const body = {
        request_id: mobileTurn.id + "-" + (++permissionSequence),
        tool_name: event.tool_name, tool_input: event.tool_input, control_token: mobileTurn.token,
      };
      const until = await $.clock.now() + PERMISSION_WAIT_MS;
      // Native HTTP has a fixed 30-second deadline. Each server poll waits
      // at most 15 seconds while retaining one idempotent permission ticket.
      for (let attempt = 0; attempt < 24 && await $.clock.now() < until; attempt++) {
        const reply = await request($, "permission", body);
        if (!reply.handled) return result;
        if (reply.pending === true) continue;
        if (reply.decision?.behavior !== "allow" && reply.decision?.behavior !== "deny") {
          throw new Error("Unrecognized native permission decision.");
        }
        return { ...result, decision: reply.decision };
      }
      throw new Error("The mobile permission request expired.");
    } catch {
      return { ...result, decision: { behavior: "deny", message: "Agent Relay could not confirm your approval. Try again when it reconnects." } };
    }
  }).catch(($, event, next) => next(event));

  on("turn.complete", async ($, event, next) => {
    const result = await next(event);
    if (event.agentId) return result;
    // A ring's poll may still be running, or may have handed over one of
    // several messages: ask again whenever anything may be left.
    if (pending || waiting) collectWhenIdle($);
    if (event.turnId === mobileTurn?.id) mobileTurn = undefined;
    const token = turnTokens.get(event.turnId);
    turnTokens.delete(event.turnId);
    const answer = result.text ?? event.answer;
    if (token && answer?.trim() && results.length < MAX_RESULTS) {
      const current = await $.session.id();
      if (current === session) {
        results.push({ turn_id: event.turnId, text: mobileAnswer(answer), reason: event.reason, control_token: token });
        // The owner's verification can take a Cloud round trip; never hold
        // the turn's completion on it.
        void flush($);
      }
    }
    return result;
  });
}
