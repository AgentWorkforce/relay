// Agent Relay for OpenCode.
// Installed and removed by Agent Relay's "OpenCode sessions" setting; edits
// to this file are overwritten. AGENT_RELAY_OPENCODE_PLUGIN=__VERSION__
// Supports both the OpenCode 1.x hook API and the OpenCode 2.x plugin API.
// Each process listens on a private Unix socket and exposes only the routes
// Agent Relay needs to deliver a message and read its answer:
//
//   GET  /session/status
//   GET  /session/<id>
//   GET  /session/<id>/title-capability
//   PATCH /session/<id>               (title only)
//   GET  /session/<id>/message
//   GET  /session/<id>/message/<message id>
//   POST /session/<id>/prompt_async   (one text part, a msg_relay_ id)

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const RUNTIME = __RUNTIME__;
const VERSION = __VERSION__;
const SESSION = /^ses_[A-Za-z0-9]{4,128}$/;
const MESSAGE = /^msg_[A-Za-z0-9_]{4,128}$/;
const RELAY_MESSAGE = /^msg_relay_[0-9a-f]{32}$/;
const MAX_TEXT = 65536;
const MAX_REQUEST = 262144;

function json(status, value) {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: value === undefined ? {} : { "content-type": "application/json" },
  });
}

function privateRuntime() {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(RUNTIME);
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function startedOn() {
  try {
    const result = Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.pid)]);
    const words = result.stdout.toString().trim().split(/\s+/);
    if (words.some((word) => word === "--fork" || (word.startsWith("--fork=") && !/^--fork=(false|0|no)$/i.test(word)))) {
      return {};
    }
    for (let index = 1; index < words.length; index++) {
      const word = words[index];
      if (word === "--session" || word === "-s") return { session: words[index + 1] };
      if (word.startsWith("--session=")) return { session: word.slice("--session=".length) };
    }
    return { latest: words.includes("--continue") || words.includes("-c") };
  } catch {
    return {};
  }
}

function sweep() {
  for (const name of fs.readdirSync(RUNTIME)) {
    const match = /^(\d+)\.(sock|json)$/.exec(name);
    if (match && Number(match[1]) !== process.pid && !alive(Number(match[1]))) {
      try { fs.unlinkSync(path.join(RUNTIME, name)); } catch {}
    }
  }
}

// The npm build replaces only this filesystem check. The process-wide claim
// also protects the desktop's managed copy when V2 loads several locations.
function deferToDesktop() {
  return false;
}

const CLAIM = Symbol.for("agent-relay.opencode-plugin");
function claimInstance() {
  if (deferToDesktop() || globalThis[CLAIM]) return;
  const claim = { version: VERSION };
  globalThis[CLAIM] = claim;
  return () => {
    if (globalThis[CLAIM] === claim) delete globalThis[CLAIM];
  };
}

// Managed servers already have a private authenticated delivery endpoint.
// Keep their shell tags, and attest that this exact process loaded the hook,
// without opening the TUI plugin's duplicate discovery/delivery socket.
function managedTagging(release) {
  const marker = process.env.AGENT_RELAY_MANAGED_SESSION_MARKER;
  if (!marker || !privateRuntime()) return () => release();
  const record = path.join(RUNTIME, `${process.pid}.managed.json`);
  const temporary = `${record}.${randomBytes(12).toString("hex")}.tmp`;
  const hash = createHash("sha256").update(marker).digest("hex");
  try {
    fs.writeFileSync(temporary, JSON.stringify({version: VERSION, pid: process.pid, marker_sha256: hash}), {mode: 0o600, flag: "wx"});
    fs.renameSync(temporary, record);
  } catch { try { fs.unlinkSync(temporary); } catch {} }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      const stored = JSON.parse(fs.readFileSync(record, "utf8"));
      if (stored.marker_sha256 === hash) fs.unlinkSync(record);
    } catch {}
    process.removeListener("exit", close);
    release();
  };
  process.once("exit", close);
  return close;
}

async function tagV1(input, output) {
  const id = input?.sessionID;
  if (typeof id !== "string" || !SESSION.test(id) || !output) return;
  if (!output.env || typeof output.env !== "object") output.env = {};
  output.env.AGENT_RELAY_OPENCODE_SESSION = id;
}

function tagV2(event) {
  const id = event?.env?.OPENCODE_SESSION_ID;
  if (typeof id === "string" && SESSION.test(id)) event.env.AGENT_RELAY_OPENCODE_SESSION = id;
}

function errorStatus(error) {
  const status = Number(error?.status ?? error?.cause?.status ?? error?.cause?.cause?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  const tag = String(error?._tag ?? error?.name ?? "");
  if (tag.includes("NotFound")) return 404;
  if (tag.includes("Invalid") || tag.includes("Decode")) return 400;
  if (tag.includes("Unauthorized")) return 401;
  if (tag.includes("Forbidden")) return 403;
  if (tag.includes("Busy") || tag.includes("Conflict")) return 409;
  if (tag.includes("Unavailable")) return 503;
  return 502;
}

function v1Adapter(client) {
  const config = client._client.getConfig();
  async function value(method, pathname, body) {
    const headers = new Headers(config.headers ?? {});
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await (config.fetch ?? fetch)(new Request(new URL(pathname, config.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    if (!response.ok) throw Object.assign(new Error(`OpenCode returned ${response.status}`), { status: response.status });
    return response.status === 204 ? undefined : response.json();
  }
  return {
    getSession: (id) => value("GET", `/session/${id}`),
    rename: (id, title) => value("PATCH", `/session/${id}`, { title }),
    listSessions: () => value("GET", "/session"),
    getStatus: () => value("GET", "/session/status"),
    getMessages: (id) => value("GET", `/session/${id}/message`),
    getMessage: (id, messageID) => value("GET", `/session/${id}/message/${messageID}`),
    prompt: (id, messageID, text) => value("POST", `/session/${id}/prompt_async`, {
      messageID,
      parts: [{ type: "text", text }],
    }),
  };
}

function legacySession(info, context) {
  if (!info || typeof info !== "object") return info;
  const location = info.location && typeof info.location === "object" ? info.location : {};
  return {
    ...info,
    directory: location.directory ?? info.directory ?? context.directory,
    ...(context.workspaceID ? { workspaceID: context.workspaceID } : {}),
  };
}

// V2 stores projected messages rather than V1's info/parts envelopes. This
// narrow compatibility view is the protocol the desktop already verifies.
function legacyMessages(messages, sessionID) {
  const result = [];
  let parentID;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.id !== "string") continue;
    if (message.type === "user") {
      parentID = message.id;
      result.push({
        info: { id: message.id, sessionID, role: "user", time: message.time ?? {} },
        parts: [{ type: "text", text: typeof message.text === "string" ? message.text : "" }],
      });
      continue;
    }
    if (message.type !== "assistant") continue;
    const parts = [];
    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (content?.type === "text") parts.push({ type: "text", text: content.text ?? "" });
      if (content?.type === "tool") {
        parts.push({
          type: "tool",
          state: content.state ?? {},
          metadata: { ...(content.state?.metadata ?? {}), ...(content.executed ? { providerExecuted: true } : {}) },
        });
      }
    }
    if (typeof message.finish === "string") {
      parts.push({ type: "step-finish", sessionID, messageID: message.id, reason: message.finish });
    }
    result.push({
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        ...(parentID ? { parentID } : {}),
        finish: message.finish,
        error: message.error,
        time: message.time ?? {},
      },
      parts,
    });
  }
  return result;
}

async function v2SessionList(directory) {
  const own = /^opencode(?:\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : undefined;
  const executable = own ?? Bun.which?.("opencode");
  if (!executable) return [];
  let child;
  try {
    child = Bun.spawn([executable, "session", "list", "--format", "json", "--max-count", "1000"], {
      cwd: directory,
      env: { ...process.env, AGENT_RELAY_MANAGED_SESSION_MARKER: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = new Response(child.stdout).text();
    const timeout = setTimeout(() => child.kill(), 5000);
    const status = await child.exited;
    clearTimeout(timeout);
    if (status !== 0) return [];
    const sessions = JSON.parse(await output);
    return (Array.isArray(sessions) ? sessions : []).map((session) => ({
      id: session.id,
      parentID: session.parentID,
      title: session.title,
      projectID: session.projectId,
      directory: session.directory,
      time: { created: session.created, updated: session.updated, archived: session.archived },
    }));
  } catch {
    try { child?.kill(); } catch {}
    return [];
  }
}

function v2Adapter(context, statuses, pendingPrompts) {
  const sessionContext = { directory: context.location.directory, workspaceID: context.location.workspaceID };
  const messages = async (id) => legacyMessages(await context.session.context({ sessionID: id }), id);
  return {
    getSession: async (id) => legacySession(await context.session.get({ sessionID: id }), sessionContext),
    rename: typeof context.session.update === "function" ? async (id, title) => {
      await context.session.update({ sessionID: id, title });
      return legacySession(await context.session.get({ sessionID: id }), sessionContext);
    } : undefined,
    // V2 deliberately does not expose session listing to plugins. Its public
    // CLI provides the startup snapshot needed for an idle --continue TUI.
    // Hydrate each result through the public API so parent and archive state
    // cannot be lost if the CLI's summary projection omits those fields.
    listSessions: async () => {
      const summaries = (await v2SessionList(context.location.directory))
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      for (const summary of summaries) {
        let session;
        try { session = legacySession(await context.session.get({ sessionID: summary.id }), sessionContext); }
        catch { return []; }
        if (session.parentID || session.time?.archived || session.directory !== context.location.directory) continue;
        return [session];
      }
      return [];
    },
    getStatus: async () => {
      const result = new Map(statuses);
      for (const [id, pending] of pendingPrompts) if (pending.size > 0) result.set(id, { type: "busy" });
      return Object.fromEntries(result);
    },
    getMessages: messages,
    getMessage: async (id, messageID) => (await messages(id)).find((message) => message.info?.id === messageID),
    prompt: async (id, messageID, text) => {
      const token = Symbol();
      const pending = pendingPrompts.get(id) ?? new Set();
      pending.add(token);
      pendingPrompts.set(id, pending);
      try {
        await context.session.prompt({ sessionID: id, id: messageID, text, delivery: "steer" });
      } catch (error) {
        pending.delete(token);
        if (pending.size === 0 && pendingPrompts.get(id) === pending) pendingPrompts.delete(id);
        throw error;
      }
    },
  };
}

async function serve({ api, directory, release }) {
  if (typeof Bun === "undefined" || !privateRuntime()) {
    release();
    return {};
  }
  try { sweep(); } catch {}
  const socket = path.join(RUNTIME, `${process.pid}.sock`);
  const record = path.join(RUNTIME, `${process.pid}.json`);
  const sessions = new Map();
  const children = new Set();
  let writing = Promise.resolve();
  let stopped = false;

  function save() {
    writing = writing.then(() => {
      if (stopped) return;
      const list = [...sessions.values()].sort((a, b) => b.updated - a.updated);
      const temporary = `${record}.${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: VERSION, pid: process.pid, socket, directory, sessions: list }), { mode: 0o600 });
      fs.renameSync(temporary, record);
    }).catch(() => {});
    return writing;
  }

  function remember(info) {
    if (!info || typeof info.id !== "string" || !SESSION.test(info.id)) return;
    if (info.parentID) {
      children.add(info.id);
      sessions.delete(info.id);
      return;
    }
    sessions.set(info.id, {
      id: info.id,
      title: typeof info.title === "string" ? info.title.slice(0, 200) : "",
      directory: typeof info.directory === "string" ? info.directory : directory,
      updated: Number(info.time?.updated ?? Date.now()),
    });
    save();
  }

  async function touch(id) {
    if (typeof id !== "string" || !SESSION.test(id) || children.has(id)) return;
    const known = sessions.get(id);
    if (known) {
      known.updated = Date.now();
      save();
      return;
    }
    try { remember(await api.getSession(id)); } catch {}
  }

  async function handle(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.search) return json(404);
    try {
      if (request.method === "GET" && parts.length === 2 && parts[0] === "session" && parts[1] === "status") {
        const all = await api.getStatus();
        const mine = {};
        for (const id of sessions.keys()) mine[id] = all?.[id] ?? { type: "idle" };
        return json(200, mine);
      }
      if (parts[0] !== "session" || !sessions.has(parts[1] ?? "")) return json(404);
      const id = parts[1];
      if (request.method === "GET" && parts.length === 2) return json(200, await api.getSession(id));
      if (request.method === "GET" && parts.length === 3 && parts[2] === "title-capability") return json(200, {supported: typeof api.rename === "function"});
      if (request.method === "PATCH" && parts.length === 2) {
        if (typeof api.rename !== "function") return json(501);
        const text = await request.text();
        if (text.length > 2048) return json(413);
        let body;
        try { body = JSON.parse(text); } catch { return json(400); }
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 ||
          typeof body.title !== "string" || !body.title.trim() ||
          [...body.title].length > 200 || /[\p{Cc}\u202a-\u202e\u2066-\u2069\u200b\ufeff]/u.test(body.title)) return json(400);
        const current = await api.getSession(id);
        if (current?.id !== id || current.time?.archived) return json(409);
        const updated = await api.rename(id, body.title);
        if (updated?.id !== id || updated.title !== body.title) return json(502);
        remember(updated);
        return json(200, updated);
      }
      if (request.method === "GET" && parts.length === 3 && parts[2] === "message") return json(200, await api.getMessages(id));
      if (request.method === "GET" && parts.length === 4 && parts[2] === "message" && MESSAGE.test(parts[3])) {
        const message = await api.getMessage(id, parts[3]);
        return message ? json(200, message) : json(404);
      }
      if (request.method === "POST" && parts.length === 3 && parts[2] === "prompt_async") {
        const text = await request.text();
        if (text.length > MAX_REQUEST) return json(413);
        let body;
        try { body = JSON.parse(text); } catch { return json(400); }
        if (body === null || typeof body !== "object" || Array.isArray(body)) return json(400);
        const part = Array.isArray(body.parts) && body.parts.length === 1 ? body.parts[0] : undefined;
        if (
          Object.keys(body).some((key) => key !== "messageID" && key !== "parts") ||
          typeof body.messageID !== "string" || !RELAY_MESSAGE.test(body.messageID) ||
          part?.type !== "text" || typeof part.text !== "string" ||
          part.text.length === 0 || part.text.length > MAX_TEXT
        ) return json(400);
        await api.prompt(id, body.messageID, part.text);
        return json(204);
      }
      return json(404);
    } catch (error) {
      return json(errorStatus(error));
    }
  }

  try { fs.unlinkSync(socket); } catch {}
  let server;
  try {
    server = Bun.serve({ unix: socket, async fetch(request) {
      try { return await handle(request); } catch { return json(502); }
    } });
    fs.chmodSync(socket, 0o600);
  } catch {
    release();
    return {};
  }
  save();

  const startup = setTimeout(async () => {
    const started = startedOn();
    if (started.session) return touch(started.session);
    if (!started.latest) return;
    try {
      const list = await api.listSessions();
      const latest = (Array.isArray(list) ? list : [])
        .filter((info) => !info.parentID && !info.time?.archived && (info.directory ?? info.location?.directory) === directory)
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
      if (latest) remember(legacySession(latest, { directory }));
    } catch {}
  }, 1000);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server?.stop(true); } catch {}
    for (const file of [socket, record]) {
      try { fs.unlinkSync(file); } catch {}
    }
  };
  process.once("exit", close);
  const dispose = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(startup);
    process.removeListener("exit", close);
    close();
    release();
  };
  return { remember, touch, sessions, save, dispose };
}

const AgentRelay = async ({ client, directory }) => {
  const release = claimInstance();
  if (!release) return {};
  const tagging = { "shell.env": tagV1 };
  if (process.env.AGENT_RELAY_MANAGED_SESSION_MARKER) {
    return {...tagging, dispose: managedTagging(release)};
  }
  if (!client?._client?.getConfig) return tagging;
  const runtime = await serve({ api: v1Adapter(client), directory, release });
  if (!runtime.dispose) return tagging;
  return {
    ...tagging,
    dispose: runtime.dispose,
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      switch (event?.type) {
        case "session.created":
        case "session.updated":
          if (runtime.sessions.has(properties.info?.id) || event.type === "session.created") runtime.remember(properties.info);
          break;
        case "session.deleted":
          if (runtime.sessions.delete(properties.info?.id)) runtime.save();
          break;
        case "message.updated":
          await runtime.touch(properties.info?.sessionID);
          break;
        case "server.instance.disposed":
          await runtime.dispose();
          break;
      }
    },
  };
};

async function setupV2(context) {
  const release = claimInstance();
  if (!release) return;
  let shell;
  try { shell = await context.shell.hook("create.before", tagV2); }
  catch (error) {
    release();
    throw error;
  }
  if (process.env.AGENT_RELAY_MANAGED_SESSION_MARKER) {
    const dispose = managedTagging(release);
    return async () => { await shell.dispose(); dispose(); };
  }
  const statuses = new Map();
  const pendingPrompts = new Map();
  const runtime = await serve({ api: v2Adapter(context, statuses, pendingPrompts), directory: context.location.directory, release });
  if (!runtime.dispose) return async () => { await shell.dispose(); release(); };

  const controller = new AbortController();
  const events = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        const eventDirectory = event?.location?.directory ?? data.location?.directory;
        if (eventDirectory && eventDirectory !== context.location.directory) continue;
        if (event?.type === "session.created") {
          runtime.remember(legacySession({
            id: data.sessionID, parentID: data.parentID, projectID: data.projectID,
            title: data.title, location: data.location,
            time: { created: event.created, updated: event.created },
          }, { directory: context.location.directory, workspaceID: context.location.workspaceID }));
        } else if (event?.type === "session.deleted") {
          if (runtime.sessions.delete(data.sessionID)) runtime.save();
          statuses.delete(data.sessionID);
          pendingPrompts.delete(data.sessionID);
        } else if (event?.type === "session.status") {
          pendingPrompts.delete(data.sessionID);
          statuses.set(data.sessionID, data.status);
          await runtime.touch(data.sessionID);
        } else if (event?.type === "session.execution.started") {
          pendingPrompts.delete(data.sessionID);
          statuses.set(data.sessionID, { type: "busy" });
          await runtime.touch(data.sessionID);
        } else if (
          event?.type === "session.execution.succeeded" ||
          event?.type === "session.execution.failed" ||
          event?.type === "session.execution.interrupted"
        ) {
          pendingPrompts.delete(data.sessionID);
          statuses.set(data.sessionID, { type: "idle" });
          await runtime.touch(data.sessionID);
        } else if (typeof data.sessionID === "string") {
          await runtime.touch(data.sessionID);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("Agent Relay OpenCode event stream stopped", error);
    }
  })();

  return async () => {
    controller.abort();
    await events;
    await shell.dispose();
    await runtime.dispose();
  };
}

// V1 discovers `server`; V2 reads `id` and `setup` from the default export.
export default { id: "agent-relay", setup: setupV2, server: AgentRelay };
