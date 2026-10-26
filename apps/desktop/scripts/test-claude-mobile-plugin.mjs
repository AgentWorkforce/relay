import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "../probe/src/relay/claude_mobile_plugin/hooks/register.mjs";

async function fixture(options = {}) {
  const hooks = new Map();
  const calls = [];
  const submitted = [];
  const commands = [];
  let tick;
  let id = "session-a";
  const $ = {
    plugin: { root: "/test/plugin" },
    fs: { read: async () => JSON.stringify(options.bridge ?? { socket: "/private/relay.sock" }) },
    process: { run: async () => { throw new Error("The native bridge must not launch a subprocess"); } },
    http: { fetch: async (url, init) => {
      const route = new URL(url).pathname.split("/").at(-1);
      const body = JSON.parse(init.body);
      calls.push({ url, init, route, body });
      if (options.reject?.(route)) throw new Error("response lost");
      const data = route === "poll" ? options.action ?? { action: null }
        : route === "permission" ? options.permissionReplies?.shift() ?? options.permission ?? { handled: false } : { accepted: true };
      if (route === "poll" && options.changeSession) id = "session-b";
      return { ok: true, status: 200, text: JSON.stringify({ data }), headers: {} };
    } },
    session: { id: async () => id, version: async () => ({ version: "2.1.310", base: "2.1.310", builtAt: "2026-10-23T17:43:32Z" }) },
    clock: { now: async () => Date.now(), every: (_ms, fn) => { tick = fn; return { cancel() {} }; } },
    command: { run: async (value) => { commands.push(value); } },
    prompt: { submit: async (value) => {
      submitted.push(value);
      return options.drop ? { drop: "Policy refused" } : { text: value.text };
    } },
  };
  register((name, fn) => { hooks.set(name, fn); return { catch() {} }; });
  await hooks.get("session.start")($, {}, async () => ({}));
  return { $, hooks, calls, submitted, commands, tick: () => tick() };
}

const turn = { action: "submit", delivery_id: "d1", lease_id: "lease-1", control_token: "control-a", text: "Continue the user's task" };

test("reading the queue without an authenticated action submits nothing", async () => {
  const f = await fixture();
  await f.tick();
  assert.deepEqual(f.submitted, []);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.calls.find((call) => call.route === "poll").body, { version: "2.1.310" });
});

test("a lost acknowledgment never resubmits a native user turn", async () => {
  const f = await fixture({ action: turn, reject: (route) => route === "ack" });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.submitted, [{ text: turn.text, asUser: true }]);
});

test("an unsupported background action cannot replace the native session", async () => {
  const f = await fixture({ action: { ...turn, action: "background" } });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.submitted, []);
  assert.equal(f.calls.some((call) => call.route === "ack"), false);
});

test("a core refusal never falls back to submitting peer-framed text", async () => {
  const f = await fixture({ action: turn, reject: () => true });
  await f.tick();
  assert.deepEqual(f.submitted, []);
  assert.deepEqual(f.commands, []);
});

test("a conversation switch while polling cannot deliver into the new thread", async () => {
  const f = await fixture({ action: turn, changeSession: true });
  await f.tick();
  assert.deepEqual(f.submitted, []);
});

test("native policy refusal is acknowledged as failed", async () => {
  const f = await fixture({ action: turn, drop: true });
  await f.tick();
  assert.deepEqual(f.calls.at(-1).body, { lease_id: turn.lease_id, outcome: "failed" });
});

test("answers use native HTTP on the private socket without a subprocess", async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  const answer = 'literal $(touch /tmp/no) `echo no` "quotes"\nnext line';
  await f.hooks.get("turn.start")(f.$, { text: "desktop reply", turnId: "t1" }, async () => ({}));
  await f.hooks.get("turn.complete")(f.$, { answer, turnId: "t1", reason: "answer" }, async () => ({ text: answer }));
  await f.tick();
  const result = f.calls.find((call) => call.route === "result");
  assert.equal(result.body.text, answer);
  assert.equal(result.init.socketPath, "/private/relay.sock");
  assert.equal(result.url, "http://relay/claude/mobile-handoff/result");
  assert.equal(result.init.method, "POST");
  assert.equal(result.url.includes(answer), false);
});

test("subagent answers are not forwarded as the session's answer", async () => {
  const f = await fixture();
  await f.tick();
  await f.hooks.get("turn.complete")(f.$, { answer: "private subtask", turnId: "t1", agentId: "child", reason: "answer" }, async () => ({}));
  await f.tick();
  assert.equal(f.calls.some((call) => call.route === "result"), false);
});

test("large Unicode answers remain deliverable and do not block later answers", async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  const answer = "漢".repeat(23999) + "😀".repeat(30000);
  await f.hooks.get("turn.start")(f.$, { text: "long reply", turnId: "long" }, async () => ({}));
  await f.hooks.get("turn.complete")(f.$, { answer, turnId: "long", reason: "answer" }, async () => ({ text: answer }));
  await f.tick();
  const sent = f.calls.find((call) => call.route === "result").body.text;
  assert.ok(Buffer.byteLength(sent) < 96 * 1024);
  assert.ok(sent.includes("Answer shortened for mobile"));
  assert.equal(sent.includes("\uD83D\n"), false);
  await f.hooks.get("turn.start")(f.$, { text: "next reply", turnId: "next" }, async () => ({}));
  await f.hooks.get("turn.complete")(f.$, { answer: "Next answer", turnId: "next", reason: "answer" }, async () => ({}));
  await f.tick();
  assert.equal(f.calls.filter((call) => call.route === "result").at(-1).body.text, "Next answer");
});

test("relative socket paths are refused instead of using network transport", async () => {
  const f = await fixture({ action: turn, bridge: { socket: "relay.sock" } });
  await f.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.submitted, []);
});

test("ordinary desktop turns keep their native permission prompt", async () => {
  const f = await fixture();
  const original = {};
  const result = await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Write", tool_input: {} }, async () => original);
  assert.equal(result, original);
  assert.equal(f.calls.some((call) => call.route === "permission"), false);
});

test("a prior permission-hook denial cannot be overridden remotely", async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "t-mobile" }, async () => ({}));
  const original = { decision: { behavior: "deny" } };
  const result = await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Write", tool_input: {} }, async () => original);
  assert.equal(result, original);
  assert.equal(f.calls.some((call) => call.route === "permission"), false);
});

test("a native mobile turn uses the core's one-action approval", async () => {
  const decision = { behavior: "allow", updatedInput: { file_path: "/test/note" } };
  const f = await fixture({ action: turn, permission: { handled: true, decision } });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "t-mobile" }, async () => ({}));
  const result = await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Write", tool_input: decision.updatedInput }, async () => ({}));
  assert.deepEqual(result.decision, decision);
  const request = f.calls.find((call) => call.route === "permission");
  assert.deepEqual(request.body, { request_id: "t-mobile-1", tool_name: "Write", tool_input: decision.updatedInput, control_token: turn.control_token });
  assert.equal(request.init.socketPath, "/private/relay.sock");
});

test("unconfirmed remote approval never grants the tool access", async () => {
  const f = await fixture({ action: turn, reject: (route) => route === "permission" });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "t-mobile" }, async () => ({}));
  const result = await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Bash", tool_input: {} }, async () => ({}));
  assert.equal(result.decision.behavior, "deny");
});

test("permission polling reuses one request and exact input until the owner's decision", async () => {
  const decision = { behavior: "allow", updatedInput: { file_path: "/test/note" } };
  const f = await fixture({ action: turn, permissionReplies: [
    { handled: true, pending: true }, { handled: true, pending: true }, { handled: true, decision },
  ] });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "mobile" }, async () => ({}));
  const result = await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Write", tool_input: decision.updatedInput }, async () => ({}));
  const attempts = f.calls.filter((call) => call.route === "permission");
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((call) => JSON.stringify(call.body) === JSON.stringify(attempts[0].body)));
  assert.deepEqual(result.decision, decision);
});

test("an indefinitely pending permission fails closed after bounded polls", async () => {
  const f = await fixture({ action: turn, permission: { handled: true, pending: true } });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "mobile" }, async () => ({}));
  const result = await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Write", tool_input: {} }, async () => ({}));
  assert.equal(f.calls.filter((call) => call.route === "permission").length, 24);
  assert.equal(result.decision.behavior, "deny");
});

test("a subagent starting cannot clear its parent's mobile approval context", async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "parent" }, async () => ({}));
  await f.hooks.get("turn.start")(f.$, { text: "Subtask", turnId: "child-turn", agentId: "child" }, async () => ({}));
  await f.hooks.get("classic.PermissionRequest")(f.$, { tool_name: "Write", tool_input: {} }, async () => ({}));
  assert.equal(f.calls.find((call) => call.route === "permission").body.control_token, turn.control_token);
});

test("answers keep their original control generation across authority changes", async () => {
  const options = { action: turn, reject: (route) => route === "result" };
  const f = await fixture(options);
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "old-turn" }, async () => ({}));
  // A new authenticated owner/workspace can engage the same native process.
  options.action = { ...turn, lease_id: "lease-2", control_token: "control-b", text: "New owner's task" };
  await f.tick();
  await f.hooks.get("turn.complete")(f.$, { answer: "Old owner's answer", turnId: "old-turn", reason: "answer" }, async () => ({}));
  await f.tick();
  await f.tick();
  const attempts = f.calls.filter((call) => call.route === "result");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((call) => call.body.control_token === "control-a"));
});

test("desktop turns before mobile engagement are not forwarded", async () => {
  const f = await fixture();
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: "Local task", turnId: "local" }, async () => ({}));
  await f.hooks.get("turn.complete")(f.$, { answer: "Local answer", turnId: "local", reason: "answer" }, async () => ({}));
  await f.tick();
  assert.equal(f.calls.some((call) => call.route === "result"), false);
});

test("a temporary owner-verification failure retains the exact answer for retry", async () => {
  let offline = true;
  const f = await fixture({ action: turn, reject: (route) => route === "result" && offline });
  await f.tick();
  await f.hooks.get("turn.start")(f.$, { text: turn.text, turnId: "mobile" }, async () => ({}));
  await f.hooks.get("turn.complete")(f.$, { answer: "Completed while offline", turnId: "mobile", reason: "answer" }, async () => ({}));
  await f.tick();
  offline = false;
  await f.tick();
  await f.tick();
  const attempts = f.calls.filter((call) => call.route === "result");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(attempts[1].body.control_token, turn.control_token);
  assert.equal(f.submitted.length, 1);
});
