import { describe, it, expect } from 'vitest';
import { parseSaveContent, parseHandoffContent, parseContinuityCommand, hasContinuityCommand } from './parser.js';

describe('parseSaveContent', () => {
  describe('plain text format', () => {
    it('should parse simple field: value format', () => {
      const content = `Current task: Implement auth
Completed: Login form, Validation
In progress: Session handling
Blocked: API not ready`;

      const result = parseSaveContent(content);

      expect(result.currentTask).toBe('Implement auth');
      expect(result.completed).toEqual(['Login form', 'Validation']);
      expect(result.inProgress).toEqual(['Session handling']);
      expect(result.blocked).toEqual(['API not ready']);
    });

    it('should parse files with line numbers', () => {
      const content = `Files: src/auth.ts:10-50, src/login.ts`;

      const result = parseSaveContent(content);

      expect(result.fileContext).toHaveLength(2);
      expect(result.fileContext![0]).toEqual({
        path: 'src/auth.ts',
        lines: [10, 50],
      });
      expect(result.fileContext![1]).toEqual({ path: 'src/login.ts' });
    });
  });

  describe('markdown format', () => {
    it('should parse markdown bold syntax **Field:** value', () => {
      const content = `**Current Task:** Implement auth
**Completed:** Login form, Validation
**In Progress:** Session handling`;

      const result = parseSaveContent(content);

      expect(result.currentTask).toBe('Implement auth');
      expect(result.completed).toEqual(['Login form', 'Validation']);
      expect(result.inProgress).toEqual(['Session handling']);
    });

    it('should parse markdown section headers with list items', () => {
      const content = `## Current Session State

**Current Task:** Implement auth

### Completed
- Login form
- Validation logic
- Unit tests

### In Progress
- Session handling
- Token refresh

### Blocked
- API endpoint not ready`;

      const result = parseSaveContent(content);

      expect(result.currentTask).toBe('Implement auth');
      expect(result.completed).toEqual([
        'Login form',
        'Validation logic',
        'Unit tests',
      ]);
      expect(result.inProgress).toEqual(['Session handling', 'Token refresh']);
      expect(result.blocked).toEqual(['API endpoint not ready']);
    });

    it('should handle checkmark and warning emoji prefixes', () => {
      const content = `### Completed
- ✓ Login form
- ✓ Validation

### Needs Verification
- ❓ API rate limits`;

      const result = parseSaveContent(content);

      expect(result.completed).toEqual(['Login form', 'Validation']);
      expect(result.uncertainItems).toEqual(['API rate limits']);
    });

    it('should skip file paths that look like colons (e.g., src/file.ts:10)', () => {
      const content = `Working on src/file.ts:10-50
\`src/auth.ts\`:10-50`;

      const result = parseSaveContent(content);

      // Should not parse these as fields
      expect(result.currentTask).toBeUndefined();
    });

    it('should parse Phase from markdown', () => {
      const content = `**Phase:** EXECUTE`;

      const result = parseSaveContent(content);

      expect(result.pderoPhase).toBe('execute');
    });
  });

  describe('mixed format', () => {
    it('should handle content from formatStartupContext output', () => {
      const content = `# Session Continuity

*This context was automatically loaded from your previous session.*

## Current Session State

**Current Task:** Fix continuity parser

### Completed
- ✓ Identified the issue
- ✓ Created test cases

### In Progress
- Implementation

### Key Decisions
- **Use section-based parsing**
  - Reasoning: More robust for markdown content`;

      const result = parseSaveContent(content);

      expect(result.currentTask).toBe('Fix continuity parser');
      expect(result.completed).toContain('Identified the issue');
      expect(result.completed).toContain('Created test cases');
      expect(result.inProgress).toContain('Implementation');
    });
  });
});

describe('parseContinuityCommand', () => {
  describe('save command', () => {
    it('should parse save command with fenced content', () => {
      const output = `Some output before
->continuity:save <<<
Current task: Testing fix
Completed: Item 1, Item 2
In progress: Item 3
>>>
Some output after`;

      const cmd = parseContinuityCommand(output);

      expect(cmd).not.toBeNull();
      expect(cmd!.type).toBe('save');
      expect(cmd!.content).toContain('Current task: Testing fix');
      expect(cmd!.createHandoff).toBe(false);
    });

    it('should parse save command with --handoff flag', () => {
      const output = `->continuity:save --handoff <<<
Current task: Testing
>>>`;

      const cmd = parseContinuityCommand(output);

      expect(cmd).not.toBeNull();
      expect(cmd!.type).toBe('save');
      expect(cmd!.createHandoff).toBe(true);
    });

    it('should parse save command inline (single line)', () => {
      const output = '->continuity:save <<<Current task: Quick save>>>';

      const cmd = parseContinuityCommand(output);

      expect(cmd).not.toBeNull();
      expect(cmd!.type).toBe('save');
      expect(cmd!.content).toBe('Current task: Quick save');
    });

    it('should extract content correctly and parseSaveContent should parse it', () => {
      const output = `->continuity:save <<<
Current task: Implement authentication
Completed: Login form, Validation
In progress: Session handling
>>>`;

      const cmd = parseContinuityCommand(output);
      expect(cmd).not.toBeNull();

      // Now parse the extracted content
      const parsed = parseSaveContent(cmd!.content!);

      expect(parsed.currentTask).toBe('Implement authentication');
      expect(parsed.completed).toEqual(['Login form', 'Validation']);
      expect(parsed.inProgress).toEqual(['Session handling']);
    });
  });

  describe('load command', () => {
    it('should detect load command', () => {
      const output = 'Some text\n->continuity:load\nMore text';

      const cmd = parseContinuityCommand(output);

      expect(cmd).not.toBeNull();
      expect(cmd!.type).toBe('load');
    });
  });

  describe('search command', () => {
    it('should parse search with quoted query', () => {
      const output = '->continuity:search "authentication patterns"';

      const cmd = parseContinuityCommand(output);

      expect(cmd).not.toBeNull();
      expect(cmd!.type).toBe('search');
      expect(cmd!.query).toBe('authentication patterns');
    });
  });

  describe('hasContinuityCommand', () => {
    it('should return true when save command present', () => {
      expect(hasContinuityCommand('->continuity:save <<<test>>>')).toBe(true);
    });

    it('should return true when load command present', () => {
      expect(hasContinuityCommand('prefix ->continuity:load suffix')).toBe(true);
    });

    it('should return false when no command present', () => {
      expect(hasContinuityCommand('regular output without commands')).toBe(false);
    });
  });
});

describe('parseHandoffContent', () => {
  describe('plain text format', () => {
    it('should parse simple handoff content', () => {
      const content = `Summary: Implemented auth module
Task: Build authentication system
Completed: Login, Logout
Next steps: Add 2FA, Password reset`;

      const result = parseHandoffContent(content);

      expect(result.summary).toBe('Implemented auth module');
      expect(result.taskDescription).toBe('Build authentication system');
      expect(result.completedWork).toEqual(['Login', 'Logout']);
      expect(result.nextSteps).toEqual(['Add 2FA', 'Password reset']);
    });
  });

  describe('markdown format', () => {
    it('should parse markdown formatted handoff', () => {
      const content = `## Previous Session Handoff

**Task:** Build authentication system

Implemented JWT-based auth with refresh tokens.

### Previously Completed
- ✓ Login endpoint
- ✓ JWT utilities
- ✓ Refresh token logic

### Next Steps
- Add password reset
- Implement 2FA

### Prior Decisions
- Use JWT over sessions
- Store refresh tokens in HttpOnly cookies

### Key Files
- src/auth/jwt.ts
- src/models/user.ts`;

      const result = parseHandoffContent(content);

      expect(result.taskDescription).toBe('Build authentication system');
      expect(result.completedWork).toContain('Login endpoint');
      expect(result.completedWork).toContain('JWT utilities');
      expect(result.nextSteps).toContain('Add password reset');
      expect(result.nextSteps).toContain('Implement 2FA');
      expect(result.decisions).toHaveLength(2);
      expect(result.decisions[0].decision).toBe('Use JWT over sessions');
      expect(result.fileReferences.map((f) => f.path)).toContain('src/auth/jwt.ts');
    });
  });
});
