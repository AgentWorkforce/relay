import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditCodexRecords, isDigestOnlyCommand, auditOwnedCodexSession } from './codex-proof.mjs';

const command = "printf '%s' '0123456789abcdef0123456789abcdef' | shasum -a 256";
const call = (name, args = {}, type = 'function_call') => ({
  type: 'response_item',
  payload: { type, name, arguments: JSON.stringify(args) },
});
test('session audit selects only a new owned cwd and fails closed on ambiguous ownership', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-proof-audit-'));
  try {
    const cwd = path.join(dir, 'actor');
    mkdirSync(cwd);
    const startedAt = '2026-09-08T00:00:00Z';
    const transcript = (cwd, id) =>
      [{ type: 'session_meta', payload: { cwd, id, timestamp: startedAt, cli_version: 'fixture' } }, ...valid]
        .map((r) => JSON.stringify(r))
        .join('\n');
    writeFileSync(path.join(dir, 'old.jsonl'), transcript(cwd, 'old'));
    writeFileSync(path.join(dir, 'other.jsonl'), transcript('/nonexistent-other-cwd', 'other'));
    writeFileSync(path.join(dir, 'owned.jsonl'), transcript(cwd, 'owned'));
    const options = { directory: dir, before: new Set([path.join(dir, 'old.jsonl')]), cwd, startedAt };
    const result = await auditOwnedCodexSession(options);
    assert.equal(result.sessionId, 'owned');
    assert.equal(result.pass, true);
    writeFileSync(path.join(dir, 'duplicate.jsonl'), transcript(cwd, 'duplicate'));
    await assert.rejects(auditOwnedCodexSession(options), /exactly one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const postArgs = { channel: 'local-ai-proof', text: 'GHSUB_ACK ' + 'a'.repeat(64) };
const valid = [call('exec_command', { cmd: command }), call('mcp__agent-relay__post_message', postArgs)];
const hosted = (input) => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', input },
});
test('hosted code-mode audit parses only literal direct digest/action calls without executing code', () => {
  const digest = `text(await tools.exec_command(${JSON.stringify({ cmd: command, login: false })}));`;
  const post = `text(await tools.mcp__agent_relay__post_message(${JSON.stringify(postArgs)}));`;
  assert.equal(auditCodexRecords([hosted(digest), hosted(post)]).pass, true);
  for (const script of [
    digest + '; fetch("http://bad")',
    'text(await tools.exec_command({cmd: process.env.SECRET}));',
    'text(await tools.exec_command({...options}));',
    'text(await tools.exec_command({cmd: getter()}));',
    'text(await tools.mcp__agent_relay__check_inbox({}));',
    'text(ALL_TOOLS);',
    'const r=await tools.exec_command({}); text(r);',
  ]) {
    assert.equal(auditCodexRecords([...valid, hosted(script)]).pass, false, script);
  }
});
test('digest and outbound action are required, and raw commands are not retained', () => {
  const result = auditCodexRecords(valid);
  assert.equal(result.pass, true);
  assert.equal(JSON.stringify(result).includes('0123456789abcdef'), false);
  assert.equal(auditCodexRecords(valid.slice(0, 1)).pass, false);
  assert.equal(auditCodexRecords(valid.slice(1)).pass, false);
  assert.equal(auditCodexRecords([]).pass, false);
});
test('history/network/indirect tool execution invalidates otherwise successful actions', () => {
  for (const extra of [
    call('mcp__agent-relay__check_inbox'),
    call('mcp__agent-relay__list_messages'),
    call('exec_command', { cmd: command + '; curl localhost' }),
    call('exec', {}, 'custom_tool_call'),
    call(undefined, {}, 'web_search_call'),
    call('exec_command', { cmd: 'cat report.json' }),
    call('spawn_agent'),
  ]) {
    assert.equal(auditCodexRecords([...valid, extra]).pass, false, extra.payload.name);
  }
  assert.equal(isDigestOnlyCommand(command + '\ncat secret'), false);
  assert.equal(isDigestOnlyCommand("printf '%s' '$(cat secret)' | shasum -a 256"), false);
});
