import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_SUFFIX,
  claudeFileStates,
  openCodeConfigDir,
  openCodeState,
  tidyClaudeSettings,
  tidyOpenCodePlugin,
} from './init-leftovers.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-leftovers-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir`, relative, with its text. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const name = path.relative(dir, full);
    files[entry.isDirectory() ? `${name}/` : name] = entry.isDirectory() ? '' : fs.readFileSync(full, 'utf8');
  }
  return files;
}

/** What the core does to a Claude settings file: its first write copies the original beside it. */
function coreWrites(file: string, value: unknown): void {
  const backup = `${file}${BACKUP_SUFFIX}`;
  try {
    // Once: an existing copy is kept (COPYFILE_EXCL), and no file means no copy.
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  } catch {
    // No file yet, or already copied.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe('tidyClaudeSettings', () => {
  // The relay init end-to-end run on 2026-10-29: --uninstall left `{}` behind.
  it('removes a settings.json init created, with the core copy of it, once it is empty', () => {
    const claude = path.join(root, '.claude');
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, 'history.jsonl'), 'x\n');
    const before = tree(claude);
    const file = path.join(claude, 'settings.json');
    const states = claudeFileStates([file]);
    expect(states[file]).toEqual({ existed: false, backup: false, dir: true });

    // init: direct delivery creates the file, the hook (with a copy) adds to it.
    coreWrites(file, { crossSessionInbound: 'accept' });
    coreWrites(file, { crossSessionInbound: 'accept', hooks: { SessionStart: [] } });
    // --uninstall: the core writes hold and takes its hook out; init removes the key.
    coreWrites(file, { crossSessionInbound: 'hold' });
    coreWrites(file, {});

    tidyClaudeSettings(states);
    expect(tree(claude)).toEqual(before);
  });

  it('removes a Claude folder init created only when nothing else is in it', () => {
    const file = path.join(root, '.claude', 'settings.json');
    const states = claudeFileStates([file]);
    coreWrites(file, {});
    tidyClaudeSettings(states);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);

    const kept = path.join(root, '.claude-kept', 'settings.json');
    const keptStates = claudeFileStates([kept]);
    coreWrites(kept, {});
    fs.writeFileSync(path.join(root, '.claude-kept', 'sessions.json'), '{}');
    tidyClaudeSettings(keptStates);
    expect(tree(path.join(root, '.claude-kept'))).toEqual({ 'sessions.json': '{}' });
  });

  it("puts the person's own file back byte for byte when its content is unchanged", () => {
    const claude = path.join(root, '.claude');
    fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const mine = '{ "model": "opus",\n  "permissions": { "allow": ["Bash(npm test *)"] } }';
    fs.writeFileSync(file, mine);
    const before = tree(claude);
    const states = claudeFileStates([file]);

    coreWrites(file, {
      model: 'opus',
      permissions: { allow: ['Bash(npm test *)'] },
      crossSessionInbound: 'accept',
    });
    coreWrites(file, { permissions: { allow: ['Bash(npm test *)'] }, model: 'opus' });

    tidyClaudeSettings(states);
    expect(tree(claude)).toEqual(before);
  });

  it('keeps a file the person changed since, and a file that is not empty', () => {
    const claude = path.join(root, '.claude');
    fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{"model":"opus"}');
    const created = path.join(root, '.claude-new', 'settings.json');
    const states = claudeFileStates([file, created]);

    coreWrites(file, { model: 'opus', crossSessionInbound: 'accept' });
    coreWrites(file, { model: 'sonnet' });
    coreWrites(created, { theme: 'dark' });

    tidyClaudeSettings(states);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'sonnet' });
    expect(fs.readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8')).toBe('{"model":"opus"}');
    expect(JSON.parse(fs.readFileSync(created, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('leaves a copy that was there before init', () => {
    const claude = path.join(root, '.claude');
    fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');
    fs.writeFileSync(`${file}${BACKUP_SUFFIX}`, '{"older":true}');
    const states = claudeFileStates([file]);
    coreWrites(file, { a: 1, crossSessionInbound: 'accept' });
    coreWrites(file, { a: 1 });
    tidyClaudeSettings(states);
    expect(fs.readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8')).toBe('{"older":true}');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
  });

  it('never removes a settings file reached through a link', () => {
    const claude = path.join(root, '.claude');
    fs.mkdirSync(claude);
    const target = path.join(root, 'dotfiles.json');
    const file = path.join(claude, 'settings.json');
    fs.symlinkSync(target, file);
    const states = claudeFileStates([file]);
    expect(states[file].existed).toBe(true);
    fs.writeFileSync(target, '{}\n');
    tidyClaudeSettings(states);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('{}\n');
  });
});

describe('tidyOpenCodePlugin', () => {
  const marker = (file: string) => `${file}.off`;
  const coreOff = (file: string) =>
    fs.writeFileSync(
      marker(file),
      "Agent Relay's OpenCode plugin was turned off in Agent Relay's settings.\n" +
        'Delete this file, or turn OpenCode sessions on there, to allow it again.\n'
    );

  it('reads OpenCode config from XDG_CONFIG_HOME, else ~/.config, as the core does', () => {
    expect(openCodeConfigDir({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/me')).toBe('/x/cfg/opencode');
    expect(openCodeConfigDir({ XDG_CONFIG_HOME: 'relative' }, '/home/me')).toBe('/home/me/.config/opencode');
    expect(openCodeConfigDir({}, '/home/me')).toBe('/home/me/.config/opencode');
  });

  // The same run: --uninstall left plugins/agent-relay.js.off behind.
  it('removes the off marker an init-installed plugin left, and a plugins folder init created', () => {
    const config = path.join(root, 'opencode');
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, 'opencode.json'), '{}');
    const before = tree(config);
    const state = openCodeState(config);
    expect(state).toEqual({
      file: path.join(config, 'plugins', 'agent-relay.js'),
      plugin: false,
      off: false,
      dir: false,
    });

    fs.mkdirSync(path.dirname(state.file));
    fs.writeFileSync(state.file, '// AGENT_RELAY_OPENCODE_PLUGIN=7\n');
    fs.rmSync(state.file);
    coreOff(state.file);

    tidyOpenCodePlugin(state);
    expect(tree(config)).toEqual(before);
  });

  it("keeps a marker that was there before init, the person's own plugin and their plugins", () => {
    const plugins = path.join(root, 'opencode', 'plugins');
    fs.mkdirSync(plugins, { recursive: true });
    const file = path.join(plugins, 'agent-relay.js');
    coreOff(file);
    const offBefore = openCodeState(path.join(root, 'opencode'));
    tidyOpenCodePlugin(offBefore);
    expect(fs.existsSync(marker(file))).toBe(true);

    fs.rmSync(marker(file));
    fs.writeFileSync(file, '// mine\n');
    const theirs = openCodeState(path.join(root, 'opencode'));
    coreOff(file);
    tidyOpenCodePlugin(theirs);
    expect(fs.existsSync(marker(file))).toBe(true);

    fs.rmSync(file);
    fs.rmSync(marker(file));
    fs.writeFileSync(path.join(plugins, 'other.js'), '//\n');
    const fresh = openCodeState(path.join(root, 'opencode'));
    coreOff(file);
    tidyOpenCodePlugin(fresh);
    expect(fs.readdirSync(plugins)).toEqual(['other.js']);
  });

  it('leaves a file at the marker name that the core did not write', () => {
    const config = path.join(root, 'opencode');
    const state = openCodeState(config);
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    fs.writeFileSync(marker(state.file), 'my note\n');
    tidyOpenCodePlugin(state);
    expect(fs.readFileSync(marker(state.file), 'utf8')).toBe('my note\n');
  });
});
