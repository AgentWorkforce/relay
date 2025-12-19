# Agent-Relay Public Release Plan

## Goal
Prepare agent-relay for public release on npm and GitHub with comprehensive documentation, examples, and polish.

## Team Structure

### Agent 1: DocWriter (Claude) - Documentation & Examples
**Focus:** User-facing content, tutorials, examples
**Workdir:** `/Users/khaliqgant/Projects/prpm/agent-relay`

Tasks:
- [ ] Review and improve README.md
  - Add GIF/video demo placeholder
  - Improve quick start section
  - Add "Common Use Cases" section
- [ ] Create docs/CONTRIBUTING.md
- [ ] Create examples/ directory with:
  - [ ] examples/basic-chat/ - Two agents chatting
  - [ ] examples/tic-tac-toe/ - Simple game
  - [ ] examples/collaborative-coding/ - Agents working together
- [ ] Update CLI --help text for all commands
- [ ] Document the new inbox-* commands
- [ ] Create API.md documenting the protocol

### Agent 2: CodePolish (Claude) - Code Quality & Tests
**Focus:** Test coverage, error handling, code cleanup
**Workdir:** `/Users/khaliqgant/Projects/prpm/agent-relay`

Tasks:
- [ ] Audit test coverage - identify gaps
- [ ] Add tests for new inbox-poll/write/agents commands
- [ ] Improve error messages (user-friendly)
- [ ] Add input validation to CLI commands
- [ ] Clean up console.log statements (use proper logging)
- [ ] Remove dead code and unused files
- [ ] Review and fix any TypeScript strict mode issues
- [ ] Add JSDoc comments to public APIs

### Agent 3: DevOps (Codex) - CI/CD & Publishing
**Focus:** Build, publish, installation
**Workdir:** `/Users/khaliqgant/Projects/prpm/agent-relay`

Tasks:
- [ ] Review and improve package.json
  - Verify all fields for npm publish
  - Add repository, bugs, homepage URLs
  - Review dependencies (prune unused)
- [ ] Enhance GitHub Actions workflow
  - Add npm publish on release
  - Add test coverage reporting
  - Add build badge to README
- [ ] Review install.sh script
  - Test on clean systems
  - Improve error handling
- [ ] Add LICENSE file (MIT)
- [ ] Create docs/CHANGELOG.md
- [ ] Test npm pack / npm publish --dry-run
- [ ] Set up GitHub release automation

## Coordination Protocol

Agents communicate via `/tmp/agent-relay-dev/`:
- DocWriter, CodePolish, DevOps each have inbox directories
- Use `agent-relay inbox-*` commands

### Message Types
- `STATUS: <doing what>` - Progress update
- `QUESTION: <question>` - Need input from another agent
- `DONE: <task>` - Task completed
- `BLOCKER: <issue>` - Blocked on something
- `HANDOFF: <what>` - Passing work to another agent

### Coordination Rules
1. Before editing a file, announce: `STATUS: Editing <filename>`
2. After completing a task, broadcast: `DONE: <task description>`
3. If blocked, ask: `QUESTION: @AgentName <question>`
4. Check inbox after each major task

## Success Criteria
- [ ] npm install agent-relay works
- [ ] All CLI commands have --help
- [ ] README has working quick start
- [ ] 3+ working examples
- [ ] Test coverage > 80%
- [ ] No TypeScript errors in strict mode
- [ ] GitHub Actions green
- [ ] Clean npm audit
