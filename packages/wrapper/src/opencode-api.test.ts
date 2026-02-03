/**
 * Tests for OpenCode HTTP API client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeApi } from './opencode-api.js';

describe('OpenCodeApi', () => {
  let originalFetch: typeof fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default config values', () => {
      const api = new OpenCodeApi();
      // Access private properties for testing
      expect((api as any).baseUrl).toBe('http://localhost:4096');
      expect((api as any).timeout).toBe(5000);
    });

    it('should accept custom config', () => {
      const api = new OpenCodeApi({
        baseUrl: 'http://localhost:8080',
        password: 'test-password',
        timeout: 10000,
      });
      expect((api as any).baseUrl).toBe('http://localhost:8080');
      expect((api as any).password).toBe('test-password');
      expect((api as any).timeout).toBe(10000);
    });
  });

  describe('getHeaders', () => {
    it('should return content-type without auth when no password', () => {
      const api = new OpenCodeApi();
      const headers = (api as any).getHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should include basic auth when password is set', () => {
      const api = new OpenCodeApi({ password: 'secret' });
      const headers = (api as any).getHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Basic ' + Buffer.from('opencode:secret').toString('base64'));
    });
  });

  describe('isAvailable', () => {
    it('should return true when server responds', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.isAvailable();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/config',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return false when server unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const api = new OpenCodeApi();
      const result = await api.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('appendPrompt', () => {
    it('should send text to append-prompt endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.appendPrompt('Hello, world!');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/append-prompt',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Hello, world!' }),
        })
      );
    });

    it('should handle errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const api = new OpenCodeApi();
      const result = await api.appendPrompt('test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });

  describe('submitPrompt', () => {
    it('should call submit-prompt endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.submitPrompt();

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/submit-prompt',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('clearPrompt', () => {
    it('should call clear-prompt endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.clearPrompt();

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/clear-prompt',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('showToast', () => {
    it('should send toast with default variant and duration', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.showToast('Test message');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/show-toast',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'Test message', variant: 'info', duration: 3000 }),
        })
      );
    });

    it('should send toast with custom variant and duration', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.showToast('Error!', { variant: 'error', duration: 5000 });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/show-toast',
        expect.objectContaining({
          body: JSON.stringify({ message: 'Error!', variant: 'error', duration: 5000 }),
        })
      );
    });
  });

  describe('executeCommand', () => {
    it('should send command to execute-command endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.executeCommand('session_new');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/execute-command',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: 'session_new' }),
        })
      );
    });
  });

  describe('listSessions', () => {
    it('should return sessions from API', async () => {
      const mockSessions = [
        { id: '1', title: 'Session 1', createdAt: '2024-01-01', updatedAt: '2024-01-02' },
        { id: '2', title: 'Session 2', createdAt: '2024-01-03', updatedAt: '2024-01-04' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSessions),
      });

      const api = new OpenCodeApi();
      const result = await api.listSessions();

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockSessions);
    });
  });

  describe('getCurrentSession', () => {
    it('should return current session', async () => {
      const mockSession = { id: 'current', title: 'Current Session' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSession),
      });

      const api = new OpenCodeApi();
      const result = await api.getCurrentSession();

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockSession);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/session/current',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('selectSession', () => {
    it('should select session by id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const api = new OpenCodeApi();
      const result = await api.selectSession('session-123');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4096/tui/select-session',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionID: 'session-123' }),
        })
      );
    });
  });

  describe('request timeout', () => {
    it('should handle timeout errors', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const api = new OpenCodeApi({ timeout: 100 });
      const result = await api.appendPrompt('test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Request timeout');
    });
  });
});
