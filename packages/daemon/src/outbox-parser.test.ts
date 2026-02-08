import { describe, it, expect } from 'vitest';
import { parseOutboxFile } from './outbox-parser.js';

describe('parseOutboxFile', () => {
  it('parses header-format file with body', () => {
    const content = 'TO: Alice\nKIND: message\n\nHello there';
    const result = parseOutboxFile(content);
    expect(result).toEqual({
      to: 'Alice',
      kind: 'message',
      name: undefined,
      cli: undefined,
      thread: undefined,
      action: undefined,
      body: 'Hello there',
    });
  });

  it('parses spawn file', () => {
    const content = 'KIND: spawn\nNAME: Worker1\nCLI: claude\n\nDo the task';
    const result = parseOutboxFile(content);
    expect(result?.kind).toBe('spawn');
    expect(result?.name).toBe('Worker1');
    expect(result?.cli).toBe('claude');
    expect(result?.body).toBe('Do the task');
  });

  it('parses release file', () => {
    const content = 'KIND: release\nNAME: Worker1\n\nTask completed';
    const result = parseOutboxFile(content);
    expect(result?.kind).toBe('release');
    expect(result?.name).toBe('Worker1');
    expect(result?.body).toBe('Task completed');
  });

  it('parses file with thread header', () => {
    const content = 'TO: Bob\nTHREAD: task-123\n\nUpdate on the task';
    const result = parseOutboxFile(content);
    expect(result?.to).toBe('Bob');
    expect(result?.thread).toBe('task-123');
    expect(result?.body).toBe('Update on the task');
  });

  it('parses continuity file with action', () => {
    const content = 'KIND: continuity\nACTION: save\n\nCurrent state data';
    const result = parseOutboxFile(content);
    expect(result?.kind).toBe('continuity');
    expect(result?.action).toBe('save');
    expect(result?.body).toBe('Current state data');
  });

  it('defaults kind to message when only TO is present', () => {
    const content = 'TO: Alice\n\nHello';
    const result = parseOutboxFile(content);
    expect(result?.kind).toBe('message');
  });

  it('falls back to JSON parsing', () => {
    const content = JSON.stringify({ to: 'Bob', body: 'Hi' });
    const result = parseOutboxFile(content);
    expect(result?.to).toBe('Bob');
    expect(result?.body).toBe('Hi');
    expect(result?.kind).toBe('message');
  });

  it('returns null for invalid content', () => {
    const result = parseOutboxFile('just some random text without headers');
    expect(result).toBeNull();
  });

  it('handles file with headers only (no body)', () => {
    const content = 'TO: Alice\nKIND: message';
    const result = parseOutboxFile(content);
    expect(result?.to).toBe('Alice');
    expect(result?.body).toBe('');
  });

  it('handles multiline body', () => {
    const content = 'TO: Alice\n\nLine 1\nLine 2\nLine 3';
    const result = parseOutboxFile(content);
    expect(result?.body).toBe('Line 1\nLine 2\nLine 3');
  });

  it('trims body whitespace', () => {
    const content = 'TO: Alice\n\n  Hello with spaces  \n';
    const result = parseOutboxFile(content);
    expect(result?.body).toBe('Hello with spaces');
  });

  it('handles case-insensitive headers', () => {
    const content = 'to: Alice\nkind: spawn\nname: Worker1\ncli: claude\n\nTask';
    const result = parseOutboxFile(content);
    expect(result?.to).toBe('Alice');
    expect(result?.kind).toBe('spawn');
    expect(result?.name).toBe('Worker1');
    expect(result?.cli).toBe('claude');
  });
});
