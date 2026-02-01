/**
 * Sandbox Module Tests
 *
 * Tests for cross-platform file permission sandboxing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applySandbox,
  detectCapabilities,
  resolvePreset,
  mergePermissions,
  cleanupSandboxProfile,
  FILE_PERMISSION_PRESETS,
  type SandboxResult,
} from './sandbox.js';
import type { FilePermissions } from './types.js';

describe('sandbox', () => {
  const testProjectRoot = '/tmp/test-project';

  describe('detectCapabilities', () => {
    it('returns platform information', () => {
      const caps = detectCapabilities();
      expect(caps.platform).toBe(os.platform());
      expect(caps).toHaveProperty('available');
      expect(caps).toHaveProperty('methods');
      expect(Array.isArray(caps.methods)).toBe(true);
    });

    it('caches capabilities', () => {
      const caps1 = detectCapabilities();
      const caps2 = detectCapabilities();
      expect(caps1).toBe(caps2); // Same reference
    });
  });

  describe('resolvePreset', () => {
    it('resolves block-secrets preset', () => {
      const preset = resolvePreset('block-secrets');
      expect(preset.disallowed).toBeDefined();
      expect(preset.disallowed).toContain('.env');
      expect(preset.disallowed).toContain('*.pem');
    });

    it('resolves source-only preset', () => {
      const preset = resolvePreset('source-only');
      expect(preset.allowed).toBeDefined();
      expect(preset.allowed).toContain('src/**');
      expect(preset.readOnly).toContain('package.json');
    });

    it('resolves read-only preset', () => {
      const preset = resolvePreset('read-only');
      expect(preset.writable).toEqual([]);
    });

    it('resolves docs-only preset', () => {
      const preset = resolvePreset('docs-only');
      expect(preset.allowed).toContain('docs/**');
      expect(preset.readOnly).toContain('src/**');
    });
  });

  describe('mergePermissions', () => {
    it('returns undefined when both inputs are undefined', () => {
      const result = mergePermissions(undefined, undefined);
      expect(result).toBeUndefined();
    });

    it('returns preset when explicit is undefined', () => {
      const result = mergePermissions('block-secrets', undefined);
      expect(result).toEqual(FILE_PERMISSION_PRESETS['block-secrets']);
    });

    it('returns explicit when preset is undefined', () => {
      const explicit: FilePermissions = { allowed: ['src/**'] };
      const result = mergePermissions(undefined, explicit);
      // mergePermissions adds empty arrays for arrays fields
      expect(result?.allowed).toEqual(['src/**']);
    });

    it('merges preset and explicit permissions', () => {
      const explicit: FilePermissions = {
        allowed: ['custom/**'],
        disallowed: ['extra-secret/**'],
      };
      const result = mergePermissions('block-secrets', explicit);

      expect(result?.allowed).toEqual(['custom/**']);
      // Should include both preset disallowed and explicit disallowed
      expect(result?.disallowed).toContain('.env');
      expect(result?.disallowed).toContain('extra-secret/**');
    });

    it('explicit allowed overrides preset allowed', () => {
      const explicit: FilePermissions = { allowed: ['only-this/**'] };
      const result = mergePermissions('source-only', explicit);
      expect(result?.allowed).toEqual(['only-this/**']);
    });
  });

  describe('applySandbox', () => {
    const testCommand = 'claude';
    const testArgs = ['--dangerously-skip-permissions'];
    const testPermissions: FilePermissions = {
      disallowed: ['.env', 'secrets/**'],
      allowed: ['src/**'],
    };

    it('returns original command when no sandbox available', () => {
      // Force detection of no capabilities (this tests the fallback path)
      const caps = detectCapabilities();

      // If no sandbox methods are available, command should be unchanged
      if (!caps.available) {
        const result = applySandbox(testCommand, testArgs, testPermissions, testProjectRoot);
        expect(result.command).toBe(testCommand);
        expect(result.args).toEqual(testArgs);
        expect(result.sandboxed).toBe(false);
        expect(result.method).toBe('none');
      }
    });

    it('includes profilePath for cleanup when sandboxed', () => {
      const caps = detectCapabilities();

      if (caps.methods.includes('sandbox-exec')) {
        const result = applySandbox(testCommand, testArgs, testPermissions, testProjectRoot);

        if (result.sandboxed) {
          expect(result.method).toBe('sandbox-exec');
          expect(result.profilePath).toBeDefined();
          expect(fs.existsSync(result.profilePath!)).toBe(true);

          // Cleanup
          cleanupSandboxProfile(result);
          expect(fs.existsSync(result.profilePath!)).toBe(false);
        }
      }
    });

    it('wraps command with bwrap on Linux', () => {
      const caps = detectCapabilities();

      if (caps.methods.includes('bwrap')) {
        const result = applySandbox(testCommand, testArgs, testPermissions, testProjectRoot);

        expect(result.sandboxed).toBe(true);
        expect(result.method).toBe('bwrap');
        expect(result.command).toBe('bwrap');
        expect(result.args).toContain('--die-with-parent');
        expect(result.args).toContain('--');
        expect(result.args).toContain(testCommand);
      }
    });
  });

  describe('cleanupSandboxProfile', () => {
    it('cleans up profile file', () => {
      const tempFile = path.join(os.tmpdir(), `test-sandbox-${Date.now()}.sb`);
      fs.writeFileSync(tempFile, '(version 1)');

      const result: SandboxResult = {
        command: 'sandbox-exec',
        args: ['-f', tempFile, 'test'],
        sandboxed: true,
        method: 'sandbox-exec',
        profilePath: tempFile,
      };

      expect(fs.existsSync(tempFile)).toBe(true);
      cleanupSandboxProfile(result);
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    it('handles missing profile gracefully', () => {
      const result: SandboxResult = {
        command: 'test',
        args: [],
        sandboxed: false,
        method: 'none',
        profilePath: '/nonexistent/path.sb',
      };

      // Should not throw
      expect(() => cleanupSandboxProfile(result)).not.toThrow();
    });

    it('handles undefined profilePath', () => {
      const result: SandboxResult = {
        command: 'test',
        args: [],
        sandboxed: false,
        method: 'none',
      };

      // Should not throw
      expect(() => cleanupSandboxProfile(result)).not.toThrow();
    });
  });

  describe('FILE_PERMISSION_PRESETS', () => {
    it('has all expected presets', () => {
      expect(FILE_PERMISSION_PRESETS).toHaveProperty('block-secrets');
      expect(FILE_PERMISSION_PRESETS).toHaveProperty('source-only');
      expect(FILE_PERMISSION_PRESETS).toHaveProperty('read-only');
      expect(FILE_PERMISSION_PRESETS).toHaveProperty('docs-only');
    });

    it('block-secrets includes common sensitive files', () => {
      const preset = FILE_PERMISSION_PRESETS['block-secrets'];
      expect(preset.disallowed).toContain('.env');
      expect(preset.disallowed).toContain('*.pem');
      expect(preset.disallowed).toContain('*.key');
      expect(preset.disallowed).toContain('secrets/**');
    });

    it('source-only limits access to code directories', () => {
      const preset = FILE_PERMISSION_PRESETS['source-only'];
      expect(preset.allowed).toContain('src/**');
      expect(preset.allowed).toContain('tests/**');
      expect(preset.readOnly).toContain('package.json');
    });
  });
});
