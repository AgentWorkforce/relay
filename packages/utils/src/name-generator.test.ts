import { describe, it, expect } from 'vitest';
import { generateAgentName, generateUniqueAgentName, isValidAgentName } from './name-generator.js';

describe('generateAgentName', () => {
  it('returns a non-empty string', () => {
    const name = generateAgentName();
    expect(name).toBeTruthy();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('returns AdjectiveNoun format with capital letters and no spaces', () => {
    const name = generateAgentName();
    // Should start with an uppercase letter
    expect(name[0]).toMatch(/[A-Z]/);
    // Should not contain spaces
    expect(name).not.toContain(' ');
    // Should contain at least one more uppercase letter (the noun's first letter)
    expect(name.slice(1)).toMatch(/[A-Z]/);
  });

  it('generates different names on multiple calls', () => {
    const names = new Set<string>();
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      names.add(generateAgentName());
    }

    // With 64 adjectives and 64 nouns (4096 combinations),
    // we should get at least some variety in 50 calls
    expect(names.size).toBeGreaterThan(1);
  });

  it('generates names that match the validation pattern', () => {
    const iterations = 20;

    for (let i = 0; i < iterations; i++) {
      const name = generateAgentName();
      expect(isValidAgentName(name)).toBe(true);
    }
  });

  it('generates names within valid length constraints', () => {
    const iterations = 20;

    for (let i = 0; i < iterations; i++) {
      const name = generateAgentName();
      expect(name.length).toBeGreaterThanOrEqual(2);
      expect(name.length).toBeLessThanOrEqual(32);
    }
  });
});

describe('generateUniqueAgentName', () => {
  it('returns a name not in the existing set', () => {
    const existingNames = new Set(['BlueFox', 'RedWolf', 'GreenEagle']);
    const name = generateUniqueAgentName(existingNames);

    expect(existingNames.has(name)).toBe(false);
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('handles an empty existing set', () => {
    const existingNames = new Set<string>();
    const name = generateUniqueAgentName(existingNames);

    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
    expect(isValidAgentName(name)).toBe(true);
  });

  it('falls back to suffix after maxAttempts', () => {
    // Create a set with all possible combinations minus one
    // We'll use a small maxAttempts to force the fallback
    const existingNames = new Set<string>();

    // Add a bunch of names to increase collision likelihood
    for (let i = 0; i < 100; i++) {
      existingNames.add(generateAgentName());
    }

    // Force fallback by setting maxAttempts to 0
    const name = generateUniqueAgentName(existingNames, 0);

    // Should have a numeric suffix
    expect(name).toMatch(/\d+$/);
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('works with a large existing set', () => {
    const existingNames = new Set<string>();

    // Add 500 names to the set
    for (let i = 0; i < 500; i++) {
      existingNames.add(`Agent${i}`);
    }

    const name = generateUniqueAgentName(existingNames);

    expect(existingNames.has(name)).toBe(false);
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('generates multiple unique names successfully', () => {
    const existingNames = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const name = generateUniqueAgentName(existingNames);
      expect(existingNames.has(name)).toBe(false);
      existingNames.add(name);
    }

    // Should have 10 unique names
    expect(existingNames.size).toBe(10);
  });

  it('respects custom maxAttempts parameter', () => {
    const existingNames = new Set<string>();

    // Add many names to make collisions likely
    for (let i = 0; i < 200; i++) {
      existingNames.add(generateAgentName());
    }

    // Should still work with custom maxAttempts
    const name = generateUniqueAgentName(existingNames, 50);

    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});

describe('isValidAgentName', () => {
  describe('valid names', () => {
    it('accepts "BlueFox"', () => {
      expect(isValidAgentName('BlueFox')).toBe(true);
    });

    it('accepts "A1"', () => {
      expect(isValidAgentName('A1')).toBe(true);
    });

    it('accepts "Agent_1"', () => {
      expect(isValidAgentName('Agent_1')).toBe(true);
    });

    it('accepts "test-agent"', () => {
      expect(isValidAgentName('test-agent')).toBe(true);
    });

    it('accepts names with mixed case', () => {
      expect(isValidAgentName('CamelCase')).toBe(true);
      expect(isValidAgentName('lowercase')).toBe(true);
      expect(isValidAgentName('UPPERCASE')).toBe(true);
    });

    it('accepts names with underscores', () => {
      expect(isValidAgentName('my_agent')).toBe(true);
      expect(isValidAgentName('agent_with_underscores')).toBe(true);
    });

    it('accepts names with hyphens', () => {
      expect(isValidAgentName('my-agent')).toBe(true);
      expect(isValidAgentName('agent-with-hyphens')).toBe(true);
    });

    it('accepts names at exactly 32 characters', () => {
      const name = 'a' + '1'.repeat(31); // 32 chars total
      expect(name.length).toBe(32);
      expect(isValidAgentName(name)).toBe(true);
    });
  });

  describe('invalid names', () => {
    it('rejects empty string', () => {
      expect(isValidAgentName('')).toBe(false);
    });

    it('rejects single character', () => {
      expect(isValidAgentName('a')).toBe(false);
    });

    it('rejects name starting with number', () => {
      expect(isValidAgentName('123')).toBe(false);
      expect(isValidAgentName('1agent')).toBe(false);
    });

    it('rejects names over 32 characters', () => {
      const name = 'a' + '1'.repeat(32); // 33 chars total
      expect(name.length).toBe(33);
      expect(isValidAgentName(name)).toBe(false);
    });

    it('rejects names with spaces', () => {
      expect(isValidAgentName('Blue Fox')).toBe(false);
      expect(isValidAgentName('my agent')).toBe(false);
    });

    it('rejects names with special characters', () => {
      expect(isValidAgentName('agent!')).toBe(false);
      expect(isValidAgentName('agent@home')).toBe(false);
      expect(isValidAgentName('agent#1')).toBe(false);
      expect(isValidAgentName('agent$')).toBe(false);
      expect(isValidAgentName('agent%')).toBe(false);
      expect(isValidAgentName('agent^')).toBe(false);
      expect(isValidAgentName('agent&')).toBe(false);
      expect(isValidAgentName('agent*')).toBe(false);
      expect(isValidAgentName('agent(')).toBe(false);
      expect(isValidAgentName('agent)')).toBe(false);
    });

    it('rejects names starting with underscore', () => {
      expect(isValidAgentName('_agent')).toBe(false);
    });

    it('rejects names starting with hyphen', () => {
      expect(isValidAgentName('-agent')).toBe(false);
    });

    it('rejects names with dots', () => {
      expect(isValidAgentName('agent.1')).toBe(false);
      expect(isValidAgentName('my.agent')).toBe(false);
    });

    it('rejects names with slashes', () => {
      expect(isValidAgentName('agent/1')).toBe(false);
      expect(isValidAgentName('agent\\1')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles names at boundary lengths correctly', () => {
      // Minimum valid length (2 chars)
      expect(isValidAgentName('ab')).toBe(true);

      // Maximum valid length (32 chars)
      const maxValid = 'a' + 'b'.repeat(31);
      expect(maxValid.length).toBe(32);
      expect(isValidAgentName(maxValid)).toBe(true);

      // One character too long (33 chars)
      const tooLong = maxValid + 'c';
      expect(tooLong.length).toBe(33);
      expect(isValidAgentName(tooLong)).toBe(false);
    });

    it('validates all generated names', () => {
      // Run a batch test to ensure generated names always pass validation
      for (let i = 0; i < 50; i++) {
        const name = generateAgentName();
        expect(isValidAgentName(name)).toBe(true);
      }
    });
  });
});
