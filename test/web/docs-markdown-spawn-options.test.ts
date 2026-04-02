import { describe, expect, it } from 'vitest';

import { getDocMarkdown } from '../../web/lib/docs-markdown';

describe('docs markdown export for spawn options', () => {
  it('renders SpawnOptionsTable without leaking JSX', () => {
    const doc = getDocMarkdown('spawning-an-agent');

    expect(doc).not.toBeNull();
    expect(doc?.markdown).not.toContain('<SpawnOptionsTable');
    expect(doc?.markdown).toContain('| Option | What it does |');
    expect(doc?.markdown).toContain(
      '| `binaryPath` | Path to the agent-relay-broker binary. Auto-resolved if omitted. |'
    );
    expect(doc?.markdown).toContain(
      '| `binaryArgs` | Extra args passed to `broker init` (for example `["--persist"]`). |'
    );
    expect(doc?.markdown).toContain(
      '| `startupTimeoutMs` | Timeout in ms to wait for the broker to become ready. Defaults to `15000`. |'
    );
    expect(doc?.markdown).toContain(
      '| `requestTimeoutMs` | Timeout in ms for HTTP requests to the broker. Defaults to `30000`. |'
    );
    expect(doc?.markdown).toContain('| `skipRelayPrompt` | Skip MCP/protocol prompt injection when relay messaging is not needed |');
    expect(doc?.markdown).toContain('| `onStart` | Run code before spawn |');
    expect(doc?.markdown).toContain('| `onSuccess` | Run code after a successful spawn |');
    expect(doc?.markdown).toContain('| `onError` | Run code if spawn fails |');
    expect(doc?.markdown).not.toContain('`onStart`, `onSuccess`, `onError`');
    expect(doc?.markdown).not.toContain('`binary_path`');
  });
});
