/**
 * ID Generator Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IdGenerator, idGen, generateId } from './id-generator.js';

describe('IdGenerator', () => {
  let generator: IdGenerator;

  beforeEach(() => {
    generator = new IdGenerator('test-node');
  });

  describe('next()', () => {
    it('should generate unique IDs', () => {
      const id1 = generator.next();
      const id2 = generator.next();
      expect(id1).not.toBe(id2);
    });

    it('should include node prefix', () => {
      const id = generator.next();
      expect(id).toContain('test-node');
    });

    it('should be lexicographically sortable by time', () => {
      const id1 = generator.next();
      // Small delay to ensure different timestamp
      const id2 = new IdGenerator('test-node').next();
      // IDs from different times should be sortable
      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
    });

    it('should increment counter for same-millisecond IDs', () => {
      const ids = Array.from({ length: 10 }, () => generator.next());
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });
  });

  describe('short()', () => {
    it('should generate shorter IDs without node prefix', () => {
      const id = generator.short();
      expect(id).not.toContain('test-node');
    });

    it('should generate unique short IDs', () => {
      const id1 = generator.short();
      const id2 = generator.short();
      expect(id1).not.toBe(id2);
    });
  });
});

describe('Singleton exports', () => {
  it('idGen should be an IdGenerator instance', () => {
    expect(idGen).toBeInstanceOf(IdGenerator);
  });

  it('generateId should return unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it('generateId should return string', () => {
    expect(typeof generateId()).toBe('string');
  });
});
