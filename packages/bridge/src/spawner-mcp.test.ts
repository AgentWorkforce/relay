/**
 * Unit tests for MCP socket detection in AgentSpawner
 *
 * Tests verify that MCP tools reference is only included when BOTH conditions are met:
 * 1. .mcp.json config exists in project root
 * 2. Relay daemon socket is accessible (daemon must be running)
 *
 * This ensures agents don't see MCP context when the tools wouldn't actually work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock fs module
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      statSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(),
    },
    existsSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

/**
 * This is a standalone test of the MCP detection logic extracted from spawner.ts
 * The actual implementation lives in spawner.ts lines 698-714.
 *
 * Logic being tested:
 * ```
 * const mcpConfigPath = path.join(this.projectRoot, '.mcp.json');
 * const relaySocket = process.env.RELAY_SOCKET || '/tmp/agent-relay.sock';
 * let hasMcp = false;
 * if (fs.existsSync(mcpConfigPath)) {
 *   try {
 *     hasMcp = fs.statSync(relaySocket).isSocket();
 *   } catch {
 *     hasMcp = false;
 *   }
 * }
 * ```
 */
function checkMcpAvailability(projectRoot: string): boolean {
  const mcpConfigPath = path.join(projectRoot, '.mcp.json');
  const relaySocket = process.env.RELAY_SOCKET || '/tmp/agent-relay.sock';
  let hasMcp = false;

  if (fs.existsSync(mcpConfigPath)) {
    try {
      hasMcp = fs.statSync(relaySocket).isSocket();
    } catch {
      // Socket doesn't exist or isn't accessible - daemon not running
      hasMcp = false;
    }
  }

  return hasMcp;
}

describe('MCP Socket Detection', () => {
  const mockProjectRoot = '/test/project';
  const mockMcpConfigPath = '/test/project/.mcp.json';
  const defaultSocket = '/tmp/agent-relay.sock';
  const customSocket = '/custom/path/relay.sock';

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up environment
    delete process.env.RELAY_SOCKET;
  });

  afterEach(() => {
    // Restore environment
    delete process.env.RELAY_SOCKET;
  });

  describe('Happy path - both conditions met', () => {
    it('should return true when both .mcp.json AND socket exist', () => {
      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: socket exists and is a socket
      vi.mocked(fs.statSync).mockReturnValue({
        isSocket: () => true,
      } as fs.Stats);

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(mockMcpConfigPath);
      expect(fs.statSync).toHaveBeenCalledWith(defaultSocket);
    });
  });

  describe('Sad path - .mcp.json missing', () => {
    it('should return false when .mcp.json does not exist', () => {
      // Arrange: .mcp.json does NOT exist
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(false);
      expect(fs.existsSync).toHaveBeenCalledWith(mockMcpConfigPath);
      // statSync should NOT be called when .mcp.json is missing
      expect(fs.statSync).not.toHaveBeenCalled();
    });
  });

  describe('Sad path - socket missing', () => {
    it('should return false when .mcp.json exists but socket does not exist', () => {
      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: statSync throws (socket doesn't exist)
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when socket exists but is not a socket file', () => {
      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: statSync returns but isSocket() is false (it's a regular file)
      vi.mocked(fs.statSync).mockReturnValue({
        isSocket: () => false,
      } as fs.Stats);

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when socket access is denied (EACCES)', () => {
      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: statSync throws access denied
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('EACCES: permission denied');
        (error as any).code = 'EACCES';
        throw error;
      });

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Environment variable handling', () => {
    it('should use RELAY_SOCKET env var when set', () => {
      // Arrange: Set custom socket path
      process.env.RELAY_SOCKET = customSocket;

      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: socket exists
      vi.mocked(fs.statSync).mockReturnValue({
        isSocket: () => true,
      } as fs.Stats);

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(true);
      expect(fs.statSync).toHaveBeenCalledWith(customSocket);
    });

    it('should default to /tmp/agent-relay.sock when RELAY_SOCKET not set', () => {
      // Ensure RELAY_SOCKET is NOT set
      delete process.env.RELAY_SOCKET;

      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: socket exists
      vi.mocked(fs.statSync).mockReturnValue({
        isSocket: () => true,
      } as fs.Stats);

      // Act
      checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(fs.statSync).toHaveBeenCalledWith(defaultSocket);
    });

    it('should respect empty RELAY_SOCKET env var (use default)', () => {
      // Empty string should fallback to default
      process.env.RELAY_SOCKET = '';

      // Arrange: .mcp.json exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockMcpConfigPath) return true;
        return false;
      });

      // Arrange: socket exists
      vi.mocked(fs.statSync).mockReturnValue({
        isSocket: () => true,
      } as fs.Stats);

      // Act
      checkMcpAvailability(mockProjectRoot);

      // Assert: Empty string is falsy, so it uses default
      expect(fs.statSync).toHaveBeenCalledWith(defaultSocket);
    });
  });

  describe('Edge cases', () => {
    it('should handle both conditions false', () => {
      // Arrange: neither .mcp.json nor socket exist
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Act
      const result = checkMcpAvailability(mockProjectRoot);

      // Assert
      expect(result).toBe(false);
      expect(fs.statSync).not.toHaveBeenCalled();
    });

    it('should correctly combine path for .mcp.json', () => {
      // Test with different project root paths
      const testRoot = '/some/other/path';
      const expectedMcpPath = '/some/other/path/.mcp.json';

      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Act
      checkMcpAvailability(testRoot);

      // Assert
      expect(fs.existsSync).toHaveBeenCalledWith(expectedMcpPath);
    });
  });
});

/**
 * Integration note:
 * The full integration of this logic can be tested by observing the spawn result:
 * - When hasMcp=true: relayInstructions includes getMcpToolsReference()
 * - When hasMcp=false: relayInstructions does NOT include MCP tools section
 *
 * This is verified in spawner.ts line 717:
 *   let relayInstructions = getRelayInstructions(name, hasMcp);
 *
 * And in getRelayInstructions() which conditionally adds:
 *   if (hasMcp) { parts.push(getMcpToolsReference()); }
 */
