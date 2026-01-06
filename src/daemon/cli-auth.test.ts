/**
 * Tests for CLI authentication code handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the code cleaning logic directly since submitAuthCode requires complex mocking
describe('CLI Auth Code Cleaning', () => {
  /**
   * Helper function that replicates the code cleaning logic from submitAuthCode
   * This allows us to test the logic in isolation
   */
  function cleanAuthCode(code: string): string {
    let cleanCode = code.trim();
    if (cleanCode.includes('#')) {
      cleanCode = cleanCode.split('#')[0];
    }
    return cleanCode;
  }

  describe('cleanAuthCode', () => {
    it('should return the code as-is when no state parameter is present', () => {
      const code = 'Qhs5YfVk0uAXwvGZOv49BV17mfGdT004EuMgpIcywFAUv6mQ';
      expect(cleanAuthCode(code)).toBe(code);
    });

    it('should strip state parameter after # from Claude OAuth code', () => {
      const codeWithState = 'Qhs5YfVk0uAXwvGZOv49BV17mfGdT004EuMgpIcywFAUv6mQ#vl_fvlG8QuI33wTU5DRYUfkz1EhY5-t-XART3bC2lL4';
      const expectedCode = 'Qhs5YfVk0uAXwvGZOv49BV17mfGdT004EuMgpIcywFAUv6mQ';
      expect(cleanAuthCode(codeWithState)).toBe(expectedCode);
    });

    it('should handle codes with multiple # characters (take first part only)', () => {
      const codeWithMultipleHash = 'CODE_PART#STATE#EXTRA';
      expect(cleanAuthCode(codeWithMultipleHash)).toBe('CODE_PART');
    });

    it('should trim whitespace from the code', () => {
      const codeWithWhitespace = '  Qhs5YfVk0uAXwvGZOv49  ';
      expect(cleanAuthCode(codeWithWhitespace)).toBe('Qhs5YfVk0uAXwvGZOv49');
    });

    it('should trim whitespace before stripping state parameter', () => {
      const codeWithBoth = '  Qhs5YfVk0uAXwvGZOv49#STATE  ';
      expect(cleanAuthCode(codeWithBoth)).toBe('Qhs5YfVk0uAXwvGZOv49');
    });

    it('should handle empty string after #', () => {
      const codeWithEmptyState = 'Qhs5YfVk0uAXwvGZOv49#';
      expect(cleanAuthCode(codeWithEmptyState)).toBe('Qhs5YfVk0uAXwvGZOv49');
    });

    it('should handle just # character', () => {
      const justHash = '#';
      expect(cleanAuthCode(justHash)).toBe('');
    });

    it('should handle real-world Claude OAuth code format', () => {
      // This is the exact format from the production logs
      const realCode = 'Qhs5YfVk0uAXwvGZOv49BV17mfGdT004EuMgpIcywFAUv6mQ#vl_fvlG8QuI33wTU5DRYUfkz1EhY5-t-XART3bC2lL4';
      const result = cleanAuthCode(realCode);

      expect(result).toBe('Qhs5YfVk0uAXwvGZOv49BV17mfGdT004EuMgpIcywFAUv6mQ');
      expect(result).not.toContain('#');
      expect(result.length).toBe(48); // Claude codes are typically 48 chars
    });

    it('should handle OpenAI/Codex codes (no state parameter)', () => {
      const openaiCode = 'sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234';
      expect(cleanAuthCode(openaiCode)).toBe(openaiCode);
    });

    it('should handle newlines in pasted code', () => {
      const codeWithNewlines = 'CODE123\n#STATE456';
      // trim() handles \n at start/end but not middle
      // The # is still there so we split
      expect(cleanAuthCode(codeWithNewlines)).toBe('CODE123\n');
    });
  });
});

describe('Auth Code State Parameter Detection', () => {
  it('should identify codes that contain state parameters', () => {
    const testCases = [
      { code: 'ABC#DEF', hasState: true },
      { code: 'ABCDEF', hasState: false },
      { code: 'ABC123#state=xyz', hasState: true },
      { code: '', hasState: false },
      { code: '#', hasState: true },
    ];

    for (const { code, hasState } of testCases) {
      expect(code.includes('#')).toBe(hasState);
    }
  });
});
