# Every Code (just-every/code) vs Agent Relay: Competitive Analysis

A comprehensive comparison of multi-agent orchestration approaches, focusing on Every Code's unique consensus/racing strategies and ecosystem.

---

## Executive Summary

| Dimension | Every Code | Agent Relay |
|-----------|------------|-------------|
| **Primary Language** | TypeScript + Rust | TypeScript/Node.js |
| **Core Philosophy** | Multi-LLM consensus ("best answer wins") | Real-time messaging ("peer-to-peer communication") |
| **Communication** | Racing/consensus patterns | Unix socket + PTY injection |
| **Agent Strategy** | Model diversity (Claude, GPT, Gemini) | Agent diversity (multiple instances) |
| **Orchestration** | Built-in `/plan`, `/solve`, `/code` | Flexible, user-defined |
| **Browser Integration** | Native CDP + headless | None built-in |
| **API Key Required** | Yes (multi-provider) | No (wraps existing CLI) |
| **Stars** | 3,000+ | - |
| **Forks** | 7,100+ (Codex heritage) | - |

**Key Finding:** Every Code takes a fundamentally different approach - orchestrating multiple *LLM providers* for consensus rather than multiple *agent instances* for collaboration. It's optimized for **quality assurance** through model diversity, while Agent Relay is optimized for **task parallelism** through agent collaboration.

---

## 1. Architectural Philosophy

### Every Code: "The Committee Model"

Every Code treats AI coding as a **quality problem** solved by ensemble decision-making:

```
┌─────────────────────────────────────────────────────────────┐
│                    User Request                              │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Strategy Router                            │
│         /plan (consensus) | /solve (race) | /code           │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│    Claude     │ │     GPT-5     │ │    Gemini     │
│   (Anthropic) │ │   (OpenAI)    │ │   (Google)    │
└───────┬───────┘ └───────┬───────┘ └───────┬───────┘
        │                 │                 │
        └─────────────────┼─────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Result Aggregation                              │
│     Consensus voting | First-wins racing | Best-of-N        │
└─────────────────────────────────────────────────────────────┘
```

**Core Principles:**
1. **Model Diversity** - Different LLMs have different strengths
2. **Quality Through Consensus** - Multiple models agree = higher confidence
3. **Racing for Speed** - Sometimes fastest correct answer wins
4. **Self-Healing** - Auto Drive retries and recovers from failures

### Agent Relay: "The Team Model"

Agent Relay treats AI coding as a **collaboration problem** solved by agent communication:

```
┌─────────────────────────────────────────────────────────────┐
│                      DAEMON (Router)                         │
│              Unix Socket + WebSocket Server                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
   ▼                      ▼                      ▼
┌──────────┐       ┌──────────┐          ┌──────────┐
│  Lead    │ ←───→ │  Worker  │ ←──────→ │ Reviewer │
│ (Claude) │       │ (Claude) │          │ (Claude) │
└──────────┘       └──────────┘          └──────────┘
       ↑                                       │
       └───────────────────────────────────────┘
              Direct peer-to-peer messaging
```

**Core Principles:**
1. **Agent Specialization** - Different agents handle different roles
2. **Real-Time Communication** - <5ms latency via Unix socket
3. **Flexible Topology** - Any team structure, not prescribed
4. **Zero CLI Modification** - Works with existing Claude/Codex

---

## 2. Multi-Agent Strategies

### Every Code: Orchestration Commands

**`/plan` - Consensus Strategy:**
```
User: /plan implement user authentication

Every Code:
├── Claude: "JWT with refresh tokens, bcrypt hashing..."
├── GPT-5: "Session-based auth, Redis store..."
└── Gemini: "OAuth 2.0 with PKCE flow..."

Consensus: All agree on JWT approach, synthesize best practices
Output: Unified implementation plan
```

**`/solve` - Racing Strategy:**
```
User: /solve fix the login bug

Every Code:
├── Claude: [working...]
├── GPT-5: [DONE in 12s] ← Winner
└── Gemini: [working...]

Output: GPT-5's solution (first correct answer)
```

**`/code` - Implementation Strategy:**
```
User: /code implement the auth module

Every Code:
├── Creates multiple git worktrees
├── Each model implements independently
├── Compares results
└── Merges best implementation
```

**Auto Drive - Autonomous Mode:**
- Chains tasks automatically
- Self-healing on failures
- Continues until completion or human intervention

**Auto Review - Background QA:**
- Ghost-commit watcher using `codex-5.1-mini-high`
- Reviews code in separate worktrees
- Runs in parallel with Auto Drive

### Agent Relay: Message-Based Coordination

```
->relay:Lead TASK: Implement user authentication

->relay:Worker ACK: Starting JWT implementation

->relay:Reviewer REVIEW: Please check src/auth/jwt.ts

->relay:Lead DONE: Auth module complete with tests passing
```

**No prescribed strategies** - teams define their own:
- Lead-worker patterns
- Peer review workflows
- Hierarchical delegation
- Broadcast discussions

**Comparison:**

| Aspect | Every Code | Agent Relay |
|--------|------------|-------------|
| **Unit of Diversity** | LLM providers | Agent instances |
| **Strategy Definition** | Built-in commands | User-defined conventions |
| **Quality Mechanism** | Model consensus | Peer review |
| **Speed Mechanism** | Racing | Parallel task assignment |
| **Recovery** | Auto Drive self-healing | Manual or webhook-based |

---

## 3. The Ensemble Ecosystem

Every Code is part of a larger ecosystem of related projects:

### Ensemble (just-every/ensemble)

**Multi-LLM abstraction layer:**
- Unified API across OpenAI, Anthropic, Google, DeepSeek, xAI, OpenRouter
- Streaming architecture with standardized events
- Tool execution with timeout handling
- Automatic model rotation and fallback
- Cost tracking built-in

```typescript
// Ensemble enables Every Code's multi-model strategies
import { streamChat } from '@just-every/ensemble';

const response = await streamChat({
  model: 'claude-3-opus',
  messages: [...],
  fallbackModels: ['gpt-4', 'gemini-pro']
});
```

### MAGI (just-every/magi)

**Autonomous AI system:**
- "Mostly Autonomous Generative Intelligence"
- Specialized agents: Code, Browser, Shell, Search, Reasoning, Supervisor
- Docker container isolation per agent
- Emphasizes quality over speed
- Self-improvement through learning

**Relationship:** MAGI appears to be a more autonomous/research-oriented sibling, while Every Code is the practical developer tool.

### Relationship to OpenAI Codex

Every Code is a **community fork of Codex CLI** that:
- Maintains upstream compatibility
- Adds multi-model orchestration
- Extends with browser automation
- Includes quality assurance features

---

## 4. Unique Features

### Browser Integration

**Every Code - Native CDP Support:**
```typescript
// External browser via Chrome DevTools Protocol
await browser.connectCDP('http://localhost:9222');

// Or internal headless browser
const screenshot = await browser.capture();
// Screenshot appears inline in terminal
```

**Use Cases:**
- Visual debugging
- UI testing automation
- Screenshot capture for context
- Live page interaction

**Agent Relay:** No built-in browser integration. Would require MCP server or external tool.

### Auto Review (v0.6.0+)

**Background quality watcher:**
```
┌─────────────────────────────────────────────────────────────┐
│                    Main Session                              │
│  User: "Implement the payment flow"                          │
│  Auto Drive: [working in main worktree...]                  │
└─────────────────────────────────────────────────────────────┘
                          │ parallel
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Auto Review (Background)                    │
│  Ghost commits: [watching for changes...]                    │
│  Separate worktree with codex-5.1-mini-high                 │
│  Reviewing: src/payments/checkout.ts                        │
│  Status: "Consider adding error handling for network..."    │
└─────────────────────────────────────────────────────────────┘
```

**Agent Relay Equivalent:** Would require spawning a dedicated Reviewer agent with `->relay:spawn Reviewer claude "Watch and review changes"`

### Code Bridge MCP Server

Streams errors and console output from running applications:
```
Application: [Error] TypeError: Cannot read property 'user' of undefined
    at checkout.ts:45

Code Bridge → LLM: "I see a TypeError in checkout.ts line 45..."
```

---

## 5. Technical Architecture

### Every Code Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Interface                             │
│              npx @just-every/code                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Node.js Layer                             │
│  • Terminal UI (Ink/React)                                  │
│  • Strategy router (/plan, /solve, /code)                   │
│  • MCP client integration                                    │
│  • Browser automation                                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Rust Core                                 │
│  • code-rs/codex-rs workspace                               │
│  • Sandbox (seatbelt/landlock)                              │
│  • Process execution                                         │
│  • File operations                                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Ensemble Layer                            │
│  • Multi-provider abstraction                               │
│  • Streaming and events                                      │
│  • Cost tracking                                             │
│  • Model fallback                                            │
└─────────────────────────────────────────────────────────────┘
```

**Key Technical Choices:**
- **Rust for sandboxing** - Security-critical operations in memory-safe language
- **Node.js for UI** - Rich terminal interface with Ink/React
- **pnpm workspaces** - Monorepo management
- **Apache 2.0 license** - Permissive open source

### Agent Relay Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Interface                             │
│              agent-relay wrap/spawn/up                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Daemon Layer                              │
│  • Unix Domain Socket                                        │
│  • WebSocket server (dashboard)                              │
│  • Message routing                                           │
│  • Agent registry                                            │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    PTY Wrapper                               │
│  • Pattern detection (->relay:)                             │
│  • Message injection                                         │
│  • Continuity management                                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Storage Layer                             │
│  • SQLite (messages, agents)                                │
│  • Optional cloud sync                                       │
│  • Ledger for continuity                                     │
└─────────────────────────────────────────────────────────────┘
```

**Comparison:**

| Aspect | Every Code | Agent Relay |
|--------|------------|-------------|
| **Language** | TypeScript + Rust | TypeScript |
| **Sandboxing** | Native (seatbelt/landlock) | None (relies on CLI) |
| **IPC** | Ensemble events | Unix socket |
| **Storage** | Session-based | SQLite persistent |
| **Build** | Cargo + pnpm | npm only |
| **Complexity** | High (polyglot) | Moderate |

---

## 6. Pros & Cons

### Every Code

**Pros:**
1. **Model diversity** - Multiple LLMs reduce blind spots
2. **Quality assurance** - Consensus and Auto Review catch issues
3. **Browser integration** - Visual debugging and automation
4. **Self-healing** - Auto Drive recovers from failures
5. **Codex heritage** - Battle-tested foundation with 7k+ forks
6. **Active development** - Multiple releases per week
7. **Sandbox security** - Rust-based isolation

**Cons:**
1. **Multiple API keys required** - Need accounts with multiple providers
2. **Cost accumulation** - Multiple models = multiple charges
3. **No persistent collaboration** - Session-based, not ongoing teams
4. **Complexity** - Polyglot codebase harder to contribute to
5. **Provider dependency** - Tied to commercial LLM APIs
6. **Single-user focus** - Not designed for agent teams

### Agent Relay

**Pros:**
1. **No API keys needed** - Wraps existing CLI authentication
2. **Real-time messaging** - <5ms latency
3. **Persistent teams** - Agents collaborate over time
4. **Flexible topology** - Any team structure
5. **Simple architecture** - Pure TypeScript
6. **Session continuity** - Survives disconnects

**Cons:**
1. **No model diversity** - Single provider per agent
2. **No built-in QA** - Quality depends on team conventions
3. **No browser integration** - Would need MCP server
4. **Manual orchestration** - No `/plan`, `/solve` commands
5. **Less mature** - Newer project

---

## 7. Key Learnings for Relay

### Ideas to Adopt

1. **Racing Strategy for Speed**
   ```
   ->relay:race Worker1,Worker2,Worker3 "Fix the login bug"

   # First agent to report DONE wins, others are interrupted
   # Useful when correctness is easily verified
   ```

2. **Consensus Strategy for Quality**
   ```
   ->relay:consensus Worker1,Worker2,Worker3 "Design the auth architecture"

   # All agents contribute, lead synthesizes common patterns
   # Useful for architectural decisions
   ```

3. **Auto Review Pattern**
   ```
   ->relay:spawn Reviewer claude --watch "Review all changes in src/"

   # Background agent that monitors file changes
   # Sends review comments via relay messages
   ```

4. **Browser Integration via MCP**
   ```yaml
   # Could integrate puppeteer-mcp-server
   mcp_servers:
     - name: browser
       command: npx puppeteer-mcp-server
   ```

5. **Model Diversity Option**
   ```
   # Allow different agents to use different models
   ->relay:spawn GeminiWorker gemini "Implement the search feature"
   ->relay:spawn ClaudeWorker claude "Implement the auth feature"
   ```

### Ideas to Evaluate

1. **Built-in Strategy Commands**
   - Pro: Easier to use for common patterns
   - Con: Less flexible, more opinionated
   - Verdict: **Consider as optional add-on**, not core

2. **Polyglot Architecture (Rust + TS)**
   - Pro: Better sandboxing security
   - Con: Higher contribution barrier
   - Verdict: **Not needed** - we rely on CLI's sandboxing

3. **Cost Tracking**
   - Pro: Visibility into API spend
   - Con: Complexity, we don't call APIs directly
   - Verdict: **Could add** at dashboard level by parsing agent output

---

## 8. Architectural Recommendations

### Short-term: Add Racing/Consensus Patterns

```typescript
// New relay commands for orchestration strategies

// Racing: First to complete wins
->relay:race Alice,Bob,Carol <<<
TASK: Fix the memory leak in src/cache.ts
CRITERIA: Tests must pass>>>

// Consensus: Synthesize multiple solutions
->relay:consensus Alice,Bob,Carol <<<
TASK: Design the database schema for user profiles
OUTPUT: Combined recommendation>>>
```

**Implementation:**
1. Lead receives `->relay:race` command
2. Spawns N agents with same task
3. First `DONE:` message triggers completion
4. Other agents receive `ABORT:` signal

### Medium-term: Background Watcher Pattern

```typescript
// Spawn a watcher agent that monitors file changes
->relay:watch Reviewer <<<
PATHS: src/**/*.ts
ON_CHANGE: Review the changed file for issues
REPORT_TO: Lead>>>

// Watcher uses inotify/fsevents under the hood
// Sends messages when files change
```

### Long-term: Model Diversity Layer

```yaml
# .relay/agents.yaml
agents:
  architect:
    model: claude-opus
    role: "High-level design decisions"

  implementer:
    model: claude-sonnet
    role: "Code implementation"

  reviewer:
    model: gemini-pro
    role: "Alternative perspective on code review"
```

**Value:** Different models catch different issues (Every Code's key insight), but applied to *role diversity* rather than *task diversity*.

---

## 9. Competitive Positioning

### Where Every Code Wins

| Use Case | Why Every Code |
|----------|----------------|
| **Single complex task** | Consensus ensures quality |
| **Speed-critical fixes** | Racing gets fastest answer |
| **Visual debugging** | Browser integration |
| **Self-contained work** | Auto Drive handles autonomously |
| **Multi-model insights** | Different LLMs catch different issues |

### Where Agent Relay Wins

| Use Case | Why Agent Relay |
|----------|-----------------|
| **Ongoing collaboration** | Persistent teams over time |
| **Complex multi-step projects** | Agents coordinate on dependencies |
| **Custom workflows** | Flexible topology, not prescribed |
| **Cost sensitivity** | No multiple API key requirement |
| **Team communication** | Real-time messaging optimized |

### Hybrid Opportunity

These tools solve **different problems** and could be complementary:

```
┌─────────────────────────────────────────────────────────────┐
│                    Project Pipeline                          │
├─────────────────────────────────────────────────────────────┤
│  1. PLANNING PHASE (Agent Relay)                            │
│     Lead + Architect + PM discuss approach                  │
│     Real-time collaboration, async standups                 │
│                                                              │
│  2. IMPLEMENTATION PHASE (Every Code)                       │
│     Each agent uses Every Code for their tasks              │
│     /plan for design, /solve for bugs, /code for impl       │
│                                                              │
│  3. REVIEW PHASE (Agent Relay)                              │
│     Reviewer agents discuss changes                         │
│     Cross-agent code review via messaging                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Summary Matrix

| Dimension | Every Code | Agent Relay | Winner |
|-----------|------------|-------------|--------|
| **Multi-model orchestration** | Native | None | Every Code |
| **Agent-to-agent messaging** | None | Native | Agent Relay |
| **Quality assurance** | Consensus + Auto Review | Peer review convention | Every Code |
| **Speed optimization** | Racing pattern | Parallel agents | Tie |
| **Browser automation** | Native CDP | None | Every Code |
| **Cost efficiency** | High (multiple APIs) | Low (single CLI) | Agent Relay |
| **Team persistence** | Session-based | Persistent | Agent Relay |
| **Flexibility** | Prescribed strategies | Any topology | Agent Relay |
| **Setup complexity** | Moderate | Low | Agent Relay |
| **Maturity** | High (Codex fork) | Moderate | Every Code |

### Overall Assessment

**Every Code is best for:**
- Individual developers wanting quality assurance
- Tasks where model consensus matters
- Visual debugging workflows
- Self-contained autonomous work

**Agent Relay is best for:**
- Teams of agents working together
- Long-running collaborative projects
- Custom workflow requirements
- Cost-conscious deployments

**These are complementary, not competitive.** Every Code optimizes *individual task quality* through model diversity; Agent Relay optimizes *team coordination* through real-time messaging.

---

## 11. Conclusion

Every Code and Agent Relay represent two different philosophies for AI-assisted development:

**Every Code:** "Get the best answer by asking multiple experts (models)"
- Model diversity for quality assurance
- Racing/consensus for strategy selection
- Browser integration for visual feedback
- Self-healing for autonomous operation

**Agent Relay:** "Build the best solution by having experts (agents) collaborate"
- Agent diversity for role specialization
- Real-time messaging for coordination
- Flexible topology for custom workflows
- Persistent teams for ongoing projects

### Recommendation

**Adopt from Every Code:**
1. Racing pattern for speed-critical tasks
2. Consensus pattern for architectural decisions
3. Background watcher for continuous review
4. Browser integration via MCP

**Maintain Agent Relay's Strengths:**
1. Real-time messaging (<5ms)
2. Flexible team topology
3. No API key requirement
4. Session continuity

**Consider Integration:**
- Every Code as a tool *within* an Agent Relay workflow
- Agents use Every Code's `/solve` for their individual tasks
- Agent Relay coordinates the overall project

---

*Analysis generated 2026-01-06*
*Based on just-every/code v0.6.38, just-every/ensemble, and just-every/magi*
