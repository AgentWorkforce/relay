/**
 * Tests for Precompiled Pattern Matching
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCompiledPatterns,
  isInstructionalTextFast,
  isPlaceholderTargetFast,
  stripAnsiFast,
  isSpawnOrReleaseCommandFast,
  isEscapedFenceEndFast,
  unescapeFenceMarkersFast,
  StaticPatterns,
  benchmarkPatterns,
  trackPatternPerformance,
  getPatternMetrics,
  resetPatternMetrics,
} from './precompiled-patterns.js';

// =============================================================================
// Pattern Caching Tests
// =============================================================================

describe('getCompiledPatterns', () => {
  it('returns patterns for default prefixes', () => {
    const patterns = getCompiledPatterns();
    expect(patterns.inline).toBeInstanceOf(RegExp);
    expect(patterns.fencedInline).toBeInstanceOf(RegExp);
    expect(patterns.escape).toBeInstanceOf(RegExp);
  });

  it('caches patterns by prefix configuration', () => {
    const patterns1 = getCompiledPatterns('->relay:', '->thinking:');
    const patterns2 = getCompiledPatterns('->relay:', '->thinking:');
    expect(patterns1).toBe(patterns2); // Same object reference
  });

  it('creates separate patterns for different prefixes', () => {
    const patterns1 = getCompiledPatterns('->relay:', '->thinking:');
    const patterns2 = getCompiledPatterns('->msg:', '->thought:');
    expect(patterns1).not.toBe(patterns2);
  });

  it('matches inline relay messages', () => {
    const patterns = getCompiledPatterns();
    const match = '->relay:Agent Hello world'.match(patterns.inline);
    expect(match).not.toBeNull();
    expect(match![2]).toBe('Agent'); // Target
    expect(match![5]).toBe('Hello world'); // Body
  });

  it('matches inline thinking messages', () => {
    const patterns = getCompiledPatterns();
    const match = '->thinking:Agent Some thought'.match(patterns.inline);
    expect(match).not.toBeNull();
    expect(match![2]).toBe('Agent');
    expect(match![5]).toBe('Some thought');
  });

  it('matches fenced inline start', () => {
    const patterns = getCompiledPatterns();
    expect(patterns.fencedInline.test('->relay:Agent <<<')).toBe(true);
    expect(patterns.fencedInline.test('->thinking:Agent <<<')).toBe(true);
    expect(patterns.fencedInline.test('->relay:Agent Hello')).toBe(false);
  });

  it('matches thread syntax', () => {
    const patterns = getCompiledPatterns();
    const match = '->relay:Agent [thread:task-123] Hello'.match(patterns.inline);
    expect(match).not.toBeNull();
    expect(match![4]).toBe('task-123'); // Thread ID
  });

  it('matches cross-project thread syntax', () => {
    const patterns = getCompiledPatterns();
    const match = '->relay:Agent [thread:frontend:task-123] Hello'.match(patterns.inline);
    expect(match).not.toBeNull();
    expect(match![3]).toBe('frontend'); // Thread project
    expect(match![4]).toBe('task-123'); // Thread ID
  });

  it('handles prompt prefixes', () => {
    const patterns = getCompiledPatterns();
    expect(patterns.inline.test('> ->relay:Agent Hello')).toBe(true);
    expect(patterns.inline.test('$ ->relay:Agent Hello')).toBe(true);
    expect(patterns.inline.test('  > ->relay:Agent Hello')).toBe(true);
    expect(patterns.inline.test('• ->relay:Agent Hello')).toBe(true);
  });

  it('matches escape pattern', () => {
    const patterns = getCompiledPatterns();
    expect(patterns.escape.test('\\->relay:Agent')).toBe(true);
    expect(patterns.escape.test('\\->thinking:Agent')).toBe(true);
    expect(patterns.escape.test('->relay:Agent')).toBe(false);
  });
});

// =============================================================================
// Instructional Text Detection Tests
// =============================================================================

describe('isInstructionalTextFast', () => {
  it('detects SEND: at end of body', () => {
    expect(isInstructionalTextFast('Please SEND:')).toBe(true);
    expect(isInstructionalTextFast('Message to send')).toBe(false);
  });

  it('detects PROTOCOL: (N) pattern', () => {
    expect(isInstructionalTextFast('PROTOCOL: (1) Message format')).toBe(true);
    expect(isInstructionalTextFast('Protocol for messaging')).toBe(false);
  });

  it('detects Example: marker', () => {
    expect(isInstructionalTextFast('Example: how to send')).toBe(true);
    expect(isInstructionalTextFast('For example')).toBe(false); // No colon
  });

  it('detects escaped prefixes', () => {
    expect(isInstructionalTextFast('Use \\->relay: to send')).toBe(true);
    expect(isInstructionalTextFast('Use \\->thinking: for thoughts')).toBe(true);
  });

  it('detects placeholder starts', () => {
    expect(isInstructionalTextFast('AgentName should receive')).toBe(true);
    expect(isInstructionalTextFast('Target agent is')).toBe(true);
  });

  it('detects injected instruction header', () => {
    expect(isInstructionalTextFast('[Agent Relay] Instructions')).toBe(true);
  });

  it('detects MULTI-LINE and RECEIVE markers', () => {
    expect(isInstructionalTextFast('MULTI-LINE: format')).toBe(true);
    expect(isInstructionalTextFast('RECEIVE: messages')).toBe(true);
  });

  it('handles case insensitivity', () => {
    // SEND: at end of string matches (case insensitive)
    expect(isInstructionalTextFast('send:')).toBe(true);
    expect(isInstructionalTextFast('please send:')).toBe(true);
    // Example: anywhere matches
    expect(isInstructionalTextFast('example: test')).toBe(true);
    expect(isInstructionalTextFast('EXAMPLE: test')).toBe(true);
    // Random colons don't match
    expect(isInstructionalTextFast('hello: world')).toBe(false);
  });

  it('returns false for normal messages', () => {
    expect(isInstructionalTextFast('Hello Agent')).toBe(false);
    expect(isInstructionalTextFast('Please review the code')).toBe(false);
    expect(isInstructionalTextFast('ACK: Task received')).toBe(false);
  });
});

// =============================================================================
// Placeholder Target Tests
// =============================================================================

describe('isPlaceholderTargetFast', () => {
  it('detects placeholder targets', () => {
    expect(isPlaceholderTargetFast('agentname')).toBe(true);
    expect(isPlaceholderTargetFast('AgentName')).toBe(true);
    expect(isPlaceholderTargetFast('AGENTNAME')).toBe(true);
    expect(isPlaceholderTargetFast('target')).toBe(true);
    expect(isPlaceholderTargetFast('recipient')).toBe(true);
    expect(isPlaceholderTargetFast('yourTarget')).toBe(true);
    expect(isPlaceholderTargetFast('targetAgent')).toBe(true);
    expect(isPlaceholderTargetFast('someAgent')).toBe(true);
    expect(isPlaceholderTargetFast('otherAgent')).toBe(true);
    expect(isPlaceholderTargetFast('worker')).toBe(true);
  });

  it('allows valid agent names', () => {
    expect(isPlaceholderTargetFast('Lead')).toBe(false);
    expect(isPlaceholderTargetFast('Developer')).toBe(false);
    expect(isPlaceholderTargetFast('Reviewer')).toBe(false);
    expect(isPlaceholderTargetFast('Alice')).toBe(false);
    expect(isPlaceholderTargetFast('Bob')).toBe(false);
  });

  it('uses O(1) lookup', () => {
    // Performance test - should be fast even with many calls
    const start = process.hrtime.bigint();
    for (let i = 0; i < 10000; i++) {
      isPlaceholderTargetFast('target');
      isPlaceholderTargetFast('Lead');
    }
    const elapsed = Number(process.hrtime.bigint() - start);
    expect(elapsed).toBeLessThan(50_000_000); // < 50ms for 20k calls (generous for CI variance)
  });
});

// =============================================================================
// ANSI Stripping Tests
// =============================================================================

describe('stripAnsiFast', () => {
  it('strips basic color codes', () => {
    expect(stripAnsiFast('\x1b[32mgreen\x1b[0m')).toBe('green');
    expect(stripAnsiFast('\x1b[1;31mbold red\x1b[0m')).toBe('bold red');
  });

  it('strips cursor movement codes', () => {
    expect(stripAnsiFast('\x1b[2Aup\x1b[3Bdown')).toBe('updown');
    expect(stripAnsiFast('\x1b[?25h')).toBe(''); // Show cursor
    expect(stripAnsiFast('\x1b[?25l')).toBe(''); // Hide cursor
  });

  it('strips OSC sequences', () => {
    expect(stripAnsiFast('\x1b]0;title\x07text')).toBe('text');
    expect(stripAnsiFast('\x1b]0;title\x1b\\text')).toBe('text');
  });

  it('strips carriage returns', () => {
    expect(stripAnsiFast('hello\rworld')).toBe('helloworld');
  });

  it('strips orphaned CSI sequences', () => {
    expect(stripAnsiFast('[?25h visible')).toBe('visible');
    expect(stripAnsiFast('[0m text')).toBe('text');
  });

  it('preserves non-CSI brackets', () => {
    expect(stripAnsiFast('[Agent Relay]')).toBe('[Agent Relay]');
    expect(stripAnsiFast('[thread:id]')).toBe('[thread:id]');
  });

  it('handles empty string', () => {
    expect(stripAnsiFast('')).toBe('');
  });

  it('handles string without ANSI', () => {
    const text = 'Hello world';
    expect(stripAnsiFast(text)).toBe(text);
  });
});

// =============================================================================
// Spawn/Release Command Tests
// =============================================================================

describe('isSpawnOrReleaseCommandFast', () => {
  it('detects spawn commands', () => {
    expect(isSpawnOrReleaseCommandFast('->relay:spawn Worker claude "task"')).toBe(true);
    expect(isSpawnOrReleaseCommandFast('->relay:spawn MyAgent codex')).toBe(true);
  });

  it('detects release commands', () => {
    expect(isSpawnOrReleaseCommandFast('->relay:release Worker')).toBe(true);
    expect(isSpawnOrReleaseCommandFast('->relay:release MyAgent')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSpawnOrReleaseCommandFast('->relay:SPAWN Worker claude')).toBe(true);
    expect(isSpawnOrReleaseCommandFast('->relay:Spawn Worker claude')).toBe(true);
    expect(isSpawnOrReleaseCommandFast('->relay:RELEASE Worker')).toBe(true);
  });

  it('rejects regular messages', () => {
    expect(isSpawnOrReleaseCommandFast('->relay:Agent Hello')).toBe(false);
    expect(isSpawnOrReleaseCommandFast('->relay:Lead ACK')).toBe(false);
  });
});

// =============================================================================
// Fence Escape Tests
// =============================================================================

describe('isEscapedFenceEndFast', () => {
  it('detects escaped fence end at line end', () => {
    expect(isEscapedFenceEndFast('content\\>>>')).toBe(true);
    expect(isEscapedFenceEndFast('content\\>>>  ')).toBe(true);
  });

  it('detects escaped fence end at line start', () => {
    expect(isEscapedFenceEndFast('\\>>>')).toBe(true);
    expect(isEscapedFenceEndFast('  \\>>>')).toBe(true);
  });

  it('returns false for unescaped fence end', () => {
    expect(isEscapedFenceEndFast('content>>>')).toBe(false);
    expect(isEscapedFenceEndFast('>>>')).toBe(false);
  });
});

describe('unescapeFenceMarkersFast', () => {
  it('unescapes fence start', () => {
    expect(unescapeFenceMarkersFast('\\<<<')).toBe('<<<');
    expect(unescapeFenceMarkersFast('text \\<<< more')).toBe('text <<< more');
  });

  it('unescapes fence end', () => {
    expect(unescapeFenceMarkersFast('\\>>>')).toBe('>>>');
    expect(unescapeFenceMarkersFast('text \\>>> more')).toBe('text >>> more');
  });

  it('unescapes multiple markers', () => {
    expect(unescapeFenceMarkersFast('\\<<< content \\>>>')).toBe('<<< content >>>');
  });

  it('preserves unescaped markers', () => {
    expect(unescapeFenceMarkersFast('<<< content >>>')).toBe('<<< content >>>');
  });
});

// =============================================================================
// Static Patterns Tests
// =============================================================================

describe('StaticPatterns', () => {
  it('matches code fence', () => {
    expect(StaticPatterns.CODE_FENCE.test('```typescript')).toBe(true);
    expect(StaticPatterns.CODE_FENCE.test('```')).toBe(true);
    expect(StaticPatterns.CODE_FENCE.test('text ```')).toBe(false); // Must be at start
  });

  it('matches block markers', () => {
    expect(StaticPatterns.BLOCK_END.test('[[/RELAY]]')).toBe(true);
    expect(StaticPatterns.BLOCK_METADATA_END.test('[[/RELAY_METADATA]]')).toBe(true);
  });

  it('matches fence end patterns', () => {
    expect(StaticPatterns.FENCE_END.test('>>>')).toBe(true);
    expect(StaticPatterns.FENCE_END.test('content>>>')).toBe(true);
    expect(StaticPatterns.FENCE_END.test('  >>>')).toBe(true);
  });

  it('matches bullet/numbered list', () => {
    expect(StaticPatterns.BULLET_OR_NUMBERED_LIST.test('  - item')).toBe(true);
    expect(StaticPatterns.BULLET_OR_NUMBERED_LIST.test('  * item')).toBe(true);
    expect(StaticPatterns.BULLET_OR_NUMBERED_LIST.test('  1. item')).toBe(true);
    expect(StaticPatterns.BULLET_OR_NUMBERED_LIST.test('  2) item')).toBe(true);
  });

  it('matches promptish lines', () => {
    expect(StaticPatterns.PROMPTISH_LINE.test('> ')).toBe(true);
    expect(StaticPatterns.PROMPTISH_LINE.test('$ ')).toBe(true);
    expect(StaticPatterns.PROMPTISH_LINE.test('  > ')).toBe(true);
  });

  it('matches relay injection prefix', () => {
    expect(StaticPatterns.RELAY_INJECTION_PREFIX.test('Relay message from Agent')).toBe(true);
    expect(StaticPatterns.RELAY_INJECTION_PREFIX.test('  Relay message from Agent')).toBe(true);
  });

  it('validates agent names', () => {
    expect(StaticPatterns.AGENT_NAME.test('Agent')).toBe(true);
    expect(StaticPatterns.AGENT_NAME.test('MyAgent123')).toBe(true);
    expect(StaticPatterns.AGENT_NAME.test('A1')).toBe(true);
    expect(StaticPatterns.AGENT_NAME.test('agent')).toBe(false); // Must start uppercase
    expect(StaticPatterns.AGENT_NAME.test('A')).toBe(false); // Too short
    expect(StaticPatterns.AGENT_NAME.test('A'.repeat(31))).toBe(false); // Too long
  });

  it('matches CLI prompts by type', () => {
    expect(StaticPatterns.CLI_PROMPTS.claude.test('> ')).toBe(true);
    expect(StaticPatterns.CLI_PROMPTS.other.test('$ ')).toBe(true);
  });

  it('matches thinking block markers', () => {
    expect(StaticPatterns.THINKING_START.test('<thinking>')).toBe(true);
    expect(StaticPatterns.THINKING_END.test('</thinking>')).toBe(true);
  });
});

// =============================================================================
// Performance Tracking Tests
// =============================================================================

describe('Pattern Performance Tracking', () => {
  beforeEach(() => {
    resetPatternMetrics();
  });

  it('tracks pattern performance', () => {
    trackPatternPerformance('test', 1.5);
    trackPatternPerformance('test', 2.5);
    trackPatternPerformance('test', 1.0);

    const metrics = getPatternMetrics();
    const testMetric = metrics.get('test');

    expect(testMetric).toBeDefined();
    expect(testMetric!.calls).toBe(3);
    expect(testMetric!.totalMs).toBe(5.0);
    expect(testMetric!.maxMs).toBe(2.5);
    expect(testMetric!.avgMs).toBeCloseTo(5.0 / 3);
  });

  it('resets metrics', () => {
    trackPatternPerformance('test', 1.0);
    resetPatternMetrics();
    const metrics = getPatternMetrics();
    expect(metrics.size).toBe(0);
  });
});

// =============================================================================
// Benchmark Tests
// =============================================================================

describe('benchmarkPatterns', () => {
  it('runs benchmark and returns results', () => {
    const results = benchmarkPatterns(100); // Small iteration count for test

    expect(results.instructionalCheck).toBeDefined();
    expect(results.instructionalCheck.avgNs).toBeGreaterThan(0);
    expect(results.instructionalCheck.maxNs).toBeGreaterThan(0);

    expect(results.ansiStrip).toBeDefined();
    expect(results.placeholderCheck).toBeDefined();
  });

  it('benchmark average is reasonable', () => {
    const results = benchmarkPatterns(1000);

    // Average should be under 10 microseconds (10000 ns) per operation
    expect(results.instructionalCheck.avgNs).toBeLessThan(10000);
    expect(results.ansiStrip.avgNs).toBeLessThan(10000);
    expect(results.placeholderCheck.avgNs).toBeLessThan(10000);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  it('handles empty strings', () => {
    expect(isInstructionalTextFast('')).toBe(false);
    expect(isPlaceholderTargetFast('')).toBe(false);
    expect(stripAnsiFast('')).toBe('');
    expect(isSpawnOrReleaseCommandFast('')).toBe(false);
  });

  it('handles very long strings', () => {
    const longString = 'a'.repeat(100000);
    expect(stripAnsiFast(longString)).toBe(longString);
    expect(isInstructionalTextFast(longString)).toBe(false);
  });

  it('handles unicode', () => {
    expect(stripAnsiFast('Hello 世界 🌍')).toBe('Hello 世界 🌍');
    expect(isPlaceholderTargetFast('日本語Agent')).toBe(false);
  });

  it('handles special regex characters in content', () => {
    expect(stripAnsiFast('regex: .* [a-z]+ (group)')).toBe('regex: .* [a-z]+ (group)');
    expect(isInstructionalTextFast('Use regex: .*')).toBe(false);
  });
});
