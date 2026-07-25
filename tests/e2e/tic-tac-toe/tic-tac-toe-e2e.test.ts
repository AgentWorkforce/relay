/**
 * Three-PTY tic-tac-toe E2E.
 *
 * Two independent concerns, split so the cheap one always runs:
 *
 *  1. **Status-line rendering** (no stack, no LLM, no network) — replays the
 *     real `renderStatusLine` output through a headless terminal emulator and
 *     asserts the agent's screen survives. This is the regression guard for
 *     the bug that made a `drive` pane unreadable: a status label wider than
 *     the pane wraps past the bottom row, which scrolls the screen; since the
 *     label is painted ON the bottom row, every repaint scrolls again,
 *     stacking old status lines into the scrollback and eating the agent's
 *     output a row at a time.
 *
 *  2. **The live game** (needs a local relaycast engine, the broker binary,
 *     and a working `claude` CLI) — three PTY agents play a real game of
 *     tic-tac-toe over the relay protocol while a `view` client watches each
 *     one through a real PTY. Skips cleanly when the prerequisites are
 *     missing, exactly like the fleet E2E.
 *
 * See `README.md` in this directory for how to run the live half.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderStatusLine } from '../../../packages/cli/src/cli/lib/attach-drive.js';
import { renderStatusLine as renderPassthroughStatusLine } from '../../../packages/cli/src/cli/lib/attach-passthrough.js';
import {
  attachInPty,
  cleanEnv,
  preflight,
  renderScreen,
  renderTranscript,
  startBroker,
  startEngine,
  waitFor,
  type BrokerHandle,
  type EngineHandle,
  type PtyClient,
} from './harness.js';

/** Paint an agent TUI, then repaint the status line `repaints` times. */
async function screenAfterStatusPaints(opts: {
  cols: number;
  rows: number;
  repaints: number;
  render: (pending: number) => string;
}): Promise<string[]> {
  const { Terminal } = await import('@xterm/headless');
  const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((r) => term.write(data, r));

  // An agent TUI that owns the screen: alt-screen, absolute-addressed content.
  await write('\x1b[?1049h\x1b[H\x1b[2J');
  for (let i = 1; i <= opts.rows - 4; i += 1) await write(`\x1b[${i};1Hagent line ${i}`);
  await write(`\x1b[${opts.rows - 4};1H`);
  for (let n = 0; n < opts.repaints; n += 1) await write(opts.render(n));

  const buf = term.buffer.active;
  const screen: string[] = [];
  for (let y = 0; y < opts.rows; y += 1) {
    screen.push((buf.getLine(y)?.translateToString(true) ?? '').trimEnd());
  }
  return screen;
}

describe('attach status line survives a narrow pane', () => {
  const ROWS = 24;
  const AGENT_LINES = ROWS - 4;

  // 66 columns is roughly a quarter-screen tmux pane — the shape that made a
  // real `drive` session unreadable. The `drive` label is 87 columns wide.
  for (const cols of [120, 80, 66, 40]) {
    it(`drive: one status row and no lost agent output at ${cols} columns`, async () => {
      const screen = await screenAfterStatusPaints({
        cols,
        rows: ROWS,
        repaints: 6,
        render: (pending) =>
          renderStatusLine({ name: 'Gamemaster', mode: 'manual_flush', pending, rows: ROWS, cols }),
      });

      const statusRows = screen.filter((l) => l.includes('[drive Gamemaster')).length;
      const agentRows = screen.filter((l) => /^agent line \d+$/.test(l)).length;

      expect(statusRows, `status line stacked at ${cols} cols:\n${screen.join('\n')}`).toBe(1);
      expect(agentRows, `agent output scrolled away at ${cols} cols:\n${screen.join('\n')}`).toBe(
        AGENT_LINES
      );
      // It must land on the bottom row, not wherever a scroll left it.
      expect(screen[ROWS - 1]).toContain('[drive Gamemaster');
      expect(screen[ROWS - 1].length).toBeLessThanOrEqual(cols);
    });
  }

  it('passthrough: one status row and no lost agent output at 40 columns', async () => {
    const cols = 40;
    const screen = await screenAfterStatusPaints({
      cols,
      rows: ROWS,
      repaints: 6,
      render: () => renderPassthroughStatusLine({ name: 'Gamemaster', mode: 'auto_inject', rows: ROWS, cols }),
    });

    expect(screen.filter((l) => l.includes('[passthrough')).length).toBe(1);
    expect(screen.filter((l) => /^agent line \d+$/.test(l)).length).toBe(AGENT_LINES);
    expect(screen[ROWS - 1].length).toBeLessThanOrEqual(cols);
  });

  it('keeps the agent name and the detach hint readable even when truncated', () => {
    const line = renderStatusLine({ name: 'Gamemaster', mode: 'manual_flush', pending: 2, rows: 24, cols: 66 });
    expect(line).toContain('[drive Gamemaster');
    expect(line).toContain('Ctrl+C detach]');
  });
});

// ── the live game ────────────────────────────────────────────────────────────

const check = preflight();
const liveEnabled = check.ok && process.env.RELAY_TTT_LIVE === '1';

describe.skipIf(!liveEnabled)('three PTY agents play tic-tac-toe over the relay protocol', () => {
  const COLS = 100;
  const ROWS = 30;
  const AGENTS = ['Gamemaster', 'PlayerA', 'PlayerB'] as const;

  let tmpRoot: string;
  let engine: EngineHandle;
  let broker: BrokerHandle;
  const clients = new Map<string, PtyClient>();

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'relay-ttt-'));
    const projectDir = path.join(tmpRoot, 'proj');
    const home = path.join(tmpRoot, 'home');
    const capDir = path.join(tmpRoot, 'cap');
    for (const dir of [projectDir, home, capDir]) mkdirSync(dir, { recursive: true });
    seedHarnessHome(home);

    engine = await startEngine(check.engineServe!, tmpRoot);
    broker = await startBroker(projectDir, engine.baseUrl, home);

    for (const [name, task] of Object.entries(TASKS)) {
      await broker.spawnAgent(name, task);
    }

    const env = cleanEnv({ HOME: home });
    for (const name of AGENTS) {
      clients.set(
        name,
        attachInPty({
          name,
          mode: 'view',
          cols: COLS,
          rows: ROWS,
          capturePath: path.join(capDir, `${name}.bin`),
          projectDir,
          env,
        })
      );
    }

    // The game is three LLM agents taking turns over the network; give it room.
    //
    // Wait on DONE_TOKEN reaching a PLAYER. The token appears only in the
    // Gamemaster's prompt, so seeing it in a player's pane proves a real
    // end-of-game message was delivered. Waiting on a phrase like 'GAME OVER'
    // instead matches the injected task prompt itself and fires immediately.
    await waitFor(
      async () => {
        for (const player of ['PlayerA', 'PlayerB'] as const) {
          if ((await transcript(player)).includes(DONE_TOKEN)) return true;
        }
        return false;
      },
      { timeoutMs: 8 * 60_000, label: 'the game to finish', intervalMs: 5_000 }
    );
  }, 10 * 60_000);

  /** What the pane has shown so far, scrollback included. */
  const transcript = (name: string): Promise<string> =>
    renderTranscript(clients.get(name)!.read(), COLS, ROWS);

  afterAll(() => {
    for (const client of clients.values()) client.stop();
    broker?.stop();
    engine?.stop();
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('streams live PTY output to every view client', () => {
    for (const name of AGENTS) {
      // A frozen `view` pane — the original report — shows up here as a
      // capture no bigger than the one-shot attach snapshot.
      expect(clients.get(name)!.size(), `${name} view stream never grew past its snapshot`).toBeGreaterThan(
        20_000
      );
    }
  });

  it('carries moves between agents over the relay protocol', async () => {
    const gm = await transcript('Gamemaster');
    // Both players' moves reached the Gamemaster as relay messages, and the
    // Gamemaster saw them as relay traffic (not as its own typing).
    expect(gm).toContain('Relay message from PlayerA');
    expect(gm).toContain('Relay message from PlayerB');
    expect(gm).toMatch(/MOVE\s*\d/);

    for (const player of ['PlayerA', 'PlayerB'] as const) {
      expect(await transcript(player), `${player} never received a relay message`).toContain(
        'Relay message from Gamemaster'
      );
    }
  });

  it('reaches a terminal result and tells both players', async () => {
    for (const player of ['PlayerA', 'PlayerB'] as const) {
      expect(await transcript(player), `${player} was never told the game ended`).toContain(DONE_TOKEN);
    }
  });

  it('renders a coherent screen in each view pane', async () => {
    for (const name of AGENTS) {
      const screen = await renderScreen(clients.get(name)!.read(), COLS, ROWS);
      const nonBlank = screen.filter((l) => l.trim().length > 0).length;
      expect(nonBlank, `${name} pane rendered blank`).toBeGreaterThan(5);
      // Every row must fit: a row longer than the pane means something wrapped
      // and the emulator had to scroll to place it.
      for (const row of screen) expect(row.length).toBeLessThanOrEqual(COLS);
    }
  });
});

/**
 * End-of-game sentinel. Named ONLY in the Gamemaster's prompt, so finding it
 * in a player's pane is proof a relay message actually crossed the wire —
 * unlike a natural phrase, which the injected prompt itself would match.
 */
const DONE_TOKEN = 'TICTACTOE-COMPLETE-7F3A';

const RULES = `You are playing a game of tic-tac-toe with other agents over Agent Relay.
Communicate ONLY by sending relay messages with the agent-relay MCP tools (send_dm).
Board cells are numbered 1-9, left-to-right, top-to-bottom.
Keep every message to one or two short lines. Never ask a clarifying question -
if something is ambiguous, pick a reasonable interpretation and continue.`;

const TASKS: Record<string, string> = {
  Gamemaster: `${RULES}
You are the GAMEMASTER. You own the board; the players do not track it.
Run the whole game to completion, without waiting for any human input:
1. send_dm to PlayerA: 'Game start. You are X. Board is empty. Your move (1-9)?'
2. When PlayerA replies, apply the move, then send_dm to PlayerB the CURRENT
   board as three lines of three characters plus 'You are O. Your move (1-9)?'
3. Alternate until someone wins or the board is full.
4. Reject an illegal move by asking that player again.
5. When the game ends, send_dm BOTH players a final message naming the result
   whose last line is exactly ${DONE_TOKEN}, then print the final board in your
   own terminal.
Start immediately.`,
  PlayerA: `${RULES}
You are PLAYERA, playing X. Wait for relay messages from Gamemaster.
Every time Gamemaster asks for your move, reply with send_dm to Gamemaster in
the form 'MOVE <n>' plus at most one short sentence. Never message PlayerB.
Stop playing once the Gamemaster tells you the game has finished.`,
  PlayerB: `${RULES}
You are PLAYERB, playing O. Wait for relay messages from Gamemaster.
Every time Gamemaster asks for your move, reply with send_dm to Gamemaster in
the form 'MOVE <n>' plus at most one short sentence. Never message PlayerA.
Stop playing once the Gamemaster tells you the game has finished.`,
};

/**
 * Give the spawned agents a HOME whose harness config is already past
 * first-run onboarding. Without it, `claude` opens on the theme picker and
 * sits there — the agent looks "working" in `agent list` while its pane never
 * changes, which is indistinguishable from a broken view stream.
 */
function seedHarnessHome(home: string): void {
  const realHome = process.env.HOME;
  if (!realHome) return;
  const source = path.join(realHome, '.claude.json');
  if (!existsSync(source)) return;

  const target = path.join(home, '.claude.json');
  cpSync(source, target);
  const claudeDir = path.join(realHome, '.claude');
  if (existsSync(claudeDir)) cpSync(claudeDir, path.join(home, '.claude'), { recursive: true });

  const config = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>;
  config.hasCompletedOnboarding = true;
  config.bypassPermissionsModeAccepted = true;
  config.theme ??= 'dark';
  config.projects = {};
  writeFileSync(target, JSON.stringify(config, null, 2));
}
