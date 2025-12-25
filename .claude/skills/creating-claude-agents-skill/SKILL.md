---
name: creating-claude-agents
description: Use when creating or improving Claude Code agents. Expert guidance on agent file structure, frontmatter, persona definition, tool access, model selection, and validation against schema.
---

# Creating Claude Code Agents - Expert Skill

Use this skill when creating or improving Claude Code agents. Provides comprehensive guidance on agent structure, schema validation, and best practices for building long-running AI assistants.

## When to Use This Skill

Activate this skill when:
- User asks to create a new Claude Code agent
- User wants to improve an existing agent
- User needs help with agent frontmatter or structure
- User is troubleshooting agent validation issues
- User wants to understand agent format requirements
- User asks about agent vs skill vs slash command differences

## Quick Reference

### Agent File Structure

```markdown
---
name: agent-name
description: When and why to use this agent
allowed-tools: Read, Write, Bash
model: sonnet
agentType: agent
---

# 🔍 Agent Display Name

You are [persona definition - describe the agent's role and expertise].

## Instructions

[Clear, actionable guidance on what the agent does]

## Process

[Step-by-step workflow the agent follows]

## Examples

[Code samples and use cases demonstrating the agent's capabilities]
```

### File Location

**Required Path:**
```
.claude/agents/*.md
```

Agents must be placed in `.claude/agents/` directory as markdown files.

## Frontmatter Requirements

### Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `name` | string | Agent identifier (lowercase, hyphens only) | `code-reviewer` |
| `description` | string | Brief overview of functionality and use cases | `Reviews code for best practices and potential issues` |

### Optional Fields

| Field | Type | Description | Values |
|-------|------|-------------|--------|
| `allowed-tools` | string | Comma-separated list of available tools | `Read, Write, Bash, WebSearch` |
| `model` | string | Claude model to use | `sonnet`, `opus`, `haiku`, `inherit` |
| `agentType` | string | Explicit marker for format preservation | `agent` |

### Validation Rules

**Name Field:**
- Pattern: `^[a-z0-9-]+$` (lowercase letters, numbers, hyphens only)
- Max length: 64 characters
- Example: ✅ `code-reviewer` ❌ `Code_Reviewer`

**Description Field:**
- Max length: 1024 characters
- Should clearly explain when to use the agent
- Start with action words: "Reviews...", "Analyzes...", "Helps with..."

**Allowed Tools:**
Valid tools: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `WebSearch`, `WebFetch`, `Task`, `Skill`, `SlashCommand`, `TodoWrite`, `AskUserQuestion`

**Model Values:**
- `sonnet` - Balanced, good for most agents (default)
- `opus` - Complex reasoning, architectural decisions
- `haiku` - Fast, simple tasks
- `inherit` - Use parent conversation's model

## Content Format Requirements

### H1 Heading (Required)

The first line of content must be an H1 heading that serves as the agent's display title:

```markdown
# 🔍 Code Reviewer
```

**Best Practices:**
- Include an emoji icon for visual distinction
- Use title case
- Keep concise (2-5 words)
- Make it descriptive and memorable

### Persona Definition (Required for Agents)

Immediately after the H1, define the agent's persona using "You are..." format:

```markdown
You are an expert code reviewer with deep knowledge of software engineering principles and security best practices.
```

**Guidelines:**
- Start with "You are..."
- Define role and expertise clearly
- Set expectations for the agent's capabilities
- Establish the agent's approach and tone

### Content Structure

```markdown
# 🔍 Agent Name

You are [persona definition].

## Instructions

[What the agent does and how it approaches tasks]

## Process

1. [Step 1]
2. [Step 2]
3. [Step 3]

## Examples

[Code samples showing good/bad patterns]

## Guidelines

- [Best practice 1]
- [Best practice 2]
```

## Schema Validation

Agents must conform to the JSON schema at:
`https://github.com/pr-pm/prpm/blob/main/packages/converters/schemas/claude-agent.schema.json`

### Schema Structure

```json
{
  "frontmatter": {
    "name": "string (required)",
    "description": "string (required)",
    "allowed-tools": "string (optional)",
    "model": "enum (optional)",
    "agentType": "agent (optional)"
  },
  "content": "string (markdown with H1, persona, instructions)"
}
```

### Common Validation Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Missing required field 'name' | Frontmatter lacks name field | Add `name: agent-name` |
| Missing required field 'description' | Frontmatter lacks description | Add `description: ...` |
| Invalid name pattern | Name contains uppercase or special chars | Use lowercase and hyphens only |
| Name too long | Name exceeds 64 characters | Shorten the name |
| Invalid model value | Model not in enum | Use: `sonnet`, `opus`, `haiku`, or `inherit` |
| Missing H1 heading | Content doesn't start with # | Add `# Agent Name` as first line |

## Tool Configuration

### Inheriting All Tools

Omit the `allowed-tools` field to inherit all tools from the parent conversation:

```yaml
---
name: full-access-agent
description: Agent needs access to everything
# No allowed-tools field = inherits all
---
```

### Specific Tools Only

Grant minimal necessary permissions:

```yaml
---
name: read-only-reviewer
description: Reviews code without making changes
allowed-tools: Read, Grep, Bash
---
```

### Bash Tool Restrictions

Use command patterns to restrict Bash access:

```yaml
---
name: git-helper
description: Git operations only
allowed-tools: Bash(git *), Read
---
```

**Syntax:**
- `Bash(git *)` - Only git commands
- `Bash(npm test:*)` - Only npm test scripts
- `Bash(git status:*)`, `Bash(git diff:*)` - Multiple specific commands

## Model Selection Guide

### Sonnet (Most Agents)

**Use for:**
- Code review
- Debugging
- Data analysis
- General problem-solving

```yaml
model: sonnet
```

### Opus (Complex Reasoning)

**Use for:**
- Architecture decisions
- Complex refactoring
- Deep security analysis
- Novel problem-solving

```yaml
model: opus
```

### Haiku (Speed Matters)

**Use for:**
- Syntax checks
- Simple formatting
- Quick validations
- Low-latency needs

```yaml
model: haiku
```

### Inherit (Context-Dependent)

**Use for:**
- Agent should match user's model choice
- Cost sensitivity

```yaml
model: inherit
```

## Common Mistakes

| Mistake | Problem | Solution |
|---------|---------|----------|
| Using `_` in name | Violates pattern constraint | Use hyphens: `code-reviewer` not `code_reviewer` |
| Uppercase in name | Violates pattern constraint | Lowercase only: `debugger` not `Debugger` |
| Missing persona | Agent lacks role definition | Add "You are..." after H1 |
| No H1 heading | Content format invalid | Start content with `# Agent Name` |
| Vague description | Agent won't activate correctly | Be specific about when to use |
| Too many tools | Security risk, violates least privilege | Grant only necessary tools |
| No agentType field | May lose type info in conversion | Add `agentType: agent` |
| Generic agent name | Conflicts or unclear purpose | Use specific, descriptive names |

## Best Practices

### 1. Write Clear, Specific Descriptions

The description determines when Claude automatically invokes your agent.

✅ **Good:**
```yaml
description: Reviews code changes for quality, security, and maintainability issues
```

❌ **Poor:**
```yaml
description: A helpful agent  # Too vague
```

### 2. Define Strong Personas

Establish expertise and approach immediately after the H1:

```markdown
# 🔍 Code Reviewer

You are an expert code reviewer specializing in TypeScript and React, with 10+ years of experience in security-focused development. You approach code review systematically, checking for security vulnerabilities, performance issues, and maintainability concerns.
```

### 3. Provide Step-by-Step Processes

Guide the agent's workflow explicitly:

```markdown
## Review Process

1. **Read the changes**
   - Get recent git diff or specified files
   - Understand the context and purpose

2. **Analyze systematically**
   - Check each category (quality, security, performance)
   - Provide specific file:line references
   - Explain why something is an issue

3. **Provide actionable feedback**
   - Categorize by severity
   - Include fix suggestions
   - Highlight positive patterns
```

### 4. Include Examples

Show both good and bad patterns:

```markdown
## Examples

When reviewing error handling:

❌ **Bad - Silent failure:**
\`\`\`typescript
try {
  await fetchData();
} catch (error) {
  console.log(error);
}
\`\`\`

✅ **Good - Proper error handling:**
\`\`\`typescript
try {
  await fetchData();
} catch (error) {
  logger.error('Failed to fetch data', error);
  throw new AppError('Data fetch failed', { cause: error });
}
\`\`\`
```

### 5. Use Icons in H1 for Visual Distinction

Choose emojis that represent the agent's purpose:

- 🔍 Code Reviewer
- 🐛 Debugger
- 📊 Data Scientist
- 🔒 Security Auditor
- ⚡ Performance Optimizer
- 📝 Documentation Writer
- 🧪 Test Generator

### 6. Maintain Single Responsibility

Each agent should excel at ONE specific task:

✅ **Good:**
- `code-reviewer` - Reviews code for quality and security
- `debugger` - Root cause analysis and minimal fixes

❌ **Poor:**
- `code-helper` - Reviews, debugs, tests, refactors, documents (too broad)

### 7. Grant Minimal Tool Access

Follow the principle of least privilege:

```yaml
# Read-only analysis agent
allowed-tools: Read, Grep

# Code modification agent
allowed-tools: Read, Edit, Bash(git *)

# Full development agent
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
```

### 8. Include agentType for Round-Trip Conversion

Always include `agentType: agent` in frontmatter to preserve type information during format conversions:

```yaml
---
name: code-reviewer
description: Reviews code for best practices
agentType: agent
---
```

## Example Agent Templates

### Minimal Agent

```markdown
---
name: simple-reviewer
description: Quick code review for common issues
allowed-tools: Read, Grep
model: haiku
agentType: agent
---

# 🔍 Simple Code Reviewer

You are a code reviewer focused on catching common mistakes quickly.

## Instructions

Review code for:
- Syntax errors
- Common anti-patterns
- Missing error handling
- Console.log statements

Provide concise feedback with file:line references.
```

### Comprehensive Agent

```markdown
---
name: security-auditor
description: Deep security vulnerability analysis for code changes
allowed-tools: Read, Grep, WebSearch, Bash(git *)
model: opus
agentType: agent
---

# 🔒 Security Auditor

You are a security expert specializing in application security, with expertise in OWASP Top 10, secure coding practices, and threat modeling. You perform thorough security analysis of code changes.

## Review Process

1. **Gather Context**
   - Read changed files
   - Review git history for context
   - Identify data flows and trust boundaries

2. **Security Analysis**
   - Input validation and sanitization
   - Authentication and authorization
   - SQL injection risks
   - XSS vulnerabilities
   - CSRF protection
   - Secrets exposure
   - Cryptography usage
   - Dependency vulnerabilities

3. **Threat Assessment**
   - Rate severity (Critical/High/Medium/Low)
   - Assess exploitability
   - Determine business impact
   - Provide remediation guidance

4. **Report Findings**
   Use structured format with CVE references where applicable.

## Output Format

**Security Score: X/10**

### Critical Issues (Fix Immediately)
- [Vulnerability] (file:line) - [Explanation] - [CVE if applicable] - [Fix]

### High Priority
- [Issue] (file:line) - [Explanation] - [Fix]

### Medium Priority
- [Concern] (file:line) - [Explanation] - [Recommendation]

### Best Practices
- [Positive security pattern observed]

**Recommendation:** [Approve/Request Changes/Block]

## Examples

### SQL Injection Check

❌ **Vulnerable:**
\`\`\`typescript
const query = \`SELECT * FROM users WHERE id = \${userId}\`;
db.query(query);
\`\`\`

✅ **Safe:**
\`\`\`typescript
const query = 'SELECT * FROM users WHERE id = $1';
db.query(query, [userId]);
\`\`\`
```

## Validation Checklist

Before finalizing an agent:

- [ ] Name is lowercase with hyphens only
- [ ] Name is 64 characters or less
- [ ] Description clearly explains when to use the agent
- [ ] Description is 1024 characters or less
- [ ] Content starts with H1 heading (with emoji icon)
- [ ] Persona is defined using "You are..." format
- [ ] Process or instructions are clearly outlined
- [ ] Examples are included (showing good/bad patterns)
- [ ] Tool access is minimal and specific
- [ ] Model selection is appropriate for task complexity
- [ ] agentType field is set to "agent"
- [ ] File is saved in `.claude/agents/` directory
- [ ] Agent has been tested with real tasks
- [ ] Edge cases are considered

## Schema Reference

**Official Schema URL:**
```
https://github.com/pr-pm/prpm/blob/main/packages/converters/schemas/claude-agent.schema.json
```

**Local Schema Path:**
```
/Users/khaliqgant/Projects/prpm/app/packages/converters/schemas/claude-agent.schema.json
```

## Related Documentation

- **agent-builder** skill - Creating effective subagents
- **slash-command-builder** skill - For simpler, command-based prompts
- **creating-skills** skill - For context-aware reference documentation
- Claude Code Docs: https://docs.claude.com/claude-code

## Agents vs Skills vs Commands

### Use Agents When:
- ✅ Long-running assistants with persistent context
- ✅ Complex multi-step workflows
- ✅ Specialized expertise needed
- ✅ Tool access required
- ✅ Repeatable processes with quality standards

### Use Skills When:
- ✅ Context-aware automatic activation
- ✅ Reference documentation and patterns
- ✅ Team standardization
- ✅ No persistent state needed

### Use Slash Commands When:
- ✅ Simple, focused prompts
- ✅ Quick manual invocation
- ✅ Personal productivity shortcuts
- ✅ Single-file prompts

**Decision Tree:**

```
Need specialized AI assistant?
├─ Yes → Needs tools and persistent context?
│         ├─ Yes → Use Agent
│         └─ No → Quick invocation?
│                 ├─ Yes → Use Slash Command
│                 └─ No → Use Skill
└─ No → Just documentation? → Use Skill
```

## Troubleshooting

### Agent Not Activating

**Problem:** Agent doesn't get invoked when expected

**Solutions:**
1. Make description more specific to match use case
2. Verify file is in `.claude/agents/*.md`
3. Check for frontmatter syntax errors
4. Explicitly request: "Use the [agent-name] agent"

### Validation Errors

**Problem:** Agent file doesn't validate against schema

**Solutions:**
1. Check name pattern (lowercase, hyphens only)
2. Verify required fields (name, description)
3. Ensure content starts with H1 heading
4. Validate model value is in enum
5. Check allowed-tools spelling and capitalization

### Tool Permission Denied

**Problem:** Agent can't access needed tools

**Solutions:**
1. Add tools to `allowed-tools` in frontmatter
2. Use correct capitalization (e.g., `Read`, not `read`)
3. For Bash restrictions, use pattern syntax: `Bash(git *)`
4. Omit `allowed-tools` field to inherit all tools

### Poor Agent Performance

**Problem:** Agent produces inconsistent or low-quality results

**Solutions:**
1. Strengthen persona definition
2. Add more specific process steps
3. Include examples of good/bad patterns
4. Define explicit output format
5. Consider using more powerful model (opus)
6. Break complex agents into specialized ones

**Remember:** Great agents are specialized experts with clear personas, step-by-step processes, and minimal tool access. Focus each agent on doing ONE thing exceptionally well with measurable outcomes.
