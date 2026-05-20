/**
 * Regression tests for WorkflowRunner.scrubForChannel — the function that
 * strips PTY/TUI chrome from interactive-agent step output before it gets
 * surfaced in workflow logs and channel messages.
 *
 * The patterns covered here are taken from a real captured run of a
 * multi-turn workflow against Claude Code's PTY: when its TUI footer
 * overwrites itself faster than the PTY flushes whitespace, lines like
 * `bypasspermissionson`, `--INSERT--⏵⏵`, and `Opus 4.7 (1M context) ctx:5%
 * $1.45` end up in the captured stream. Before these regex additions, the
 * step "Output:" block was unreadable on interactive-agent steps.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowRunner } from '../runner.js';

// scrubForChannel is `private static` — the cast is the minimal-invasive way
// to exercise it from a test without exporting an internal-only helper.
const scrub = (text: string): string =>
  (WorkflowRunner as unknown as { scrubForChannel(t: string): string }).scrubForChannel(text);

describe('WorkflowRunner.scrubForChannel — PTY chrome stripping', () => {
  it('strips the Claude Code bottom status bar (model + ctx% + cost)', () => {
    const input = [
      'real content line',
      'workflows git:(main) Opus 4.7 (1M context) ctx:5% $1.45',
      'Opus4.7(1Mcontext) ctx:6% $1.54',
      'another real line',
    ].join('\n');
    const out = scrub(input);
    expect(out).toContain('real content line');
    expect(out).toContain('another real line');
    expect(out).not.toMatch(/ctx\s*:\s*\d+%/);
    expect(out).not.toMatch(/\$\d+\.\d+/);
  });

  it('strips vim-style mode indicators emitted by the input bar', () => {
    const input = [
      'pre-mode line',
      '--INSERT--',
      '--INSERT--⏵⏵bypasspermissionson (shift+tabtocycle)',
      'post-mode line',
    ].join('\n');
    const out = scrub(input);
    expect(out).toContain('pre-mode line');
    expect(out).toContain('post-mode line');
    expect(out).not.toMatch(/--INSERT--/);
  });

  it('strips no-whitespace TUI hint variants (bypasspermissionson, pasteagaintoexpand)', () => {
    const input = ['before', 'bypasspermissionson', 'pasteagaintoexpand', 'shifttabto cycle', 'after'].join(
      '\n'
    );
    const out = scrub(input);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toMatch(/bypasspermissionson/);
    expect(out).not.toMatch(/pasteagaintoexpand/);
  });

  it('strips thinking-status fragments without ellipsis anchors', () => {
    const input = [
      'meaningful: round 3 codex-player guess=19 feedback=correct',
      'thinking with high effort',
      '↓ 13 tokens · thinking with high effort',
      'Crunched for 32s',
      'Sautéed for 4s',
      'Gitifying…55',
    ].join('\n');
    const out = scrub(input);
    expect(out).toContain('feedback=correct');
    expect(out).not.toMatch(/thinking with high effort/);
    expect(out).not.toMatch(/Crunched for/);
    expect(out).not.toMatch(/Gitifying/);
  });

  it('strips malformed overwritten q0/qW0 PTY frame runs', () => {
    const input = [
      'first useful line',
      'qW0 | q0 / ql0 _ qqm ~ lqq = qW0 | q0 / ql0 _ qqm',
      'summary: kept qW0 | q0 / ql0 _ qqm ~ lqq = qW0 | q0 done',
      'last useful line',
    ].join('\n');
    const out = scrub(input);
    expect(out).toContain('first useful line');
    expect(out).toContain('last useful line');
    expect(out).toMatch(/summary: kept\s+done/);
    expect(out).not.toMatch(/qW0|ql0|qqm|lqq/);
  });

  it('redacts secrets in the runner public preview path', () => {
    const out = scrub('deploy succeeded\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456\n');
    expect(out).toContain('deploy succeeded');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('preserves real content and OWNER_DECISION signals', () => {
    const input = [
      'Read 1 file, calling relaycast 2 times',
      'Transcript verification reports TRANSCRIPT_OK with all 6 lines well-formed.',
      'OWNER_DECISION: COMPLETE',
      'REASON: All 6 turns executed, history.log has 6 lines.',
      'STEP_COMPLETE: repair-transcript',
    ].join('\n');
    const out = scrub(input);
    expect(out).toContain('TRANSCRIPT_OK');
    expect(out).toContain('OWNER_DECISION: COMPLETE');
    expect(out).toContain('STEP_COMPLETE: repair-transcript');
    expect(out).toContain('All 6 turns executed');
  });

  it('does not strip lines that merely mention model names in prose', () => {
    // Guard against the new claudeFooterRe (which looks for `Opus|Sonnet|Haiku <num>
    // (...context...) ctx:N%`) being too eager and removing prose that
    // mentions a model name.
    const input = [
      'Compared output from Opus 4.7 against Sonnet 4.6 — both passed.',
      'We chose Haiku 4.5 for its latency profile.',
    ].join('\n');
    const out = scrub(input);
    expect(out).toContain('Opus 4.7 against Sonnet 4.6');
    expect(out).toContain('Haiku 4.5 for its latency profile');
  });
});
