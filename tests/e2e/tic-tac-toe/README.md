# Three-PTY tic-tac-toe E2E

Drives the attach clients (`view` / `drive` / `passthrough`) the way a human
actually uses them — **through a real PTY** — and plays a real game of
tic-tac-toe between three PTY agents over the relay protocol.

The suite has two halves, split so the cheap one always runs.

## 1. Status-line rendering (always runs, no stack, no LLM)

Replays the real `renderStatusLine` output through a headless terminal
emulator (`@xterm/headless`) and asserts the agent's screen survives.

This is the regression guard for the bug that made a `drive` pane unreadable:

> The status line is painted on the bottom row inside an `ESC 7` / `ESC 8`
> (DECSC/DECRC) pair. That is only safe while the label _fits_. A label wider
> than the pane wraps past the last row, which scrolls the screen — and because
> the label sits ON the bottom row, the next repaint scrolls again. Old status
> lines get promoted into the scrollback as content and the agent's TUI loses a
> row of output per repaint.

The `drive` label is 87 columns wide, so this fired on a **standard 80-column
terminal**, not just narrow tmux panes. At 66 columns (a quarter-screen pane) six
repaints cost six rows of agent output and left six stacked status bars behind.

Byte-level assertions cannot catch this — "painted once" and "painted six times
while scrolling the screen away" are the same bytes on the wire. Only replaying
into an emulator sees what the human sees.

## 2. The live game (opt-in)

Three `claude` PTY agents — `Gamemaster`, `PlayerA`, `PlayerB` — play a full
game. The Gamemaster owns the board and DMs each player in turn; the players
reply `MOVE <n>`. A `view` client watches each agent through its own PTY.

Asserts:

| Assertion                                                 | Guards                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| view streams grow                                         | a `view` pane frozen on its attach snapshot (live `worker_stream` never lands) |
| `relay_inbound` in both directions, for both players      | agents actually using the relay protocol rather than talking to themselves     |
| ≥3 delivered replies matching `MOVE <n>`                  | a game that "ended" without anyone actually playing                            |
| the end-of-game token is delivered to both players        | the round trip completes, not just the first hop                               |
| every pane renders coherently, no row wider than the pane | wrap/scroll corruption in the live stream                                      |

**Where each assertion runs matters.** Protocol claims read the broker's
`relay_inbound` event stream; visual claims replay the PTY capture through an
emulator. Neither substitutes for the other:

- A rendered pane cannot prove a message arrived. A TUI paints with absolute
  cursor addressing, so a phrase the human plainly reads is not a contiguous
  byte run in the capture — and a full-screen harness lives in the alternate
  screen buffer, which keeps **no scrollback**, so once it repaints the earlier
  message is gone from the grid entirely.
- The event stream cannot prove anything rendered correctly. The status-line
  bug emitted perfectly well-formed frames; only the emulator sees that they
  landed on top of each other.

### Running it

```bash
npm run build:core                                    # relay CLI + packages
cargo build --release --bin agent-relay-broker        # broker

# RELAYCAST_ENGINE_DIR must point at a *built* relaycast checkout.
RELAY_TTT_LIVE=1 \
RELAYCAST_ENGINE_DIR=/path/to/relaycast \
  npm run test:e2e -- tests/e2e/tic-tac-toe
```

Without `RELAY_TTT_LIVE=1` the live half skips; when the engine or broker
binary is missing it skips too (never fails), same convention as the fleet E2E.

The game is three LLM agents taking turns over the network — budget ~3-5
minutes of wall clock for it to finish (a passing run took 211s).

## Gotchas this suite encodes

These each cost real debugging time; they are handled in `harness.ts` so the
next person doesn't rediscover them.

- **A fresh engine DB per run is mandatory.** The broker enrolls its node under
  the project directory name. Re-enrolling an already-known name fails
  `node_name_conflict`, after which the engine has no delivery-ready provider
  for that node and defers _every_ message
  (`[delivery.route] provider not delivery-ready`). Relay messaging then looks
  silently broken — agents stay "working" in `agent list` and never receive a
  thing.

- **The harness HOME must be past first-run onboarding.** Otherwise `claude`
  opens on the theme picker and waits. The agent reports `working`, its pane
  never changes, and that is indistinguishable from a dead view stream.
  `seedHarnessHome` copies the caller's `~/.claude.json` and flips
  `hasCompletedOnboarding`.

- **A quiet agent is not a broken view.** An agent spawned with no task sits at
  an empty prompt producing no output, so its `view` pane legitimately never
  updates. The suite gives every agent a task before asserting on stream
  growth.

- **`AGENT_RELAY_MCP_COMMAND` must point at the local build.** The broker
  otherwise configures spawned agents with the installed Relay executable,
  which runs packaged code instead of the code under test.

- **PTYs come from `pty-run.py`.** `stdout.isTTY` gates the status line, the
  terminal reset on detach, and the input-report filter; driving the clients
  through a pipe exercises a different path than the one a human sees.

- **Don't wait on a natural phrase.** The task prompt is injected into the
  agent's PTY, so waiting for "GAME OVER" to appear matches the prompt itself
  and fires instantly. The suite waits on `DONE_TOKEN`, which only the
  Gamemaster's prompt names — seeing it _delivered to a player_ is proof the
  game really ended.
