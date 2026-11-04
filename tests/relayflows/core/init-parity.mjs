// `relay init` for each agent tool on a machine with that tool: what it reads
// back from the core, what it writes where the tool looks, that it leaves the
// person's own settings and the other tools alone, and that `--uninstall` undoes it.

import assert from 'node:assert/strict';

import { TOOLS, scenario, withSandbox } from './harness.mjs';

const has = (command) => (text) => text.includes(command);

/** What each tool reads, and the core setting behind it. */
const ROUTES = {
  claude: {
    label: 'Claude Code',
    file: '.claude/settings.json',
    userFile: ['.claude/settings.json', '{"theme":"dark"}\n', '"theme"'],
    settings: ['direct_delivery', 'claude_session_hook', 'auto_activate'],
    written: (text) => {
      const settings = JSON.parse(text);
      assert.equal(settings.crossSessionInbound, 'accept');
      assert.match(JSON.stringify(settings.hooks.SessionStart), /claude-session-hook/);
    },
  },
  codex: {
    label: 'Codex',
    file: '.codex/hooks.json',
    settings: ['codex_stop_hook', 'auto_activate'],
    written: (text) => {
      const { hooks } = JSON.parse(text);
      for (const event of ['PostToolUse', 'Stop', 'SessionStart']) {
        assert.match(JSON.stringify(hooks[event]), /codex-stop-hook/);
      }
    },
  },
  opencode: {
    label: 'OpenCode',
    file: '.config/opencode/plugins/agent-relay.js',
    settings: ['opencode_plugin', 'opencode_auto_activate', 'auto_activate'],
    written: (text) => assert.ok(text.length > 0),
  },
  grok: {
    label: 'Grok CLI',
    file: '.grok/config.toml',
    userFile: ['.grok/config.toml', '[ui]\ntheme = "dark"\n', 'theme = "dark"'],
    settings: ['grok_leader', 'auto_activate'],
    written: (text) => assert.match(text, /use_leader = true/),
  },
  pi: {
    label: 'Pi',
    file: '.pi/agent/extensions/agent-relay.js',
    settings: ['pi_extension', 'pi_auto_activate', 'auto_activate'],
    written: (text) => assert.ok(text.length > 0),
  },
  devin: {
    label: 'Devin',
    file: '.config/devin/config.json',
    settings: ['devin_direct_delivery', 'auto_activate'],
    written: (text) => assert.ok(has('devin-hook')(text), text),
  },
  cursor: {
    label: 'Cursor',
    file: '.cursor/hooks.json',
    userFile: [
      '.cursor/hooks.json',
      '{"version":1,"hooks":{"stop":[{"command":"my-own-hook"}]}}\n',
      'my-own-hook',
    ],
    settings: ['cursor_direct_delivery', 'auto_activate'],
    written: (text) => {
      const { hooks } = JSON.parse(text);
      assert.match(JSON.stringify(hooks.stop), /cursor-hook/);
      assert.match(JSON.stringify(hooks.postToolUse), /cursor-hook/);
    },
  },
};

/** What `--uninstall` must leave no trace of, in a file that stays. */
const LEFT_BEHIND = {
  claude: /claude-session-hook|crossSessionInbound/,
  codex: /codex-stop-hook/,
  opencode: /./,
  grok: /use_leader = true/,
  pi: /./,
  devin: /devin-hook/,
  cursor: /cursor-hook/,
};

for (const tool of TOOLS) {
  const route = ROUTES[tool];
  await scenario(`relay init --tools ${tool}`, () =>
    withSandbox(async (machine) => {
      for (const installed of TOOLS) machine.markInstalled(installed);
      const [userFile, userContents, userMark] = route.userFile ?? [];
      if (userFile) machine.write(userFile, userContents);

      const output = await machine.init([tool]);
      assert.match(output, new RegExp(`✓ ${route.label}.*injected through`), output);
      route.written(machine.read(route.file));
      if (tool === 'codex') assert.match(machine.read('.codex/trusted.jsonl'), /hooks\.state/);
      if (userFile) assert.ok(machine.read(userFile).includes(userMark), 'init lost the person’s settings');

      const settings = await machine.call('settings.get');
      for (const key of route.settings) assert.equal(settings[key], true, `${key} is not on`);
      for (const other of TOOLS.filter((candidate) => candidate !== tool)) {
        for (const key of ROUTES[other].settings) {
          if (ROUTES[tool].settings.includes(key)) continue;
          assert.notEqual(settings[key], true, `relay init --tools ${tool} turned on ${key}`);
        }
        assert.ok(!machine.exists(ROUTES[other].file), `--tools ${tool} wrote ${ROUTES[other].file}`);
      }
      await machine.assertLocalOnly();

      await machine.relayOk(['init', '--uninstall']);
      const after = await machine.call('settings.get');
      for (const key of route.settings) assert.notEqual(after[key], true, `${key} stayed on`);
      if (userFile)
        assert.ok(machine.read(userFile).includes(userMark), 'uninstall lost the person’s settings');
      if (machine.exists(route.file)) assert.doesNotMatch(machine.read(route.file), LEFT_BEHIND[tool]);
      else assert.ok(!userFile, `uninstall removed ${route.file}, which the person had`);
    })
  );
}

await scenario('a second relay init attaches to the running core, and --stop leaves nothing answering', () =>
  withSandbox(async (machine) => {
    machine.markInstalled('grok');
    await machine.init(['grok']);
    const first = await machine.call('status.get');
    await machine.init(['grok']);
    const second = await machine.call('status.get');
    assert.equal(second.daemon.pid, first.daemon.pid);
    assert.deepEqual(second.workspace, first.workspace);
    await machine.relayOk(['init', '--stop']);
    await assert.rejects(() => machine.call('status.get'));
  })
);
