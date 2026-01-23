import { describe, it, expect } from 'vitest';
import { mapModelToCli, getBaseCli } from './model-mapping.js';

describe('mapModelToCli', () => {
  describe('Claude models', () => {
    it('maps claude-sonnet-4 to claude:sonnet', () => {
      expect(mapModelToCli('claude-sonnet-4')).toBe('claude:sonnet');
    });

    it('maps claude-opus-4 to claude:opus', () => {
      expect(mapModelToCli('claude-opus-4')).toBe('claude:opus');
    });

    it('maps claude-opus-4.5 to claude:opus', () => {
      expect(mapModelToCli('claude-opus-4.5')).toBe('claude:opus');
    });

    it('maps sonnet to claude:sonnet', () => {
      expect(mapModelToCli('sonnet')).toBe('claude:sonnet');
    });

    it('maps opus to claude:opus', () => {
      expect(mapModelToCli('opus')).toBe('claude:opus');
    });

    it('maps haiku to claude:haiku', () => {
      expect(mapModelToCli('haiku')).toBe('claude:haiku');
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase input', () => {
      expect(mapModelToCli('OPUS')).toBe('claude:opus');
    });

    it('handles mixed case input', () => {
      expect(mapModelToCli('Sonnet')).toBe('claude:sonnet');
    });

    it('handles CLAUDE-OPUS-4 uppercase', () => {
      expect(mapModelToCli('CLAUDE-OPUS-4')).toBe('claude:opus');
    });
  });

  describe('whitespace handling', () => {
    it('trims leading whitespace', () => {
      expect(mapModelToCli('  opus')).toBe('claude:opus');
    });

    it('trims trailing whitespace', () => {
      expect(mapModelToCli('opus  ')).toBe('claude:opus');
    });

    it('trims both leading and trailing whitespace', () => {
      expect(mapModelToCli('  sonnet  ')).toBe('claude:sonnet');
    });
  });

  describe('Codex/OpenAI models', () => {
    it('maps codex to codex', () => {
      expect(mapModelToCli('codex')).toBe('codex');
    });

    it('maps gpt-4o to codex', () => {
      expect(mapModelToCli('gpt-4o')).toBe('codex');
    });
  });

  describe('Gemini models', () => {
    it('maps gemini to gemini', () => {
      expect(mapModelToCli('gemini')).toBe('gemini');
    });

    it('maps gemini-2.0-flash to gemini', () => {
      expect(mapModelToCli('gemini-2.0-flash')).toBe('gemini');
    });
  });

  describe('default behavior', () => {
    it('returns claude:sonnet for undefined', () => {
      expect(mapModelToCli(undefined)).toBe('claude:sonnet');
    });

    it('returns claude:sonnet for empty string', () => {
      expect(mapModelToCli('')).toBe('claude:sonnet');
    });

    it('returns claude:sonnet for unknown model', () => {
      expect(mapModelToCli('unknown-model-xyz')).toBe('claude:sonnet');
    });

    it('returns claude:sonnet for whitespace-only string', () => {
      expect(mapModelToCli('   ')).toBe('claude:sonnet');
    });
  });
});

describe('getBaseCli', () => {
  it('extracts base CLI from variant with colon', () => {
    expect(getBaseCli('claude:opus')).toBe('claude');
  });

  it('extracts base CLI from sonnet variant', () => {
    expect(getBaseCli('claude:sonnet')).toBe('claude');
  });

  it('extracts base CLI from haiku variant', () => {
    expect(getBaseCli('claude:haiku')).toBe('claude');
  });

  it('returns CLI as-is when no colon present', () => {
    expect(getBaseCli('codex')).toBe('codex');
  });

  it('returns CLI as-is for gemini', () => {
    expect(getBaseCli('gemini')).toBe('gemini');
  });

  it('handles multiple colons by splitting on first', () => {
    expect(getBaseCli('claude:opus:extra')).toBe('claude');
  });
});
