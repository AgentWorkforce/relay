# Proposal: Kernel Integration for Cloud Browser Testing

**Author:** Claude Agent
**Date:** 2026-01-09
**Status:** Draft
**PR:** #111

## Executive Summary

This proposal evaluates [Kernel](https://kernel.sh) (formerly onkernel.com) as a cloud browser infrastructure solution for testing dev environments in Agent Relay workflows. Kernel offers sub-300ms browser cold starts, Playwright execution in-VM, persistent sessions, and an MCP server—making it a compelling alternative to local Chrome automation.

## Problem Statement

Current browser testing via the `browser-testing-with-screenshots` skill has limitations:

| Issue | Impact |
|-------|--------|
| **Local Chrome dependency** | Requires `agent-tools` installation on each machine |
| **No cloud/CI support** | Cannot run in headless cloud environments (e.g., Claude Code web) |
| **State isolation** | Each agent must manage its own browser state |
| **Resource consumption** | Local Chrome processes consume significant memory |
| **No session persistence** | Auth state lost between agent sessions |

## Proposed Solution: Kernel Integration

### What is Kernel?

Kernel is a Y Combinator (S25) and Accel-backed platform providing cloud browser infrastructure:

- **Unikernel architecture**: Chromium browsers run on lightweight unikernels, not Docker containers
- **Sub-300ms cold starts**: Near-instant browser availability
- **Playwright execution**: Run TypeScript/Playwright code directly in the browser's VM
- **Session persistence**: Cookies, localStorage, and auth state preserved across sessions
- **MCP server**: Direct integration with Claude Code via Model Context Protocol

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Browser Profiles** | Persist login state, cookies, and preferences across sessions |
| **Playwright Execution** | Execute arbitrary Playwright code against cloud browsers |
| **Screenshots** | Capture viewport or full-page screenshots |
| **Session Replays** | Video recordings of browser sessions for debugging |
| **File I/O** | Read/write files (downloads, uploads) from browser filesystem |
| **Standby Mode** | Browsers sleep between connections (pay only for active time) |
| **Anti-detection** | Built-in stealth mode, residential proxies, CAPTCHA solving |

### MCP Server Integration

Kernel provides a managed MCP server at `https://mcp.onkernel.com/mcp` with these tools:

```
Browser Management:
- create_browser      Launch new browser sessions
- execute_playwright_code   Run Playwright/TypeScript dynamically
- take_screenshot     Capture screenshots
- list_browsers / get_browser / delete_browser

Profiles:
- setup_profile       Create authenticated browser profiles
- list_profiles / delete_profile

Documentation:
- search_docs         Query Kernel platform docs
```

### Playwright Execution API

Execute code directly against a browser session:

```typescript
const response = await kernel.browsers.playwright.execute(sessionId, {
  code: `
    await page.goto('http://localhost:5172/dashboard');
    await page.waitForSelector('.dashboard-loaded');
    return await page.title();
  `,
  timeout_sec: 60
});

// Available variables: page, context, browser
// Returns: { success: boolean, result: any, error?: string }
```

## Architecture Comparison

### Current: Local Browser Testing

```
┌─────────────────────────────────────────────────────┐
│  Agent Machine                                       │
│  ┌──────────┐    ┌───────────────┐    ┌──────────┐ │
│  │  Agent   │───▶│  agent-tools  │───▶│  Chrome  │ │
│  │          │    │  (browser-*)  │    │  (9222)  │ │
│  └──────────┘    └───────────────┘    └──────────┘ │
│                                              │      │
│                                              ▼      │
│                                       ┌──────────┐ │
│                                       │ Localhost│ │
│                                       │ Dev App  │ │
│                                       └──────────┘ │
└─────────────────────────────────────────────────────┘
```

**Pros:** No network latency, simple setup for local dev
**Cons:** Requires local Chrome, no cloud support, no state persistence

### Proposed: Kernel Cloud Browsers

```
┌─────────────────┐         ┌─────────────────────────┐
│  Agent Machine  │         │      Kernel Cloud       │
│  ┌──────────┐   │   MCP   │  ┌─────────────────┐    │
│  │  Agent   │───┼────────▶│  │ Kernel Browser  │    │
│  │          │   │         │  │  (Unikernel)    │    │
│  └──────────┘   │         │  └────────┬────────┘    │
└─────────────────┘         │           │             │
                            │           ▼             │
                            │  ┌─────────────────┐    │
                            │  │ Tunnel/Proxy to │    │
                            │  │ Dev Environment │    │
                            │  └─────────────────┘    │
                            └─────────────────────────┘
```

**Pros:** Cloud-native, persistent sessions, replay debugging
**Cons:** Network latency, requires tunnel for localhost apps

## Integration Options

### Option A: MCP Server (Recommended for Claude Code)

Add Kernel to Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "kernel": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.onkernel.com/mcp"]
    }
  }
}
```

**Pros:** Zero installation, managed OAuth, instant availability
**Cons:** Limited to MCP tool interface

### Option B: Direct SDK Integration

Install Kernel SDK for programmatic access:

```bash
npm install @onkernel/sdk
```

```typescript
import { Kernel } from '@onkernel/sdk';

const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });

// Create browser with profile
const session = await kernel.browsers.create({
  profile: 'dev-testing-profile',
  persist: true
});

// Execute Playwright code
const result = await kernel.browsers.playwright.execute(session.id, {
  code: `
    await page.goto('${devUrl}');
    await page.screenshot({ path: 'test.png' });
    return document.title;
  `
});
```

**Pros:** Full API access, programmatic control
**Cons:** Requires SDK installation, API key management

### Option C: Hybrid Approach

Combine local testing for rapid iteration with Kernel for CI/cloud:

```
Local Development:
  └── agent-tools (browser-start.js, etc.) → fast iteration

CI/Cloud/Web:
  └── Kernel MCP Server → persistent state, replays
```

## Localhost Testing Challenge

One challenge: Kernel browsers run in the cloud and cannot directly access `localhost` on the developer's machine.

### Solutions

1. **Tunneling Services**: Use ngrok, Cloudflare Tunnel, or similar to expose localhost
   ```bash
   ngrok http 5172
   # Then use https://abc123.ngrok.io in Kernel browser
   ```

2. **Deploy to Staging**: Test against a staging environment instead of localhost

3. **Kernel Apps**: Deploy the dev app as a Kernel App for same-VM testing

4. **Tailscale/VPN**: Connect Kernel to private network

### Recommendation

For **dev environment testing** specifically:
- Use **local agent-tools** for rapid localhost iteration
- Use **Kernel** for:
  - CI/CD pipeline testing
  - Testing against staging/production URLs
  - Scenarios requiring session persistence
  - Multi-agent browser coordination
  - Recording session replays for debugging

## Implementation Plan

### Phase 1: MCP Server Integration (1-2 days)

1. Add Kernel MCP server to recommended configurations
2. Create skill documentation for Kernel browser testing
3. Document tunneling options for localhost access

### Phase 2: SDK Integration (2-3 days)

1. Add `@onkernel/sdk` as optional dependency
2. Create wrapper functions for common operations
3. Implement profile management for persistent auth

### Phase 3: Hybrid Skill (1-2 days)

1. Update `browser-testing-with-screenshots` skill
2. Add environment detection (local vs cloud)
3. Auto-select appropriate backend

### Phase 4: CI/CD Integration

1. Add Kernel browser tests to CI pipeline
2. Implement test result archiving with session replays
3. Create cross-browser testing capabilities

## Cost Considerations

| Tier | Details |
|------|---------|
| **Free Tier** | Generous free tier for development/testing |
| **Resource-based** | Pay only for active browser time |
| **Standby Mode** | Minimal cost when browsers are idle |
| **Enterprise** | SOC2/HIPAA compliance available |

*Note: Visit kernel.sh for current pricing details*

## Comparison Matrix

| Feature | Local (agent-tools) | Kernel Cloud |
|---------|---------------------|--------------|
| Cold start | ~2-5s | <300ms |
| Localhost access | ✅ Direct | ⚠️ Requires tunnel |
| Session persistence | ❌ Manual | ✅ Built-in |
| Cloud/CI support | ❌ No | ✅ Yes |
| Session replays | ❌ No | ✅ Built-in |
| Multi-agent coordination | ⚠️ Complex | ✅ Easy |
| Anti-detection | ❌ No | ✅ Built-in |
| Setup complexity | Medium | Low (MCP) |
| Cost | Free (local resources) | Free tier + usage |

## Recommendation

**Adopt a hybrid approach:**

1. **Keep agent-tools** for rapid local development iteration
2. **Add Kernel MCP** for cloud/CI scenarios and advanced features
3. **Create unified skill** that auto-detects environment and uses appropriate backend

This gives agents flexibility:
- Fast local testing during development
- Robust cloud testing for CI/CD
- Session persistence for complex auth flows
- Debug capabilities via session replays

## Next Steps

1. [ ] Review and approve this proposal
2. [ ] Set up Kernel account and obtain API credentials
3. [ ] Test MCP server integration with Claude Code
4. [ ] Prototype localhost tunnel solution
5. [ ] Update browser-testing skill with hybrid support

## References

- [Kernel Documentation](https://docs.onkernel.com/introduction)
- [Kernel MCP Server](https://github.com/onkernel/kernel-mcp-server)
- [Kernel vs Browserbase Comparison](https://www.kernel.sh/blog/kernel-vs-browserbase)
- [Y Combinator Profile](https://www.ycombinator.com/companies/kernel)
- [Playwright Execution Docs](https://www.kernel.sh/docs/browsers/playwright-execution)
