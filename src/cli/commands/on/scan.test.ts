import { afterEach, describe, expect, it, vi } from 'vitest';

const compileDotfilesMock = vi.hoisted(() => vi.fn());
const discoverAgentsMock = vi.hoisted(() => vi.fn());
const hasDotfilesMock = vi.hoisted(() => vi.fn());
const parseDotfilesMock = vi.hoisted(() => vi.fn());

vi.mock('./dotfiles.js', () => ({
  compileDotfiles: compileDotfilesMock,
  discoverAgents: discoverAgentsMock,
  hasDotfiles: hasDotfilesMock,
  parseDotfiles: parseDotfilesMock,
}));

import { scanPermissions } from './scan.js';

afterEach(() => {
  compileDotfilesMock.mockReset();
  discoverAgentsMock.mockReset();
  hasDotfilesMock.mockReset();
  parseDotfilesMock.mockReset();
});

describe('scanPermissions', () => {
  it('logs default-agent fallback when no dotfiles or discovered agents exist', async () => {
    const log = vi.fn();
    hasDotfilesMock.mockReturnValue(false);
    discoverAgentsMock.mockReturnValue([]);
    parseDotfilesMock.mockReturnValue({ ignoredPatterns: [], readonlyPatterns: [] });
    compileDotfilesMock.mockReturnValue({ readwritePaths: [] });

    await scanPermissions({ projectDir: '/tmp/demo-project', log });

    expect(log).toHaveBeenNthCalledWith(1, 'Discovered agents: default-agent');
    expect(log).toHaveBeenCalledWith('No dotfile patterns found; defaulting to full readwrite workspace visibility.');
    expect(parseDotfilesMock).toHaveBeenCalledWith('/tmp/demo-project', 'default-agent');
    expect(compileDotfilesMock).toHaveBeenCalledWith('/tmp/demo-project', 'default-agent', 'demo-project');
    expect(log).toHaveBeenCalledWith('Ignored patterns (0):');
    expect(log).toHaveBeenCalledWith('Readonly patterns (0):');
    expect(log).toHaveBeenCalledWith('Writable files (0):');
    expect(log).toHaveBeenCalledWith('  - (none)');
  });

  it('renders multiple discovered agents and explicit workspace names', async () => {
    const log = vi.fn();
    hasDotfilesMock.mockReturnValue(true);
    discoverAgentsMock.mockReturnValue(['alpha', 'beta']);
    parseDotfilesMock
      .mockReturnValueOnce({ ignoredPatterns: ['dist/**'], readonlyPatterns: ['src/**'] })
      .mockReturnValueOnce({ ignoredPatterns: [], readonlyPatterns: ['docs/**'] });
    compileDotfilesMock
      .mockReturnValueOnce({ readwritePaths: ['package.json'] })
      .mockReturnValueOnce({ readwritePaths: ['README.md', 'docs/guide.md'] });

    await scanPermissions({ projectDir: '/tmp/project', workspace: 'shared-workspace', log });

    expect(parseDotfilesMock).toHaveBeenNthCalledWith(1, '/tmp/project', 'alpha');
    expect(parseDotfilesMock).toHaveBeenNthCalledWith(2, '/tmp/project', 'beta');
    expect(compileDotfilesMock).toHaveBeenNthCalledWith(1, '/tmp/project', 'alpha', 'shared-workspace');
    expect(compileDotfilesMock).toHaveBeenNthCalledWith(2, '/tmp/project', 'beta', 'shared-workspace');
    expect(log).toHaveBeenCalledWith('Discovered agents: alpha, beta');
    expect(log).toHaveBeenCalledWith('  - dist/**');
    expect(log).toHaveBeenCalledWith('  - src/**');
    expect(log).toHaveBeenCalledWith('  - docs/**');
    expect(log).toHaveBeenCalledWith('  - package.json');
    expect(log).toHaveBeenCalledWith('  - README.md');
    expect(log).toHaveBeenCalledWith('  - docs/guide.md');
  });
});
