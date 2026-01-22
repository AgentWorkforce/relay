/**
 * Tmux Resolver Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTmuxPath,
  resolveTmux,
  isTmuxAvailable,
  checkTmuxVersion,
  getPlatformIdentifier,
  TmuxNotFoundError,
  getBundledTmuxDir,
  getBundledTmuxPath,
  MIN_TMUX_VERSION,
} from './tmux-resolver.js';

describe('tmux-resolver', () => {
  describe('constants', () => {
    it('should export MIN_TMUX_VERSION', () => {
      expect(MIN_TMUX_VERSION).toBe('3.0');
    });

    it('should export bundled path functions', () => {
      expect(typeof getBundledTmuxDir).toBe('function');
      expect(typeof getBundledTmuxPath).toBe('function');
    });
  });

  describe('getPlatformIdentifier', () => {
    it('should return platform identifier for supported platforms', () => {
      const identifier = getPlatformIdentifier();
      // Should be one of the supported platforms or null
      if (identifier !== null) {
        expect([
          'macos-arm64',
          'macos-x86_64',
          'linux-arm64',
          'linux-x86_64',
        ]).toContain(identifier);
      }
    });
  });

  describe('TmuxNotFoundError', () => {
    it('should be an Error instance', () => {
      const error = new TmuxNotFoundError();
      expect(error).toBeInstanceOf(Error);
    });

    it('should have name TmuxNotFoundError', () => {
      const error = new TmuxNotFoundError();
      expect(error.name).toBe('TmuxNotFoundError');
    });

    it('should include installation instructions', () => {
      const error = new TmuxNotFoundError();
      expect(error.message).toContain('tmux is required');
    });
  });

  describe('resolveTmux', () => {
    it('should return TmuxInfo or null', () => {
      const result = resolveTmux();
      if (result !== null) {
        expect(result).toHaveProperty('path');
        expect(result).toHaveProperty('version');
        expect(result).toHaveProperty('isBundled');
        expect(typeof result.path).toBe('string');
        expect(typeof result.version).toBe('string');
        expect(typeof result.isBundled).toBe('boolean');
      }
    });
  });

  describe('isTmuxAvailable', () => {
    it('should return boolean', () => {
      expect(typeof isTmuxAvailable()).toBe('boolean');
    });
  });

  describe('checkTmuxVersion', () => {
    it('should return version check result', () => {
      const result = checkTmuxVersion();
      expect(result).toHaveProperty('ok');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('minimum');
      expect(typeof result.ok).toBe('boolean');
      expect(result.minimum).toBe(MIN_TMUX_VERSION);
    });
  });

  describe('getTmuxPath', () => {
    it('should return path string or throw TmuxNotFoundError', () => {
      try {
        const path = getTmuxPath();
        expect(typeof path).toBe('string');
        expect(path.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(TmuxNotFoundError);
      }
    });
  });
});
