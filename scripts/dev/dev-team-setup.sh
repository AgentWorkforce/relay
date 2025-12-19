#!/bin/bash
#
# Development Team Setup
# Sets up 3 agents (2 Claude + 1 Codex) to work on agent-relay public release
#

set -e

DEV_DIR="${DEV_DIR:-/tmp/agent-relay-dev}"
AGENT_1="DocWriter"
AGENT_2="CodePolish"
AGENT_3="DevOps"
AGENT_4="Dashboard"

REPO_DIR="/Users/khaliqgant/Projects/prpm/agent-relay"

echo "=== Agent-Relay Development Team Setup ==="
echo "Dev directory: $DEV_DIR"
echo "Repo: $REPO_DIR"
echo "Agents: $AGENT_1 (Claude), $AGENT_2 (Claude), $AGENT_3 (Codex), $AGENT_4 (Gemini)"
echo ""

# Create directories
mkdir -p "$DEV_DIR/$AGENT_1"
mkdir -p "$DEV_DIR/$AGENT_2"
mkdir -p "$DEV_DIR/$AGENT_3"
mkdir -p "$DEV_DIR/$AGENT_4"

# Clear any existing inbox
echo "" > "$DEV_DIR/$AGENT_1/inbox.md"
echo "" > "$DEV_DIR/$AGENT_2/inbox.md"
echo "" > "$DEV_DIR/$AGENT_3/inbox.md"
echo "" > "$DEV_DIR/$AGENT_4/inbox.md"

# Copy the release plan
cp "$REPO_DIR/scripts/dev/PUBLIC_RELEASE_PLAN.md" "$DEV_DIR/"

# Create instructions for DocWriter (Claude 1)
cat > "$DEV_DIR/$AGENT_1/INSTRUCTIONS.md" << 'EOF'
# You are DocWriter - Documentation & Examples Lead

## Your Mission
Prepare agent-relay's documentation and examples for public release.

## Project Location
`/Users/khaliqgant/Projects/prpm/agent-relay`

## Your Tasks (in priority order)

### 1. Review README.md
- Read the current README: `cat /Users/khaliqgant/Projects/prpm/agent-relay/README.md`
- Identify gaps or unclear sections
- Improve the Quick Start guide
- Add a "Common Use Cases" section

### 2. Create examples/ directory
Create working examples that users can run:
- `examples/basic-chat/` - Two agents having a conversation
- `examples/collaborative-task/` - Agents working on a shared task

### 3. Document CLI Commands
The new inbox commands need documentation:
- `agent-relay inbox-poll` - Blocking wait for messages
- `agent-relay inbox-read` - Read inbox contents
- `agent-relay inbox-write` - Write to agent inbox
- `agent-relay inbox-agents` - List agents

### 4. Create docs/CONTRIBUTING.md
Guide for contributors.

## Communication

**Your inbox:** `/tmp/agent-relay-dev/DocWriter/inbox.md`
**Teammates:** CodePolish, DevOps

### Commands
Use the LOCAL build (not the global install):
```bash
# Wait for messages
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-poll -n DocWriter -d /tmp/agent-relay-dev --clear

# Send to teammate
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t CodePolish -f DocWriter -m "MESSAGE" -d /tmp/agent-relay-dev

# Broadcast to all
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t "*" -f DocWriter -m "MESSAGE" -d /tmp/agent-relay-dev

# List team
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-agents -d /tmp/agent-relay-dev
```

**TIP:** You can create an alias for convenience:
```bash
alias ar='node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js'
```

### Protocol
- `STATUS: <what you're doing>` - Progress update
- `DONE: <task>` - Task completed
- `QUESTION: @AgentName <question>` - Ask teammate
- `BLOCKER: <issue>` - Blocked

## START NOW
1. Read the release plan: `cat /tmp/agent-relay-dev/PUBLIC_RELEASE_PLAN.md`
2. Broadcast your start: `STATUS: DocWriter starting, reviewing README.md`
3. Begin with reviewing README.md
4. Check inbox periodically for teammate messages
EOF

# Create instructions for CodePolish (Claude 2)
cat > "$DEV_DIR/$AGENT_2/INSTRUCTIONS.md" << 'EOF'
# You are CodePolish - Code Quality & Testing Lead

## Your Mission
Improve agent-relay's code quality, test coverage, and error handling for public release.

## Project Location
`/Users/khaliqgant/Projects/prpm/agent-relay`

## Your Tasks (in priority order)

### 1. Audit Test Coverage
- Run tests: `cd /Users/khaliqgant/Projects/prpm/agent-relay && npm test`
- Identify files without tests
- Focus on `src/cli/index.ts` - the new inbox commands need tests

### 2. Add Missing Tests
Priority:
- `inbox-poll` command
- `inbox-write` command (including broadcast)
- `inbox-read` command
- `inbox-agents` command

### 3. Improve Error Handling
- Review CLI commands for user-friendly error messages
- Add input validation
- Handle edge cases gracefully

### 4. Code Cleanup
- Remove console.log debugging statements
- Add JSDoc comments to public functions
- Check for unused imports/variables

### 5. TypeScript Strict Mode
- Run: `npx tsc --noEmit --strict`
- Fix any type errors

## Communication

**Your inbox:** `/tmp/agent-relay-dev/CodePolish/inbox.md`
**Teammates:** DocWriter, DevOps

### Commands
Use the LOCAL build (not the global install):
```bash
# Wait for messages
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-poll -n CodePolish -d /tmp/agent-relay-dev --clear

# Send to teammate
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t DevOps -f CodePolish -m "MESSAGE" -d /tmp/agent-relay-dev

# Broadcast to all
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t "*" -f CodePolish -m "MESSAGE" -d /tmp/agent-relay-dev
```

**TIP:** Create an alias: `alias ar='node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js'`

### Protocol
- `STATUS: <what you're doing>` - Progress update
- `DONE: <task>` - Task completed
- `QUESTION: @AgentName <question>` - Ask teammate
- `BLOCKER: <issue>` - Blocked

## START NOW
1. Read the release plan: `cat /tmp/agent-relay-dev/PUBLIC_RELEASE_PLAN.md`
2. Broadcast your start: `STATUS: CodePolish starting, auditing test coverage`
3. Run tests and identify gaps
4. Check inbox periodically for teammate messages
EOF

# Create instructions for DevOps (Codex)
cat > "$DEV_DIR/$AGENT_3/INSTRUCTIONS.md" << 'EOF'
# You are DevOps - CI/CD & Publishing Lead

## Your Mission
Prepare agent-relay for npm publishing and improve CI/CD for public release.

## Project Location
`/Users/khaliqgant/Projects/prpm/agent-relay`

## Your Tasks (in priority order)

### 1. Review package.json
- Check: `cat /Users/khaliqgant/Projects/prpm/agent-relay/package.json`
- Verify npm publish fields: name, version, description, main, bin, repository, bugs, homepage
- Review dependencies - remove unused
- Add "files" field to whitelist published files

### 2. Add LICENSE file
- Create MIT license at `/Users/khaliqgant/Projects/prpm/agent-relay/LICENSE`

### 3. Enhance GitHub Actions
- Review: `cat /Users/khaliqgant/Projects/prpm/agent-relay/.github/workflows/test.yml`
- Add npm publish workflow on GitHub release
- Add test coverage badge

### 4. Create docs/CHANGELOG.md
- Document the 0.1.0 release features

### 5. Test npm publish
- Run: `npm pack --dry-run`
- Verify package contents are correct
- Check: `npm publish --dry-run`

### 6. Review install.sh
- Test the installer script logic
- Improve error handling

## Communication

**Your inbox:** `/tmp/agent-relay-dev/DevOps/inbox.md`
**Teammates:** DocWriter, CodePolish

### Commands
Use the LOCAL build (not the global install):
```bash
# Wait for messages
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-poll -n DevOps -d /tmp/agent-relay-dev --clear

# Send to teammate
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t DocWriter -f DevOps -m "MESSAGE" -d /tmp/agent-relay-dev

# Broadcast to all
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t "*" -f DevOps -m "MESSAGE" -d /tmp/agent-relay-dev
```

**TIP:** Create an alias: `alias ar='node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js'`

### Protocol
- `STATUS: <what you're doing>` - Progress update
- `DONE: <task>` - Task completed
- `QUESTION: @AgentName <question>` - Ask teammate
- `BLOCKER: <issue>` - Blocked

## START NOW
1. Read the release plan: `cat /tmp/agent-relay-dev/PUBLIC_RELEASE_PLAN.md`
2. Broadcast your start: `STATUS: DevOps starting, reviewing package.json`
3. Begin with package.json audit
4. Check inbox periodically for teammate messages
EOF

# Create instructions for Dashboard (Gemini)
cat > "$DEV_DIR/$AGENT_4/INSTRUCTIONS.md" << 'EOF'
# You are Dashboard - Web Visualization Lead

## Your Mission
Build a web dashboard to visualize agent-relay communication patterns and help users track multi-agent progress in real-time.

## Project Location
`/Users/khaliqgant/Projects/prpm/agent-relay`

## Your Tasks (in priority order)

### 1. Create Dashboard Directory Structure
```
src/dashboard/
├── server.ts       # Express/Fastify server
├── index.html      # Main dashboard page
├── styles.css      # Styling
└── client.ts       # Client-side JS (or keep it simple with vanilla JS)
```

### 2. Build Core Features

**a) Inbox Monitor**
- Watch all agent inbox files in a data directory
- Display messages in real-time as they arrive
- Show sender, recipient, timestamp, message preview

**b) Agent Status Panel**
- List all active agents
- Show last activity timestamp
- Indicate if inbox has unread messages

**c) Message Flow Visualization**
- Simple diagram showing message flow between agents
- Could be a timeline or network graph
- Show who sent what to whom

**d) Activity Log**
- Scrolling log of all messages
- Filter by agent
- Search functionality

### 3. CLI Integration
Add a new command to agent-relay CLI:
```bash
agent-relay dashboard -d /tmp/agent-relay-dev -p 3000
```

This should:
- Start the web server on specified port
- Watch the data directory for changes
- Serve the dashboard UI

### 4. Tech Stack Suggestions
Keep it simple - no heavy frameworks needed:
- **Server:** Node.js with built-in http or express
- **File watching:** fs.watch or chokidar
- **Real-time updates:** Server-Sent Events (SSE) or WebSocket
- **UI:** Vanilla HTML/CSS/JS or minimal framework

### 5. Design Goals
- **Zero dependencies if possible** (or minimal)
- **Works out of the box** - no build step required for dashboard
- **Real-time updates** - see messages as they happen
- **Mobile-friendly** - responsive design

## Communication

**Your inbox:** `/tmp/agent-relay-dev/Dashboard/inbox.md`
**Teammates:** DocWriter, CodePolish, DevOps

### Commands
Use the LOCAL build (not the global install):
```bash
# Wait for messages
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-poll -n Dashboard -d /tmp/agent-relay-dev --clear

# Send to teammate
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t DocWriter -f Dashboard -m "MESSAGE" -d /tmp/agent-relay-dev

# Broadcast to all
node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js inbox-write -t "*" -f Dashboard -m "MESSAGE" -d /tmp/agent-relay-dev
```

**TIP:** Create an alias: `alias ar='node /Users/khaliqgant/Projects/prpm/agent-relay/dist/cli/index.js'`

### Protocol
- `STATUS: <what you're doing>` - Progress update
- `DONE: <task>` - Task completed
- `QUESTION: @AgentName <question>` - Ask teammate
- `BLOCKER: <issue>` - Blocked

## Example Dashboard Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Agent-Relay Dashboard                    [Watching: /tmp/] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  AGENTS                    MESSAGE FLOW                     │
│  ┌──────────────────┐     ┌─────────────────────────────┐  │
│  │ ● DocWriter      │     │  DocWriter ──→ CodePolish   │  │
│  │   Last: 2s ago   │     │  CodePolish ──→ DevOps      │  │
│  │ ● CodePolish     │     │  DevOps ──→ * (broadcast)   │  │
│  │   Last: 5s ago   │     │  Dashboard ──→ DocWriter    │  │
│  │ ● DevOps         │     └─────────────────────────────┘  │
│  │   Last: 10s ago  │                                      │
│  │ ○ Dashboard      │     ACTIVITY LOG                     │
│  │   (you)          │     ┌─────────────────────────────┐  │
│  └──────────────────┘     │ 12:01 DocWriter→CodePolish  │  │
│                           │ "STATUS: Reviewing README"  │  │
│                           │ 12:02 CodePolish→*          │  │
│                           │ "DONE: Added 5 new tests"   │  │
│                           └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## START NOW
1. Read the release plan: `cat /tmp/agent-relay-dev/PUBLIC_RELEASE_PLAN.md`
2. Broadcast your start: `STATUS: Dashboard starting, designing web UI architecture`
3. Begin by creating the directory structure
4. Check inbox periodically for teammate messages
EOF

echo "Created development team files:"
echo "  - $DEV_DIR/PUBLIC_RELEASE_PLAN.md"
echo "  - $DEV_DIR/$AGENT_1/INSTRUCTIONS.md (Claude - Documentation)"
echo "  - $DEV_DIR/$AGENT_2/INSTRUCTIONS.md (Claude - Code Quality)"
echo "  - $DEV_DIR/$AGENT_3/INSTRUCTIONS.md (Codex - DevOps)"
echo "  - $DEV_DIR/$AGENT_4/INSTRUCTIONS.md (Gemini - Dashboard)"
echo ""
echo "=== TO START DEVELOPMENT ==="
echo ""
echo "Make sure agent-relay is built:"
echo "  cd $REPO_DIR"
echo "  npm run build"
echo ""
echo "Open FOUR terminal windows:"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Terminal 1 - DocWriter (Claude):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  cd $REPO_DIR"
echo "  claude"
echo ""
echo "  Then say:"
echo "  Read /tmp/agent-relay-dev/DocWriter/INSTRUCTIONS.md and start working on agent-relay documentation"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Terminal 2 - CodePolish (Claude):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  cd $REPO_DIR"
echo "  claude"
echo ""
echo "  Then say:"
echo "  Read /tmp/agent-relay-dev/CodePolish/INSTRUCTIONS.md and start working on agent-relay code quality"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Terminal 3 - DevOps (Codex):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  cd $REPO_DIR"
echo "  codex"
echo ""
echo "  Then say:"
echo "  Read /tmp/agent-relay-dev/DevOps/INSTRUCTIONS.md and start working on agent-relay CI/CD and publishing"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Terminal 4 - Dashboard (Gemini):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  cd $REPO_DIR"
echo "  gemini"
echo ""
echo "  Then say:"
echo "  Read /tmp/agent-relay-dev/Dashboard/INSTRUCTIONS.md and start building the agent-relay web dashboard"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The four agents will coordinate via /tmp/agent-relay-dev/ inboxes!"
echo ""
