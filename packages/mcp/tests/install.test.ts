import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  detectInstalledEditors,
  getEditorConfig,
  listSupportedEditors,
  getDefaultServerConfig,
} from '../src/install.js';
import { validateEditor, getValidEditors } from '../src/install-cli.js';

// Mock the fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('Install System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listSupportedEditors', () => {
    it('returns list of supported editors', () => {
      const editors = listSupportedEditors();

      expect(editors).toBeInstanceOf(Array);
      expect(editors.length).toBeGreaterThan(0);

      // Should include common editors
      const keys = editors.map((e) => e.key);
      expect(keys).toContain('claude');
      expect(keys).toContain('cursor');
      expect(keys).toContain('vscode');
    });

    it('each editor has key and name', () => {
      const editors = listSupportedEditors();

      for (const editor of editors) {
        expect(editor).toHaveProperty('key');
        expect(editor).toHaveProperty('name');
        expect(typeof editor.key).toBe('string');
        expect(typeof editor.name).toBe('string');
      }
    });
  });

  describe('getEditorConfig', () => {
    it('returns config for valid editor', () => {
      const config = getEditorConfig('claude');

      expect(config).toBeDefined();
      expect(config?.name).toBe('Claude Desktop');
      expect(config?.configKey).toBe('mcpServers');
      expect(config?.format).toBe('json');
    });

    it('returns undefined for unknown editor', () => {
      const config = getEditorConfig('unknown-editor');
      expect(config).toBeUndefined();
    });
  });

  describe('detectInstalledEditors', () => {
    it('returns empty array when no editors detected', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const detected = detectInstalledEditors();

      expect(detected).toEqual([]);
    });

    it('detects editors by config directory existence', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        // Simulate Claude config dir existing
        return p.includes('.claude') || p.includes('Claude');
      });

      const detected = detectInstalledEditors();

      // Should detect at least one claude variant
      expect(detected.some((e) => e.includes('claude'))).toBe(true);
    });
  });

  describe('getDefaultServerConfig', () => {
    it('returns npx command config', () => {
      const config = getDefaultServerConfig();

      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['@agent-relay/mcp', 'serve']);
    });
  });
});

describe('Install CLI Helpers', () => {
  describe('validateEditor', () => {
    it('returns true for valid editor', () => {
      expect(validateEditor('claude')).toBe(true);
      expect(validateEditor('cursor')).toBe(true);
      expect(validateEditor('vscode')).toBe(true);
    });

    it('returns false for invalid editor', () => {
      expect(validateEditor('unknown')).toBe(false);
      expect(validateEditor('')).toBe(false);
    });
  });

  describe('getValidEditors', () => {
    it('returns array of editor keys', () => {
      const editors = getValidEditors();

      expect(editors).toBeInstanceOf(Array);
      expect(editors.length).toBeGreaterThan(0);
      expect(editors).toContain('claude');
      expect(editors).toContain('cursor');
    });
  });
});
