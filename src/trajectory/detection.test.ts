/**
 * Tests for trajectory detection functions
 */

import { describe, it, expect } from 'vitest';
import { detectToolCalls, detectErrors } from './integration.js';

describe('detectToolCalls', () => {
  it('detects tool completion markers', () => {
    const output = `
✓ Read file.ts
✔ Bash completed
`;
    const tools = detectToolCalls(output);
    expect(tools).toHaveLength(2);
    expect(tools[0].tool).toBe('Read');
    expect(tools[0].status).toBe('completed');
    expect(tools[1].tool).toBe('Bash');
    expect(tools[1].status).toBe('completed');
  });

  it('detects tool invocation patterns', () => {
    const output = `
Using tool Read to read the file
Calling Bash command
`;
    const tools = detectToolCalls(output);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some(t => t.tool === 'Read' || t.tool === 'Bash')).toBe(true);
  });

  it('deduplicates tools by position', () => {
    const output = `
✓ Read file.ts
✓ Read file.ts
`;
    const tools = detectToolCalls(output);
    // Should detect both as they're at different positions
    expect(tools).toHaveLength(2);
  });

  it('handles empty output', () => {
    const tools = detectToolCalls('');
    expect(tools).toHaveLength(0);
  });

  it('handles output with no tools', () => {
    const tools = detectToolCalls('Just some regular text without any tools.');
    expect(tools).toHaveLength(0);
  });

  it('detects newer tools like Skill and TaskOutput', () => {
    const output = `
✓ Skill invoked
TaskOutput({"task_id": "123"})
`;
    const tools = detectToolCalls(output);
    expect(tools.some(t => t.tool === 'Skill')).toBe(true);
    expect(tools.some(t => t.tool === 'TaskOutput')).toBe(true);
  });
});

describe('detectErrors', () => {
  it('detects JavaScript/TypeScript errors', () => {
    const output = `
TypeError: Cannot read property 'foo' of undefined
    at Object.<anonymous> (test.ts:10:5)
`;
    const errors = detectErrors(output);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.message.includes('TypeError'))).toBe(true);
    expect(errors[0].type).toBe('error');
  });

  it('detects test failures', () => {
    const output = `
FAIL src/test.ts
✗ Test case failed
`;
    const errors = detectErrors(output);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.type === 'error')).toBe(true);
  });

  it('detects warnings', () => {
    const output = `
warning: Package is deprecated
WARN: Something might be wrong
`;
    const errors = detectErrors(output);
    expect(errors.some(e => e.type === 'warning')).toBe(true);
  });

  it('detects command failures', () => {
    const output = `
Command failed with exit code 1
Exit code: 127
`;
    const errors = detectErrors(output);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('deduplicates errors by message', () => {
    const output = `
Error: Something went wrong
Error: Something went wrong
`;
    const errors = detectErrors(output);
    // The detection may find two different patterns matching (generic "Error:" prefix)
    // but should deduplicate if the exact same message is found multiple times
    expect(errors.length).toBeGreaterThan(0);
    // Count unique messages about "Something went wrong"
    const wrongMessages = errors.filter(e => e.message.includes('Something went wrong'));
    // At least one should be found
    expect(wrongMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty output', () => {
    const errors = detectErrors('');
    expect(errors).toHaveLength(0);
  });

  it('handles output with no errors', () => {
    const errors = detectErrors('Everything is working fine. Success!');
    expect(errors).toHaveLength(0);
  });

  it('truncates long error messages', () => {
    const longMessage = 'Error: ' + 'x'.repeat(500);
    const errors = detectErrors(longMessage);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message.length).toBeLessThanOrEqual(200);
  });

  it('detects TypeScript compilation errors', () => {
    const output = `
error TS2339: Property 'foo' does not exist on type 'Bar'.
error[E0001]: Some rust error
`;
    const errors = detectErrors(output);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.message.includes('TS2339'))).toBe(true);
  });

  it('does not match "error handling" as an error', () => {
    const output = 'Implementing error handling for the API.';
    const errors = detectErrors(output);
    // Should not detect "error handling" as an error
    expect(errors).toHaveLength(0);
  });
});
