import { describe, it, expect } from 'vitest';
import { getCredentialPath, getConfigPaths } from '../src/utils/credential-check.js';

describe('credential-check', () => {
  describe('getCredentialPath', () => {
    it('returns correct path for claude', () => {
      const path = getCredentialPath('claude');
      expect(path).toContain('.claude');
      expect(path).toContain('.credentials.json');
    });

    it('returns correct path for codex', () => {
      const path = getCredentialPath('codex');
      expect(path).toContain('.codex');
      expect(path).toContain('auth.json');
    });

    it('returns correct path for gemini', () => {
      const path = getCredentialPath('gemini');
      expect(path).toContain('gcloud');
      expect(path).toContain('application_default_credentials.json');
    });

    it('returns correct path for cursor', () => {
      const path = getCredentialPath('cursor');
      expect(path).toContain('.cursor');
      expect(path).toContain('auth.json');
    });

    it('returns correct path for opencode', () => {
      const path = getCredentialPath('opencode');
      expect(path).toContain('opencode');
      expect(path).toContain('auth.json');
    });

    it('throws for unknown CLI', () => {
      expect(() => getCredentialPath('unknown' as any)).toThrow('Unknown CLI type');
    });
  });

  describe('getConfigPaths', () => {
    it('returns multiple paths for claude', () => {
      const paths = getConfigPaths('claude');
      expect(paths.length).toBeGreaterThan(1);
      expect(paths.some((p) => p.includes('.credentials.json'))).toBe(true);
      expect(paths.some((p) => p.includes('settings.json'))).toBe(true);
    });

    it('returns multiple paths for codex', () => {
      const paths = getConfigPaths('codex');
      expect(paths.length).toBeGreaterThan(1);
      expect(paths.some((p) => p.includes('auth.json'))).toBe(true);
      expect(paths.some((p) => p.includes('config.json'))).toBe(true);
    });
  });
});
