/**
 * Comprehensive tests for relay-pty binary path resolution.
 *
 * Tests all installation scenarios by verifying the search paths are correct:
 * 1. npx (from @agent-relay/* scoped package)
 * 2. npx (from agent-relay directly)
 * 3. npm install -g (nvm)
 * 4. npm install -g (Homebrew macOS)
 * 5. npm install -g (Homebrew macOS arm64)
 * 6. npm install (local project)
 * 7. pnpm global
 * 8. Development (monorepo)
 * 9. Docker container
 * 10. Environment variable override
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  findRelayPtyBinary,
  getLastSearchPaths,
  clearBinaryCache,
  isPlatformSupported,
  getSupportedPlatforms,
} from './relay-pty-path.js';

describe('findRelayPtyBinary - search path verification', () => {
  beforeEach(() => {
    clearBinaryCache();
    delete process.env.RELAY_PTY_BINARY;
  });

  describe('npx installation (scoped @agent-relay/* package)', () => {
    // When running via npx, the code runs from:
    // ~/.npm/_npx/{hash}/node_modules/@agent-relay/bridge/dist/
    // Binary should be searched at:
    // ~/.npm/_npx/{hash}/node_modules/agent-relay/bin/relay-pty-darwin-arm64

    it('should include correct npx cache path for scoped package', () => {
      const callerDirname = '/Users/testuser/.npm/_npx/abc123/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      // Should include the sibling agent-relay package path
      const expectedPath = '/Users/testuser/.npm/_npx/abc123/node_modules/agent-relay/bin';
      expect(paths.some((p) => p.startsWith(expectedPath))).toBe(true);
    });

    it('should check platform-specific binary BEFORE generic binary', () => {
      const callerDirname = '/Users/testuser/.npm/_npx/abc123/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      // Find the first occurrence of the npx cache path
      const npxBasePath = '/Users/testuser/.npm/_npx/abc123/node_modules/agent-relay/bin';
      const platformIdx = paths.findIndex(
        (p) => p.startsWith(npxBasePath) && p.includes('relay-pty-')
      );
      const genericIdx = paths.findIndex((p) => p === `${npxBasePath}/relay-pty`);

      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect(genericIdx).toBeGreaterThan(platformIdx);
    });
  });

  describe('npx installation (direct agent-relay package)', () => {
    // When CLI code itself calls findRelayPtyBinary:
    // ~/.npm/_npx/{hash}/node_modules/agent-relay/dist/src/cli/

    it('should include correct path for direct agent-relay in npx cache', () => {
      const callerDirname = '/Users/testuser/.npm/_npx/xyz789/node_modules/agent-relay/dist/src/cli';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      const expectedPath = '/Users/testuser/.npm/_npx/xyz789/node_modules/agent-relay/bin';
      expect(paths.some((p) => p.startsWith(expectedPath))).toBe(true);
    });
  });

  describe('Global npm install (nvm)', () => {
    // ~/.nvm/versions/node/v20.0.0/lib/node_modules/agent-relay/

    it('should include nvm global install path', () => {
      const callerDirname =
        '/Users/testuser/.nvm/versions/node/v20.0.0/lib/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      const expectedPath =
        '/Users/testuser/.nvm/versions/node/v20.0.0/lib/node_modules/agent-relay/bin';
      expect(paths.some((p) => p.startsWith(expectedPath))).toBe(true);
    });
  });

  describe('Global npm install (Homebrew macOS)', () => {
    // /usr/local/lib/node_modules/agent-relay/ (Intel)
    // /opt/homebrew/lib/node_modules/agent-relay/ (Apple Silicon)

    it('should include Homebrew Intel location', () => {
      const callerDirname = '/usr/local/lib/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(paths.some((p) => p.startsWith('/usr/local/lib/node_modules/agent-relay/bin'))).toBe(
        true
      );
    });

    it('should include Homebrew Apple Silicon location', () => {
      const callerDirname = '/opt/homebrew/lib/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(
        paths.some((p) => p.startsWith('/opt/homebrew/lib/node_modules/agent-relay/bin'))
      ).toBe(true);
    });
  });

  describe('Local project install (npm install agent-relay)', () => {
    // /path/to/project/node_modules/agent-relay/

    it('should include local node_modules path from scoped package', () => {
      const callerDirname = '/path/to/myproject/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      const expectedPath = '/path/to/myproject/node_modules/agent-relay/bin';
      expect(paths.some((p) => p.startsWith(expectedPath))).toBe(true);
    });

    it('should include cwd-based node_modules path', () => {
      const callerDirname = '/some/other/location';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      const cwdPath = `${process.cwd()}/node_modules/agent-relay/bin`;
      expect(paths.some((p) => p.startsWith(cwdPath))).toBe(true);
    });
  });

  describe('pnpm global install', () => {
    // ~/.local/share/pnpm/global/node_modules/agent-relay/

    it('should include pnpm global location', () => {
      const callerDirname =
        '/Users/testuser/.local/share/pnpm/global/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(
        paths.some((p) =>
          p.startsWith('/Users/testuser/.local/share/pnpm/global/node_modules/agent-relay/bin')
        )
      ).toBe(true);
    });
  });

  describe('Development (monorepo)', () => {
    // /path/to/relay/packages/bridge/dist/

    it('should include project root bin/ path', () => {
      const callerDirname = '/path/to/relay/packages/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      // Development path: go up 3 levels to project root
      expect(paths.some((p) => p.startsWith('/path/to/relay/bin'))).toBe(true);
    });

    it('should include Rust target/release path', () => {
      const callerDirname = '/path/to/relay/packages/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(paths.some((p) => p.includes('relay-pty/target/release/relay-pty'))).toBe(true);
    });

    it('should include Rust target/debug path', () => {
      const callerDirname = '/path/to/relay/packages/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(paths.some((p) => p.includes('relay-pty/target/debug/relay-pty'))).toBe(true);
    });
  });

  describe('Docker container', () => {
    it('should include /app/bin/relay-pty path', () => {
      const callerDirname = '/app/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(paths).toContain('/app/bin/relay-pty');
    });
  });

  describe('System-wide install', () => {
    it('should include /usr/local/bin/relay-pty path', () => {
      const callerDirname = '/some/path';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      expect(paths).toContain('/usr/local/bin/relay-pty');
    });
  });

  describe('Platform-specific binary naming', () => {
    it('should include platform-specific binary name in search paths', () => {
      const callerDirname = '/path/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      // Should have platform-specific binary names based on current platform
      const platform = process.platform;
      const arch = process.arch;
      let expectedBinaryName: string | null = null;

      if (platform === 'darwin' && arch === 'arm64') {
        expectedBinaryName = 'relay-pty-darwin-arm64';
      } else if (platform === 'darwin' && arch === 'x64') {
        expectedBinaryName = 'relay-pty-darwin-x64';
      } else if (platform === 'linux' && arch === 'arm64') {
        expectedBinaryName = 'relay-pty-linux-arm64';
      } else if (platform === 'linux' && arch === 'x64') {
        expectedBinaryName = 'relay-pty-linux-x64';
      }

      if (expectedBinaryName) {
        expect(paths.some((p) => p.includes(expectedBinaryName!))).toBe(true);
      }
    });
  });

  describe('Search path order priority', () => {
    it('should have platform-specific binaries before generic binaries for same location', () => {
      const callerDirname = '/Users/testuser/.npm/_npx/abc123/node_modules/@agent-relay/bridge/dist';

      findRelayPtyBinary(callerDirname);
      const paths = getLastSearchPaths();

      // For each unique bin directory, platform-specific should come before generic
      const binDirs = new Set<string>();
      for (const p of paths) {
        const binDir = p.replace(/\/[^/]+$/, ''); // Remove filename
        if (binDir.endsWith('/bin')) {
          binDirs.add(binDir);
        }
      }

      for (const binDir of binDirs) {
        const platformIdx = paths.findIndex(
          (p) => p.startsWith(binDir) && p.includes('relay-pty-')
        );
        const genericIdx = paths.findIndex((p) => p === `${binDir}/relay-pty`);

        // If both exist, platform should come first
        if (platformIdx >= 0 && genericIdx >= 0) {
          expect(platformIdx).toBeLessThan(genericIdx);
        }
      }
    });
  });

  describe('Environment variable override', () => {
    it('should use RELAY_PTY_BINARY when file is executable', () => {
      // Use an actual executable that exists on all Unix systems
      // /bin/ls is guaranteed to exist and be executable
      const executableFile = '/bin/ls';
      process.env.RELAY_PTY_BINARY = executableFile;

      const result = findRelayPtyBinary('/any/path');

      // Should return the env var path since the file is executable
      expect(result).toBe(executableFile);

      delete process.env.RELAY_PTY_BINARY;
    });

    it('should fall back to normal search when RELAY_PTY_BINARY file does not exist', () => {
      process.env.RELAY_PTY_BINARY = '/nonexistent/path/relay-pty';

      findRelayPtyBinary('/any/path');
      const paths = getLastSearchPaths();

      // Should have searched multiple paths (not just the env var)
      expect(paths.length).toBeGreaterThan(1);

      delete process.env.RELAY_PTY_BINARY;
    });
  });

  describe('Real binary resolution', () => {
    it('should find actual relay-pty binary in development', () => {
      // This test uses the real file system to verify the function works
      // in development context
      const devPath = `${process.cwd()}/packages/utils/dist`;

      const result = findRelayPtyBinary(devPath);

      // In development, we should find the binary in bin/
      // This test only passes when run from the monorepo root
      if (process.cwd().includes('relay')) {
        expect(result).not.toBeNull();
        expect(result).toMatch(/relay-pty/);
      }
    });
  });
});

describe('isPlatformSupported', () => {
  it('should return true for current platform (darwin/linux arm64/x64)', () => {
    const platform = process.platform;
    const arch = process.arch;

    // This test runs on macOS/Linux CI, so current platform should be supported
    if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')) {
      expect(isPlatformSupported()).toBe(true);
    }
  });

  it('should be consistent with platform binary availability', () => {
    // If platform is supported, we should have a binary name for it
    const supported = isPlatformSupported();
    const platforms = getSupportedPlatforms();

    if (supported) {
      const currentPlatformArch = `${process.platform}-${process.arch}`;
      expect(platforms).toContain(currentPlatformArch);
    }
  });
});

describe('getSupportedPlatforms', () => {
  it('should return all supported platform-arch combinations', () => {
    const platforms = getSupportedPlatforms();

    // Should include all 4 supported combinations
    expect(platforms).toContain('darwin-arm64');
    expect(platforms).toContain('darwin-x64');
    expect(platforms).toContain('linux-arm64');
    expect(platforms).toContain('linux-x64');
  });

  it('should not include Windows', () => {
    const platforms = getSupportedPlatforms();

    expect(platforms).not.toContain('win32-x64');
    expect(platforms).not.toContain('win32-arm64');
    expect(platforms).not.toMatch(/win32/);
  });

  it('should return a comma-separated string', () => {
    const platforms = getSupportedPlatforms();

    expect(typeof platforms).toBe('string');
    expect(platforms).toMatch(/^[\w-]+(, [\w-]+)*$/);
  });
});
