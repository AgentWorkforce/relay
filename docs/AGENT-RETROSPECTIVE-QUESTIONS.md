# Agent Retrospective Questions

Questions to ask agents after completing significant tasks. Use these in post-task reviews to gather feedback for improving agent tooling and workflows.

## When to Ask

- After completing a multi-step implementation
- After resolving a complex bug
- After any task taking >30 minutes
- When an agent reports frustration or blockers

## Question Categories

### 1. Code Discovery & Navigation

**Context Understanding**
- How did you find the relevant code for this task?
- Did you have to read many files before finding what you needed?
- Were there files you read that turned out to be irrelevant?

**Structural Analysis**
- Did you need to understand "what calls this function"?
- Did you need to understand "what does this function call"?
- Did you wish you knew the impact of your changes before making them?
- Would a call graph have helped you understand the codebase faster?

**Semantic Search**
- Did you search for code by concept rather than exact keywords?
- Were there times grep/find failed but you knew the code existed?
- How useful was `->relay:code search` (if you used it)?

### 2. Context & Token Efficiency

**Context Window**
- Did you run into context limitations?
- Did you have to re-read files you'd already seen?
- Were there moments where you lost track of earlier context?

**Token Usage**
- Did you read entire files when you only needed a function?
- Would function signatures + call context have been enough?
- How much of what you read was actually useful?

### 3. Collaboration & Coordination

**Agent-to-Agent**
- Did you need information from another agent?
- Was relay messaging effective for your needs?
- Were there coordination gaps or delays?

**Task Handoff**
- Was the task description clear enough?
- Did you have enough context to start immediately?
- What context was missing that you had to discover?

### 4. Tooling & Capabilities

**Missing Tools**
- What tool or capability would have made this easier?
- Were there repetitive actions you wished were automated?
- Did you work around any limitations?

**Existing Tools**
- Which tools were most helpful?
- Which tools were confusing or unhelpful?
- Any tools you avoided and why?

### 5. Decision Points

**Choices Made**
- What was the hardest decision you made?
- Were there alternatives you considered but rejected?
- What would you do differently next time?

**Uncertainty**
- Where were you most uncertain?
- What assumptions did you make?
- What would have increased your confidence?

---

## Quick Retro Template

For leads to use after delegating a task:

```markdown
## Quick Retro: [Task Name]

1. **What went well?**

2. **What was harder than expected?**

3. **Code discovery**: Did you wish you had:
   - [ ] Call graph (what calls what)
   - [ ] Impact analysis (what breaks if I change X)
   - [ ] Better semantic search
   - [ ] More context at start

4. **Tooling gap**: What's ONE tool that would have helped?

5. **For next time**: What context should the lead provide?
```

---

## Specific Feature Validation Questions

### Call Graph / Structural Analysis

Use these to validate whether to build `@agent-relay/code-graph`:

1. "Did you need to trace function calls to understand the code?"
2. "Did you manually search for 'who calls X' at any point?"
3. "Before making a change, did you worry about breaking callers?"
4. "Would seeing a visual call graph have saved time?"
5. "On a scale of 1-5, how much would impact analysis help?"

**Decision criteria**:
- If >50% of retros mention needing call graphs → Build it
- If <20% mention it → Defer indefinitely
- If 20-50% → Gather more data

### Semantic Search (osgrep)

1. "Did you use `->relay:code search`? Why or why not?"
2. "Were the results relevant to what you needed?"
3. "How did search compare to manual file exploration?"
4. "What queries worked well? What queries failed?"

### Context Injection

1. "Was the auto-discovered code at session start helpful?"
2. "Did it point you in the right direction?"
3. "Was any of it irrelevant noise?"
4. "What additional context would have helped at start?"

---

## Aggregating Feedback

Track patterns across retros:

```markdown
## Retro Summary: [Week/Sprint]

### Code Discovery
- Agents needing call graphs: X/Y (Z%)
- Semantic search usage: X/Y (Z%)
- Average files read before finding target: N

### Top Requested Features
1. [Feature] - mentioned X times
2. [Feature] - mentioned X times
3. [Feature] - mentioned X times

### Top Pain Points
1. [Pain point] - mentioned X times
2. [Pain point] - mentioned X times

### Decisions
- [ ] Build call graph: YES/NO/DEFER
- [ ] Improve semantic search: YES/NO
- [ ] Other actions: ...
```

---

## Anti-Patterns to Watch For

| Signal | Might Indicate |
|--------|----------------|
| "I read 20 files to find X" | Need better search/indexing |
| "I wasn't sure what would break" | Need impact analysis |
| "I had to ask Lead for context" | Need better task descriptions |
| "I kept losing context" | Need better continuity/handoffs |
| "I did the same thing 5 times" | Need automation/tooling |
| "I wasn't sure which approach" | Need architectural guidance |

---

## Integration with Trail

If using Trail for trajectories, these questions become decision points:

```bash
trail decision "Agent reported needing call graphs" \
  --reasoning "3/5 retros mentioned 'who calls this function'"

trail decision "Deferring call graph implementation" \
  --reasoning "Only 2/10 retros mentioned needing it"
```
