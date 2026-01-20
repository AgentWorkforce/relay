/**
 * Blog post data for Agent Relay
 */

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  author: string;
  date: string;
  readTime: string;
  tags: string[];
  featured?: boolean;
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'messaging-vs-skills',
    title: 'Real-Time Messaging vs Skills: When to Use Each',
    excerpt: 'Why use real-time agent messaging when skills can do the same thing more deterministically? We break down the trade-offs.',
    author: 'Agent Relay Team',
    date: '2026-01-13',
    readTime: '5 min read',
    tags: ['Architecture', 'Best Practices'],
    featured: true,
    content: `
# Real-Time Messaging vs Skills: When to Use Each

A common question we get: *"Why use real-time messaging when skills can do the same thing more deterministically?"*

It's a great architectural question. Let's break down the trade-offs.

## Skills vs Real-Time Messaging

**Skills** extend a single agent's capabilities deterministically:
- Loaded into context on demand
- Clear input/output contracts
- Reproducible, predictable behavior
- Single agent, single context window

**Real-time messaging** coordinates multiple autonomous agents:
- Parallel execution across agents
- Asynchronous, event-driven
- Dynamic collaboration patterns
- Each agent has its own context/specialization

## When Messaging Wins

### 1. Parallelization

5 agents working simultaneously on different modules beats 1 agent doing them sequentially. Skills can't parallelize work across context windows.

\`\`\`
Lead Agent
   ├── Backend Agent (API routes)
   ├── Frontend Agent (UI components)
   ├── Database Agent (schema design)
   ├── Test Agent (test coverage)
   └── Docs Agent (documentation)
\`\`\`

### 2. Context Isolation

Each agent maintains its own full context. A frontend agent has deep React knowledge loaded; a backend agent has database patterns loaded. Skills share one context window and compete for space.

### 3. Long-running Coordination

A lead agent spawns workers, checks on progress, handles blockers dynamically. Skills are one-shot invocations, not ongoing collaboration.

\`\`\`
Lead: "Start auth module implementation"
Backend: "ACK. Setting up JWT middleware."
Frontend: "ACK. Creating login UI."
Backend: "API ready at /api/auth"
Frontend: "Integrating. Need CORS headers."
Backend: "Done. CORS configured."
Reviewer: "Found issue: passwords not hashed"
Backend: "Fixed. Using bcrypt."
Lead: "Auth complete. Moving to dashboard."
\`\`\`

### 4. Emergent Behavior

Agents can negotiate, ask clarifying questions, report unexpected issues. Skills execute a predetermined path.

### 5. Specialization at Scale

You can have 10 specialized agents with different system prompts and tool access. Skills are generic capability extensions.

## When Skills Win

### 1. Determinism

If you need reproducible, testable behavior—use skills.

### 2. Simple Tasks

Single-agent work that doesn't benefit from parallelization.

### 3. Tight Coupling

When the "caller" needs immediate, synchronous results.

### 4. Lower Overhead

No daemon, no message routing, no coordination protocol.

## The Real Answer

They're complementary, not competing:

\`\`\`
Skills = vertical capability extension (one agent, deeper abilities)
Messaging = horizontal coordination (many agents, parallel work)
\`\`\`

An agent can use skills internally while coordinating with peers via messaging. The question is whether your workload benefits from parallelization and specialization enough to justify the coordination overhead.

## Decision Framework

Ask yourself:

1. **Can work be parallelized?** → Messaging
2. **Do I need multiple specialized contexts?** → Messaging
3. **Is coordination ongoing or one-shot?** → Ongoing = Messaging
4. **Do I need deterministic, testable behavior?** → Skills
5. **Is overhead a concern?** → Skills

Most real-world agent systems use both: skills for individual agent capabilities, messaging for multi-agent coordination.

---

*Have questions about agent architecture? [Join our Discord](https://discord.gg/agentrelay) or [reach out on Twitter](https://twitter.com/agent_relay).*
    `.trim(),
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function getFeaturedPosts(): BlogPost[] {
  return BLOG_POSTS.filter((post) => post.featured);
}

export function getRecentPosts(count: number = 3): BlogPost[] {
  return [...BLOG_POSTS]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, count);
}
