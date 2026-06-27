/**
 * Minimal terminal UI for `agent-relay skills add`.
 *
 * Two interactions:
 *   - {@link selectScope}: a single-choice picker (project vs global).
 *   - {@link selectHarnesses}: a multi-select checklist (which harnesses).
 *
 * Both are driven by raw keypress events so they work without any third-party
 * prompt dependency. They require a TTY; callers must fall back to flags when
 * `process.stdin.isTTY` is false (handled in the command layer).
 */

import readline from 'node:readline';

import type { HarnessTarget, SkillScope } from './skills-install.js';

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

interface TtyStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

function defaultStreams(): TtyStreams {
  return { input: process.stdin, output: process.stdout };
}

interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

/**
 * Run a keypress-driven interaction. Handles raw mode setup/teardown, cursor
 * hiding, and Ctrl+C, then resolves with whatever `onKey` returns (or null if
 * the user aborted).
 */
async function runKeyLoop<T>(
  streams: TtyStreams,
  render: () => void,
  onKey: (key: Key) => { done: true; value: T | null } | { done: false }
): Promise<T | null> {
  const { input, output } = streams;
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw ?? false;
  if (input.isTTY) input.setRawMode(true);
  output.write(HIDE_CURSOR);

  return await new Promise<T | null>((resolve) => {
    const cleanup = (): void => {
      input.off('keypress', handler);
      if (input.isTTY) input.setRawMode(wasRaw);
      output.write(SHOW_CURSOR);
      input.pause();
    };

    const handler = (_str: string, key: Key | undefined): void => {
      const k = key ?? {};
      if (k.ctrl && k.name === 'c') {
        cleanup();
        output.write('\n');
        resolve(null);
        return;
      }
      const result = onKey(k);
      if (result.done) {
        cleanup();
        resolve(result.value);
        return;
      }
      render();
    };

    input.resume();
    input.on('keypress', handler);
    render();
  });
}

export interface ScopeChoice {
  value: SkillScope;
  label: string;
  hint: string;
}

const SCOPE_CHOICES: ScopeChoice[] = [
  { value: 'project', label: 'This project', hint: 'install into the current directory' },
  { value: 'global', label: 'Global', hint: 'install into your home config for all projects' },
];

/** Single-choice picker for the install scope. Returns null if aborted. */
export async function selectScope(
  streams: TtyStreams = defaultStreams(),
  choices: ScopeChoice[] = SCOPE_CHOICES
): Promise<SkillScope | null> {
  let index = 0;
  const { output } = streams;
  let lines = 0;

  const render = (): void => {
    if (lines > 0) output.write(`${ESC}[${lines}A`);
    const out: string[] = [];
    out.push('Where should the /orchestrate skill be installed?');
    choices.forEach((choice, i) => {
      const pointer = i === index ? '❯' : ' ';
      const label = i === index ? `\x1b[36m${choice.label}\x1b[0m` : choice.label;
      out.push(`${ESC}[2K${pointer} ${label}  \x1b[2m${choice.hint}\x1b[0m`);
    });
    out.push(`${ESC}[2K\x1b[2m(↑/↓ to move, enter to select, Ctrl+C to cancel)\x1b[0m`);
    lines = out.length;
    output.write(`${out.join('\n')}\n`);
  };

  return runKeyLoop<SkillScope>(streams, render, (key) => {
    switch (key.name) {
      case 'up':
      case 'k':
        index = (index - 1 + choices.length) % choices.length;
        return { done: false };
      case 'down':
      case 'j':
        index = (index + 1) % choices.length;
        return { done: false };
      case 'return':
      case 'enter':
        return { done: true, value: choices[index].value };
      case 'escape':
        return { done: true, value: null };
      default:
        return { done: false };
    }
  });
}

/**
 * Multi-select checklist of harnesses. Space toggles, enter confirms.
 * Returns the selected harness ids, or null if aborted. An empty selection at
 * confirm time is treated as an abort (null) by the caller.
 */
export async function selectHarnesses(
  harnesses: HarnessTarget[],
  streams: TtyStreams = defaultStreams(),
  preselected: string[] = []
): Promise<string[] | null> {
  let index = 0;
  const selected = new Set<string>(preselected);
  const { output } = streams;
  let lines = 0;

  const render = (): void => {
    if (lines > 0) output.write(`${ESC}[${lines}A`);
    const out: string[] = [];
    out.push('Which coding harnesses? (space to toggle, a to toggle all)');
    harnesses.forEach((harness, i) => {
      const pointer = i === index ? '❯' : ' ';
      const box = selected.has(harness.id) ? '\x1b[32m◉\x1b[0m' : '◯';
      const label = i === index ? `\x1b[36m${harness.label}\x1b[0m` : harness.label;
      out.push(`${ESC}[2K${pointer} ${box} ${label}`);
    });
    out.push(`${ESC}[2K\x1b[2m(↑/↓ move, space toggle, enter confirm, Ctrl+C cancel)\x1b[0m`);
    lines = out.length;
    output.write(`${out.join('\n')}\n`);
  };

  return runKeyLoop<string[]>(streams, render, (key) => {
    switch (key.name) {
      case 'up':
      case 'k':
        index = (index - 1 + harnesses.length) % harnesses.length;
        return { done: false };
      case 'down':
      case 'j':
        index = (index + 1) % harnesses.length;
        return { done: false };
      case 'space':
        toggle(selected, harnesses[index].id);
        return { done: false };
      case 'a':
        if (selected.size === harnesses.length) {
          selected.clear();
        } else {
          harnesses.forEach((h) => selected.add(h.id));
        }
        return { done: false };
      case 'return':
      case 'enter':
        return { done: true, value: harnesses.filter((h) => selected.has(h.id)).map((h) => h.id) };
      case 'escape':
        return { done: true, value: null };
      default:
        return { done: false };
    }
  });
}

function toggle(set: Set<string>, id: string): void {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}
