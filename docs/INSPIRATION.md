# Inspiration & Attribution

This document acknowledges projects and ideas that have inspired features in agent-relay.

## russian-code-ts

**Repository:** https://codeberg.org/GrigoryEvko/russian-code-ts

A community-driven reimplementation of Claude Code CLI that provided inspiration for several performance and reliability features added to agent-relay.

### Features Inspired

| Feature | Inspiration | Our Implementation |
|---------|-------------|-------------------|
| **Precompiled Regex Patterns** | Their <1ms performance targets for permission matching | `src/utils/precompiled-patterns.ts` - Combined instructional markers into single regex, module-level caching |
| **Agent Authentication** | Their planned agent identity verification system | `src/daemon/agent-signing.ts` - HMAC-SHA256 signing with key rotation support |
| **Dead Letter Queue** | Their reliability patterns for message handling | `src/storage/dlq-adapter.ts` - Adapter pattern for SQLite/PostgreSQL/In-memory |
| **Context Compaction** | Their context window management approach | `src/memory/context-compaction.ts` - Token estimation and importance-weighted retention |
| **Consensus Mechanism** | Their planned agent swarm coordination features | `src/daemon/consensus.ts` - Multiple voting strategies for agent decision-making |

### Key Technical Insights

From russian-code-ts we learned:

1. **Performance Optimization**: Pre-compiling regex patterns at module load time rather than per-call dramatically improves throughput for high-frequency operations like message routing.

2. **Storage Abstraction**: Using adapter patterns allows the same code to run in local development (SQLite) and cloud production (PostgreSQL) without modification.

3. **Agent Identity**: As agent systems scale, cryptographic identity verification becomes essential for trust in multi-agent environments.

4. **Context Management**: Token-aware context compaction is critical for long-running agent sessions to maintain coherent conversations.

---

## Contributing

If you've drawn inspiration from other projects for features you're contributing, please add them to this document with:

- Project name and link
- What feature(s) were inspired
- What specific insights were gained

Proper attribution helps maintain a collaborative open source ecosystem.
