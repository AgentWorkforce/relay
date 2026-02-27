import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRelay } from '@agent-relay/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let relay = null;
let win = null;

// Name the human sender uses in the relay
const HUMAN_NAME = 'user';

function send(channel, data) {
  win?.webContents?.send(channel, data);
}

// ── Relay setup ──────────────────────────────────────────────────────────────

async function initRelay() {
  relay = new AgentRelay({
    cwd: process.cwd(),
    env: { ...process.env, RUST_LOG: 'info' },
  });

  relay.onMessageReceived = (msg) => {
    console.log('[relay:msg]', JSON.stringify(msg));
    send('message', { from: msg.from, to: msg.to, text: msg.text });
  };

  relay.onBrokerStderr((line) => {
    console.log('[broker:stderr]', line);
    send('broker-log', line);
  });

  relay.onAgentSpawned = (agent) => {
    send('agent-update', { name: agent.name, status: 'spawning' });
  };

  relay.onAgentReady = (agent) => {
    send('agent-update', { name: agent.name, status: 'ready' });
  };

  relay.onAgentExited = (agent) => {
    send('agent-update', { name: agent.name, status: 'exited' });
  };

  relay.onWorkerOutput = ({ name, chunk }) => {
    process.stdout.write(`[${name}] ${chunk}`);
  };

  try {
    // listAgents() lazily starts the broker + Relaycast workspace
    await relay.listAgents();

    // Register the human sender identity with Relaycast so it has a valid
    // agent token before any send_dm calls are made from it.
    await relay.preflightAgents([{ name: HUMAN_NAME, cli: 'browser' }]);

    send('broker-status', 'connected');
  } catch (err) {
    console.error('[relay] Init error:', err.message);
    send('broker-status', 'error');
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

const DEFAULT_TASK = [
  'You are a helpful assistant connected to Agent Relay.',
  'When you receive a relay message (it will appear as "Relay message from X [id]: ..."),',
  'reply by calling mcp__relaycast__post_message with channel: "general" and your reply as the text.',
  'Do not use send_dm. Do not type your reply in the terminal.',
  'Only respond via mcp__relaycast__post_message(channel: "general", text: "...").',
].join(' ');

ipcMain.handle('spawn', async (_e, name, cli, task) => {
  try {
    const agent = await relay.spawn(name, cli, task ?? DEFAULT_TASK);
    return { ok: true, name: agent.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('release', async (_e, name) => {
  try {
    const agents = await relay.listAgents();
    const agent = agents.find((a) => a.name === name);
    if (!agent) return { ok: false, error: 'Agent not found' };
    await agent.release();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('send-message', async (_e, to, text) => {
  try {
    const human = relay.human({ name: HUMAN_NAME });
    const result = await human.sendMessage({ to, text });
    console.log('[send-message] delivered to', to, JSON.stringify(result));
    return { ok: true };
  } catch (err) {
    console.error('[send-message] error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('list-agents', async () => {
  try {
    const agents = await relay.listAgents();
    return { ok: true, agents: agents.map((a) => ({ name: a.name, status: a.status })) };
  } catch (err) {
    return { ok: false, agents: [], error: err.message };
  }
});

ipcMain.handle('broadcast', async (_e, text) => {
  try {
    const human = relay.human({ name: HUMAN_NAME });
    await human.sendMessage({ to: '*', text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(async () => {
  createWindow();
  await initRelay();
});

app.on('before-quit', (event) => {
  if (!relay) return;
  event.preventDefault();
  relay.shutdown()
    .then(() => app.exit(0))
    .catch(() => app.exit(1));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
