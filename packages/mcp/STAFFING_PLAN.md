# MCP Server Implementation - Staffing Plan

> Generated from analysis of SPEC.md

## Overview

**Goal**: Give AI agents (Claude, Codex, Gemini, Cursor) native MCP tools for Agent Relay communication.

**Estimated Total Effort**: 12-16 hours across 4-6 agents

---

## Phase 1: Core Infrastructure

**Agent**: MCPInfra  
**CLI**: claude  
**Duration**: ~2-3 hours  
**Branch**: feature/mcp-infrastructure

### Tasks
1. Create package structure (packages/mcp/)
2. Set up package.json, tsconfig.json
3. Implement src/discover.ts - socket discovery with priority:
   - RELAY_SOCKET env var
   - RELAY_PROJECT env var
   - CWD .relay/config.json
   - Scan data directory
4. Implement src/client.ts - RelayClient class
   - Socket connection to daemon
   - Frame parsing with @agent-relay/protocol
   - Handshake (HELLO/WELCOME)
   - Message handlers
5. Implement src/errors.ts - Error types
   - RelayError, DaemonNotRunningError, AgentNotFoundError, TimeoutError
6. Write tests/discover.test.ts

### Acceptance Criteria
- Package builds with npm run build
- Discovery finds socket in all priority scenarios
- Client connects to running daemon
- All tests pass

---

## Phase 2a: MCP Tools (Group 1)

**Agent**: MCPTools1  
**CLI**: claude  
**Duration**: ~3-4 hours  
**Branch**: feature/mcp-tools-messaging  
**Depends on**: Phase 1

### Tasks
1. Implement src/tools/relay-send.ts
   - Direct messages, channels, broadcast
   - Thread support
   - await_response with timeout
2. Implement src/tools/relay-inbox.ts
   - Filter by sender, channel
   - Limit and unread_only options
3. Implement src/tools/relay-who.ts
   - List online agents
   - Include idle flag, parent info
4. Write unit tests for all 3 tools

### Acceptance Criteria
- relay_send sends to agents, channels, broadcast
- relay_send with await_response blocks and returns reply
- relay_inbox returns filtered messages
- relay_who lists agents with status
- All tests pass

---

## Phase 2b: MCP Tools (Group 2)

**Agent**: MCPTools2  
**CLI**: claude  
**Duration**: ~3-4 hours  
**Branch**: feature/mcp-tools-spawn  
**Depends on**: Phase 1  
**Parallel with**: Phase 2a

### Tasks
1. Implement src/tools/relay-spawn.ts
   - Spawn worker with name, cli, task
   - Optional model and cwd
2. Implement src/tools/relay-release.ts
   - Release worker by name
   - Optional reason
3. Implement src/tools/relay-status.ts
   - Connection state
   - Agent name, project, socket info
4. Implement src/tools/index.ts - exports
5. Write unit tests for all 3 tools

### Acceptance Criteria
- relay_spawn creates worker agents
- relay_release terminates workers
- relay_status returns connection diagnostics
- All tests pass

---

## Phase 3: MCP Server Assembly

**Agent**: MCPServer  
**CLI**: claude  
**Duration**: ~2-3 hours  
**Branch**: feature/mcp-server  
**Depends on**: Phase 2a + 2b

### Tasks
1. Implement src/index.ts - MCP server entry point
   - Wire all 6 tools
   - Handle tool calls
   - Connect to relay daemon on startup
2. Implement src/bin.ts - CLI binary
   - install command
   - serve command
3. Implement src/prompts/protocol.ts
   - Full protocol documentation prompt
4. Implement src/resources/
   - agents.ts - relay://agents
   - inbox.ts - relay://inbox
   - project.ts - relay://project
5. Write integration tests

### Acceptance Criteria
- npx @agent-relay/mcp serve starts MCP server
- All 6 tools callable via MCP protocol
- Protocol prompt available
- Resources return live data
- Integration tests pass

---

## Phase 4: Installation System

**Agent**: MCPInstall  
**CLI**: claude  
**Duration**: ~2 hours  
**Branch**: feature/mcp-install  
**Depends on**: Phase 3

### Tasks
1. Implement src/install.ts - editor installation logic
   - Detect installed editors (Claude, Cursor, VS Code)
   - Read/modify editor config files
2. Implement src/install-cli.ts - CLI wrapper
3. Add agent-relay mcp command to main CLI
   - agent-relay mcp install
   - agent-relay mcp serve
4. Update agent-relay setup to offer MCP install
5. Write install tests

### Acceptance Criteria
- npx @agent-relay/mcp install auto-detects editors
- Claude Code config updated correctly
- Cursor config updated correctly
- agent-relay mcp install works from main CLI

---

## Phase 5: Cloud Integration

**Agent**: MCPCloud  
**CLI**: claude  
**Duration**: ~1-2 hours  
**Branch**: feature/mcp-cloud  
**Depends on**: Phase 4

### Tasks
1. Update deploy/workspace/Dockerfile
   - Install @agent-relay/mcp globally
   - Pre-configure Claude Code settings
   - Pre-configure Cursor settings
2. Set environment variables for socket discovery
3. Test with all CLI tools in workspace

### Acceptance Criteria
- New workspaces have MCP pre-configured
- Claude Code in workspace has relay tools
- Cursor in workspace has relay tools
- Socket discovery works via RELAY_PROJECT env

---

## Dependency Graph

    Phase 1 (MCPInfra)
           |
           v
      +---------+
      |         |
      v         v
    Phase 2a  Phase 2b  [PARALLEL]
      |         |
      +----+----+
           |
           v
    Phase 3 (MCPServer)
           |
           v
    Phase 4 (MCPInstall)
           |
           v
    Phase 5 (MCPCloud)

---

## Spawn Commands Reference

### Phase 1 - Spawn MCPInfra
NAME: MCPInfra
CLI: claude
TASK: Implement MCP core infrastructure per packages/mcp/SPEC.md Phase 1:
  1. Create packages/mcp/ structure
  2. Implement src/discover.ts (socket discovery)
  3. Implement src/client.ts (RelayClient)
  4. Implement src/errors.ts
  5. Write tests/discover.test.ts
BRANCH: feature/mcp-infrastructure

### Phase 2a - Spawn MCPTools1 (after Phase 1)
NAME: MCPTools1
CLI: claude
TASK: Implement MCP messaging tools per packages/mcp/SPEC.md:
  1. src/tools/relay-send.ts
  2. src/tools/relay-inbox.ts  
  3. src/tools/relay-who.ts
  4. Unit tests for all 3
BRANCH: feature/mcp-tools-messaging

### Phase 2b - Spawn MCPTools2 (after Phase 1, parallel with 2a)
NAME: MCPTools2
CLI: claude
TASK: Implement MCP spawn/control tools per packages/mcp/SPEC.md:
  1. src/tools/relay-spawn.ts
  2. src/tools/relay-release.ts
  3. src/tools/relay-status.ts
  4. src/tools/index.ts (exports)
  5. Unit tests for all 3
BRANCH: feature/mcp-tools-spawn

### Phase 3 - Spawn MCPServer (after Phase 2a + 2b)
NAME: MCPServer
CLI: claude
TASK: Assemble MCP server per packages/mcp/SPEC.md Phase 3:
  1. src/index.ts - MCP server entry point
  2. src/bin.ts - CLI binary
  3. src/prompts/protocol.ts
  4. src/resources/ (agents, inbox, project)
  5. Integration tests
BRANCH: feature/mcp-server

### Phase 4 - Spawn MCPInstall (after Phase 3)
NAME: MCPInstall
CLI: claude
TASK: Implement MCP installation per packages/mcp/SPEC.md Phase 4:
  1. src/install.ts - editor detection
  2. src/install-cli.ts
  3. Add agent-relay mcp command
  4. Update agent-relay setup
  5. Install tests
BRANCH: feature/mcp-install

### Phase 5 - Spawn MCPCloud (after Phase 4)
NAME: MCPCloud
CLI: claude
TASK: Cloud integration per packages/mcp/SPEC.md Phase 5:
  1. Update deploy/workspace/Dockerfile
  2. Pre-configure Claude Code and Cursor
  3. Set RELAY_PROJECT env
  4. Test in workspace container
BRANCH: feature/mcp-cloud

---

## Open Questions

1. **Daemon Protocol**: Does current daemon support SPAWN, RELEASE, WHO, INBOX message types, or do those need to be added first?
2. **Package Publishing**: When should @agent-relay/mcp be published to npm?
3. **Priority**: Local-first or cloud-first testing?

---

## Quick Start for New Session

To resume this work:
1. Read this file and SPEC.md
2. Check which phases are complete (look for merged branches)
3. Spawn the next agent in sequence
4. Monitor progress via relay messages
