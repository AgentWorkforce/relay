# Creating Agent Skills

Use when creating Agent Skills packages (SKILL.md format) for Codex CLI, GitHub Copilot, or Amp - provides the agentskills.io specification with frontmatter constraints, directory structure, and validation rules

### Overview

Agent Skills is an open standard for portable AI agent capabilities. One SKILL.md file works across Codex CLI, GitHub Copilot, and Amp.

**Official Spec:** https://agentskills.io/specification

### Installation Directories

| Tool | Location |
|------|----------|
| **Codex CLI** | `.agents/skills/{skill-name}/SKILL.md` |
| **GitHub Copilot** | `.github/skills/{skill-name}/SKILL.md` |
| **Amp** | `.agents/skills/{skill-name}/SKILL.md` |

### Directory Structure

#### ```

```
my-skill/                 # Must match frontmatter `name`
├── SKILL.md              # Required - main definition
├── scripts/              # Optional - executable code
├── references/           # Optional - additional docs
└── assets/               # Optional - static resources
```


### Frontmatter Specification

#### Required Fields

```yaml
---
name: skill-name
description: What it does and when to use it
---
```

#### Optional Fields

```yaml
---
name: pdf-processing
description: Extracts and processes PDF content. Use for document analysis and text extraction.
license: MIT
compatibility: Requires pdftotext, poppler-utils
allowed-tools: Bash(pdftotext:*) Read Write
metadata:
  category: document-processing
  version: 1.0.0
---
```


### Name Validation

#### ```

```
✅ Valid: pdf-processing, code-review, data-analysis
❌ Invalid: PDF-Processing (uppercase), -pdf (leading hyphen), pdf--processing (consecutive hyphens)
```


### Description Best Practices

#### ```yaml

```yaml
# ❌ BAD - Too vague
description: Helps with PDFs

# ❌ BAD - Missing use cases
description: Extracts text from PDFs

# ✅ GOOD - Functionality + use cases
description: Extracts and processes PDF content. Use for document analysis, text extraction, and form data parsing.
```


### Body Content

#### Markdown instructions after frontmatter. No format restrictions, but recommended sections:

```markdown
---
name: code-review
description: Reviews code for best practices and security issues. Use when analyzing PRs or conducting audits.
---

## Overview
Brief description of capabilities.

## Process
1. Step-by-step workflow
2. With clear actions

## Guidelines
- Bullet points for rules
- Best practices

## Examples
Code samples showing usage.
```


### Progressive Disclosure

Skills use tiered loading to optimize context:

1. **Metadata** (~100 tokens): `name` + `description` load at startup
2. **Activation** (<5000 tokens): Full `SKILL.md` loads when selected
3. **On-demand**: Supporting files load when referenced

**Keep `SKILL.md` under 500 lines** for efficient context usage.

### Supporting Files

#### scripts/

```python
#!/usr/bin/env python3
# scripts/extract.py
import sys
# Self-contained with clear dependencies
```


### Complete Example

#### Type Guard

```typescript
function isUser(obj: unknown): obj is User {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'name' in obj
  );
}
```


### Validation

#### Use the validation tool:

```bash
skills-ref validate ./my-skill
```


### Quick Checklist

- Frontmatter:
- [ ] `name` is 1-64 chars, lowercase alphanumeric + hyphens
- [ ] `name` matches parent directory name
- [ ] `description` is 1-1024 chars
- [ ] `description` includes functionality AND use cases
- Content:
- [ ] Under 500 lines for efficient loading
- [ ] Clear instructions agents can follow
- [ ] Examples for complex operations
- Structure:
- [ ] Directory named exactly as `name` field
- [ ] `SKILL.md` at directory root
- [ ] Supporting files in appropriate subdirectories

### Cross-Tool Compatibility

#### The SKILL.md format is identical across implementations. To port:

```bash
# Codex → Copilot
mv .agents/skills/my-skill .github/skills/my-skill

# Copilot → Codex/Amp
mv .github/skills/my-skill .agents/skills/my-skill
```