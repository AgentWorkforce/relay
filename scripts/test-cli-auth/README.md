# CLI OAuth Flow Testing

This directory contains tools for testing and validating the CLI-based OAuth authentication flow for AI providers.

## Quick Start

```bash
# Make mock CLI executable
chmod +x scripts/test-cli-auth/mock-cli.sh

# Run all integration tests
npx tsx scripts/test-cli-auth/test-oauth-flow.ts

# Test a specific provider
npx tsx scripts/test-cli-auth/test-oauth-flow.ts anthropic
```

## Architecture

The CLI OAuth flow works as follows:

```
┌─────────────────┐      ┌──────────────┐      ┌─────────────────┐
│  Dashboard UI   │─────▶│  Onboarding  │─────▶│  CLI via PTY    │
│  (React)        │      │  API         │      │  (node-pty)     │
└─────────────────┘      └──────────────┘      └─────────────────┘
         ▲                      │                      │
         │                      │                      ▼
         │                      │               ┌─────────────────┐
         │                      │               │  Interactive    │
         │                      │◀──────────────│  Prompts        │
         │                      │  auto-respond └─────────────────┘
         │                      │                      │
         │                      │                      ▼
         │                      │               ┌─────────────────┐
         │                      │               │  Auth URL       │
         │◀─────────────────────┼───────────────│  Output         │
         │   (opens popup)      │               └─────────────────┘
         │                      │                      │
         ▼                      │                      ▼
┌─────────────────┐            │               ┌─────────────────┐
│  OAuth Popup    │            │               │  Success        │
│  (Browser)      │────────────┼──────────────▶│  Detection      │
└─────────────────┘            │               └─────────────────┘
```

## Adding a New Provider

### 1. Define the CLI Configuration

Add a new entry to `CLI_AUTH_CONFIG` in `src/cloud/api/onboarding.ts`:

```typescript
export const CLI_AUTH_CONFIG: Record<string, CLIAuthConfig> = {
  // ... existing providers

  newprovider: {
    // Required: CLI command to run
    command: 'newcli',

    // Required: Command arguments
    args: ['auth', 'login'],

    // Required: Pattern to extract auth URL (must have capture group)
    urlPattern: /(https:\/\/[^\s]+)/,

    // Optional: Path to credentials file after auth
    credentialPath: '~/.newcli/credentials.json',

    // Required: Display name for UI
    displayName: 'NewProvider',

    // Required: How long to wait for URL (ms)
    waitTimeout: 3000,

    // Required: Interactive prompts to auto-respond to
    prompts: [
      {
        pattern: /do you trust this/i,
        response: 'y\r',
        delay: 100,
        description: 'Trust prompt',
      },
    ],

    // Required: Success indicators
    successPatterns: [
      /success/i,
      /authenticated/i,
    ],
  },
};
```

### 2. Add Mock CLI Behavior

Update `scripts/test-cli-auth/mock-cli.sh` with the new provider's interactive flow:

```bash
newprovider)
  echo -e "${BLUE}NewProvider CLI${NC}"
  sleep "$DELAY"

  echo -e "Do you trust this directory? [y/N] "
  read -r -n 1 response 2>/dev/null || true
  echo ""

  echo -e "Auth URL:"
  echo -e "${GREEN}https://newprovider.com/auth?session=test${NC}"

  read -r -t 30 2>/dev/null || true
  echo -e "${GREEN}Authenticated!${NC}"
  ;;
```

### 3. Add Unit Tests

Add tests to `src/cloud/api/onboarding.test.ts`:

```typescript
describe('newprovider', () => {
  const config = CLI_AUTH_CONFIG.newprovider;

  it('has correct command and args', () => {
    expect(config.command).toBe('newcli');
    expect(config.args).toEqual(['auth', 'login']);
  });

  it('extracts auth URL from output', () => {
    const output = 'Visit https://newprovider.com/auth?id=xxx';
    const match = output.match(config.urlPattern);
    expect(match![1]).toContain('https://newprovider.com/auth');
  });

  // Test each prompt handler
  describe('prompt handlers', () => {
    it('detects trust prompt', () => {
      const prompt = findMatchingPrompt(
        'Do you trust this directory?',
        config.prompts,
        new Set()
      );
      expect(prompt!.description).toBe('Trust prompt');
    });
  });
});
```

### 4. Run Tests

```bash
# Unit tests
npx vitest run src/cloud/api/onboarding.test.ts

# Integration tests
npx tsx scripts/test-cli-auth/test-oauth-flow.ts newprovider
```

## Provider Checklist

When adding or modifying a provider, ensure:

- [ ] `command` is the correct CLI binary name
- [ ] `args` includes any required subcommands (e.g., `['login']`)
- [ ] `urlPattern` has a capture group `(...)` around the URL
- [ ] `waitTimeout` is long enough for multi-step prompts
- [ ] All interactive prompts are handled in `prompts` array
- [ ] Each prompt has a unique `description` for deduplication
- [ ] `successPatterns` cover all success messages the CLI outputs
- [ ] Mock CLI simulates the real CLI's behavior accurately
- [ ] Unit tests cover URL extraction and prompt detection
- [ ] Integration test passes

## Testing with Real CLIs

For testing with actual CLIs (not mocks), you can:

1. **Docker Container Test**: Spin up a container without credentials:
   ```bash
   docker run -it --rm node:20 bash
   npm install -g @anthropic-ai/claude-code
   # Run the onboarding flow
   ```

2. **Fresh VM**: Use a cloud VM with no cached credentials

3. **Delete Credentials**: Remove local credential files:
   ```bash
   rm -rf ~/.claude
   rm -rf ~/.codex
   # etc.
   ```

## Troubleshooting

### URL Not Extracted
- Check if the CLI outputs the URL in expected format
- Verify the `urlPattern` regex matches the output
- Increase `waitTimeout` if prompts take longer

### Prompts Not Detected
- Run mock CLI manually to see exact prompt text
- Check regex patterns are case-insensitive (`/i` flag)
- Ensure ANSI codes are being stripped before matching

### Success Not Detected
- Verify CLI outputs one of the success patterns
- Check for typos in pattern (e.g., `logged in` vs `loggedin`)
- Add new patterns if CLI uses different success messages

## CI Integration

### GitHub Actions

The workflow `.github/workflows/cli-oauth-test.yml` runs:

1. **On every push/PR** that modifies:
   - `src/cloud/api/onboarding.ts`
   - `scripts/test-cli-auth/**`

2. **Weekly schedule** (Sundays at midnight):
   - Catches provider CLI changes early
   - Auto-creates GitHub issues on failure

### Running CI Tests Locally

```bash
# Build the test container with REAL CLIs (recommended)
docker build -f scripts/test-cli-auth/Dockerfile.real \
  -t cli-oauth-test-real scripts/test-cli-auth/

# Run tests against real CLIs
docker run --rm cli-oauth-test-real

# Run with results output
docker run --rm -v $(pwd)/test-results:/tmp cli-oauth-test-real
cat test-results/cli-oauth-test-results.json

# Interactive debugging
docker run --rm -it cli-oauth-test-real bash
claude  # Test Claude CLI manually
```

### Why Real CLIs?

Using the actual CLIs instead of mocks:
- **Catches real changes** in CLI behavior immediately
- **No maintenance burden** of keeping mocks in sync
- **Tests the actual code path** users will experience
- **Detects new prompts** or changed output formats

CLIs that aren't installed are skipped (not failed), so tests work even if some providers haven't published CLIs yet.

### Test Output Format

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "results": [
    {
      "provider": "anthropic",
      "command": "claude",
      "passed": true,
      "urlExtracted": "https://console.anthropic.com/oauth/...",
      "urlValid": true,
      "promptsHandled": 3,
      "exitCode": 0,
      "duration": 1234
    }
  ],
  "summary": {
    "total": 5,
    "passed": 5,
    "failed": 0
  }
}
```

## Files

- `mock-cli.sh` - Simulates CLI interactive flows for testing
- `ci-test-runner.ts` - Docker-based CI test runner
- `test-oauth-flow.ts` - Local integration test runner
- `Dockerfile` - Test container definition
- `package.json` - Test dependencies
- `README.md` - This documentation
