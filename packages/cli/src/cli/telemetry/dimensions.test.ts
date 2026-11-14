import { expect, it } from 'vitest';
import { telemetryClient, telemetryOs } from './dimensions.js';
it.each([
  ['darwin', 'macos'],
  ['macos', 'macos'],
  ['win32', 'windows'],
  ['windows', 'windows'],
  ['linux', 'linux'],
  ['ios', 'ios'],
  ['android', 'android'],
  ['private-platform', 'unknown'],
])('normalizes OS %s', (input, expected) => expect(telemetryOs(input)).toBe(expected));
it.each([
  ['claude-code', 'claude'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['grok', 'grok'],
  ['private/harness', 'unknown'],
  ['claude/opus-48', 'unknown'],
  ['CLAUDE-CODE', 'unknown'],
  [undefined, 'unknown'],
])('bounds inferred client %s', (input, expected) => expect(telemetryClient(input)).toBe(expected));
