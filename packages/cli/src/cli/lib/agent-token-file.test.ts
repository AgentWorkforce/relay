import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentTokenFile, readAgentTokenFile } from './agent-token-file.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-token-file-'));
  const file = path.join(dir, 'worker.json');
  const write = (body: unknown) => {
    const tmp = path.join(dir, `.tmp-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(tmp, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return { file, write };
}

describe('AgentTokenFile', () => {
  it('picks up an atomically replaced token on the next read', () => {
    const { file, write } = setup();
    write({ token: 'at_live_one', expiresAt: '2099-01-01T00:00:00Z' });
    const source = new AgentTokenFile(file);
    expect(source.read()).toBe('at_live_one');
    expect(source.read()).toBe('at_live_one');
    write({ token: 'at_live_two', expiresAt: '2099-01-01T00:15:00Z' });
    expect(source.read()).toBe('at_live_two');
  });

  it('returns null once the file is removed (identity released)', () => {
    const { file, write } = setup();
    write({ token: 'at_live_one' });
    const source = new AgentTokenFile(file);
    expect(source.read()).toBe('at_live_one');
    fs.rmSync(file);
    expect(source.read()).toBeNull();
  });

  it('refuses anything that is not an agent token', () => {
    const { file, write } = setup();
    write({ token: 'rt_live_run_token' });
    expect(new AgentTokenFile(file).read()).toBeNull();
    write({ token: 'rk_live_workspace' });
    expect(new AgentTokenFile(file).read()).toBeNull();
    write('not json');
    expect(new AgentTokenFile(file).read()).toBeNull();
  });

  it('one-shot reads ignore blank paths', () => {
    expect(readAgentTokenFile(undefined)).toBeUndefined();
    expect(readAgentTokenFile('  ')).toBeUndefined();
  });
});
