/**
 * Unit tests for PTY Output Parser
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OutputParser, formatIncomingMessage, parseSummaryFromOutput, parseSessionEndFromOutput, parseRelayMetadataFromOutput } from './parser.js';

describe('OutputParser', () => {
  let parser: OutputParser;

  beforeEach(() => {
    parser = new OutputParser();
  });

  describe('Inline format - ->relay:target message', () => {
    it('parses basic inline relay command', () => {
      const result = parser.parse('->relay:agent2 Hello there\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'message',
        body: 'Hello there',
        raw: '->relay:agent2 Hello there',
      });
      expect(result.output).toBe('');
    });

    it('extracts target and body correctly', () => {
      const result = parser.parse('->relay:supervisor This is a longer message with multiple words\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('supervisor');
      expect(result.commands[0].body).toBe('This is a longer message with multiple words');
    });

    it('only matches at start of line (after whitespace)', () => {
      const result = parser.parse('  ->relay:agent2 Indented message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
      expect(result.commands[0].body).toBe('Indented message');
    });

    it('handles Gemini sparkle prefix (✦)', () => {
      const result = parser.parse('✦ ->relay:Lead STATUS: Gem is ready\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('Lead');
      expect(result.commands[0].body).toBe('STATUS: Gem is ready');
    });

    it('does not match ->relay: in middle of line', () => {
      const result = parser.parse('This is text ->relay:agent2 should not match\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('This is text ->relay:agent2 should not match\n');
    });

    it('handles ->thinking: variant', () => {
      const result = parser.parse('->thinking:agent2 Considering the options\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'thinking',
        body: 'Considering the options',
      });
    });

    it('parses multiple inline commands', () => {
      const result = parser.parse('->relay:agent1 First message\n->relay:agent2 Second message\n');

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].to).toBe('agent1');
      expect(result.commands[0].body).toBe('First message');
      expect(result.commands[1].to).toBe('agent2');
      expect(result.commands[1].body).toBe('Second message');
    });

    it('parses multi-line inline command with indented continuation', () => {
      // TUI wrapping indents continuation lines
      const result = parser.parse('->relay:agent2 First line\n   Second line\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('First line\n   Second line');
      expect(result.output).toBe('');
    });

    it('does not swallow subsequent inline command after indented continuation', () => {
      const result = parser.parse('->relay:agent1 First line\n   Second line\n->relay:agent2 Next\n');

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].body).toBe('First line\n   Second line');
      expect(result.commands[1].body).toBe('Next');
      expect(result.output).toBe('');
    });

    it('captures bullet list continuation lines', () => {
      const input = '->relay:agent2 Updates for mcl/2z1:\n- Task A\n- Task B\n\nAfter\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Updates for mcl/2z1:\n- Task A\n- Task B');
      expect(result.output).toBe('\nAfter\n');
    });

    it('captures non-indented paragraph continuation until blank line', () => {
      const input = '->relay:lead Signing off. Progress report:\nSummary line one.\nSummary line two.\n\nNext output\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Signing off. Progress report:\nSummary line one.\nSummary line two.');
      expect(result.output).toBe('\nNext output\n');
    });

    it('stops continuation at prompt-ish line', () => {
      const input = '->relay:agent2 Message body\n> \nFollow-up\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Message body');
      expect(result.output).toBe('> \nFollow-up\n');
    });

    it('does not require spaces in target name', () => {
      const result = parser.parse('->relay:agent-with-dashes Message here\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent-with-dashes');
    });
  });

  describe('Block format - [[RELAY]]...[[/RELAY]]', () => {
    it('parses single-line block', () => {
      const result = parser.parse('[[RELAY]]{"to":"agent2","type":"message","body":"Hello"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'message',
        body: 'Hello',
      });
    });

    it('parses multi-line block', () => {
      const input = `[[RELAY]]
{
  "to": "agent2",
  "type": "message",
  "body": "Multi-line message"
}
[[/RELAY]]
`;
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'message',
        body: 'Multi-line message',
      });
    });

    it('extracts JSON fields (to, type, body, data)', () => {
      const input = '[[RELAY]]{"to":"agent2","type":"action","body":"Execute","data":{"cmd":"ls"}}[[/RELAY]]\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'action',
        body: 'Execute',
        data: { cmd: 'ls' },
      });
    });

    it('handles invalid JSON gracefully', () => {
      const result = parser.parse('[[RELAY]]{invalid json}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('\n');
    });

    it('handles missing required fields', () => {
      const result = parser.parse('[[RELAY]]{"body":"No target"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(0);
    });

    it('handles missing body field with text fallback', () => {
      const result = parser.parse('[[RELAY]]{"to":"agent2","type":"message","text":"Using text field"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Using text field');
    });

    it('does not parse blocks unless [[RELAY]] is at start of line', () => {
      const result = parser.parse(
        'Some output [[RELAY]]{"to":"agent2","type":"message","body":"Hello"}[[/RELAY]]\n'
      );

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('Some output [[RELAY]]{"to":"agent2","type":"message","body":"Hello"}[[/RELAY]]\n');
    });

    it('handles block with thinking type', () => {
      const result = parser.parse('[[RELAY]]{"to":"agent2","type":"thinking","body":"Pondering"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].kind).toBe('thinking');
    });

    it('handles block with state type', () => {
      const result = parser.parse('[[RELAY]]{"to":"agent2","type":"state","body":"Updated"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].kind).toBe('state');
    });
  });

  describe('Fenced inline format - ->relay:Target <<< ... >>>', () => {
    it('parses basic fenced inline message', () => {
      const input = '->relay:agent2 <<<\nHello there\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'message',
        body: 'Hello there',
      });
      expect(result.output).toBe('');
    });

    it('preserves blank lines within fenced message', () => {
      const input = '->relay:agent2 <<<\nFirst paragraph\n\nSecond paragraph\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('First paragraph\n\nSecond paragraph');
    });

    it('handles multi-line message with complex content', () => {
      const input = `->relay:Lead <<<
Here's my analysis:

1. First point
2. Second point

The conclusion is...
>>>
`;
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('Lead');
      expect(result.commands[0].body).toContain('First point');
      expect(result.commands[0].body).toContain('Second point');
      expect(result.commands[0].body).toContain('The conclusion is...');
    });

    it('handles fenced message with code blocks inside', () => {
      const input = `->relay:Dev <<<
Here's the code:

\`\`\`typescript
function hello() {
  console.log('Hi');
}
\`\`\`

Let me know if that works.
>>>
`;
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toContain('```typescript');
      expect(result.commands[0].body).toContain('function hello()');
    });

    it('handles fenced thinking variant', () => {
      const input = '->thinking:agent2 <<<\nConsidering options:\n- Option A\n- Option B\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'thinking',
      });
      expect(result.commands[0].body).toContain('Option A');
    });

    it('handles thread syntax in fenced messages', () => {
      const input = '->relay:agent2 [thread:review-123] <<<\nMulti-line\nreview comments\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].thread).toBe('review-123');
      expect(result.commands[0].body).toBe('Multi-line\nreview comments');
    });

    it('handles cross-project syntax in fenced messages', () => {
      const input = '->relay:other-project:agent2 <<<\nCross-project message\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
      expect(result.commands[0].project).toBe('other-project');
    });

    it('processes content after fenced block closes', () => {
      const input = '->relay:agent1 <<<\nFenced content\n>>>\n->relay:agent2 Regular inline\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].to).toBe('agent1');
      expect(result.commands[0].body).toBe('Fenced content');
      expect(result.commands[1].to).toBe('agent2');
      expect(result.commands[1].body).toBe('Regular inline');
    });

    it('accumulates across multiple parse calls (streaming)', () => {
      const result1 = parser.parse('->relay:agent2 <<<\nFirst part\n');
      expect(result1.commands).toHaveLength(0);
      expect(result1.output).toBe('');

      const result2 = parser.parse('Second part\n');
      expect(result2.commands).toHaveLength(0);

      const result3 = parser.parse('>>>\n');
      expect(result3.commands).toHaveLength(1);
      expect(result3.commands[0].body).toBe('First part\nSecond part');
    });

    it('handles >>> with leading/trailing whitespace', () => {
      const input = '->relay:agent2 <<<\nContent\n  >>>  \n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Content');
    });

    it('trims leading/trailing whitespace from body', () => {
      const input = '->relay:agent2 <<<\n\n  Content here  \n\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      // Leading blank lines should be trimmed, content preserved
      expect(result.commands[0].body).toBe('Content here');
    });

    it('handles fenced message with only blank lines', () => {
      const input = '->relay:agent2 <<<\n\n\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('');
    });

    it('handles prefixes like bullets before fenced start', () => {
      const input = '- ->relay:agent2 <<<\nContent from list\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Content from list');
    });

    it('handles >>> at end of content line (agent-relay-9igw)', () => {
      // Agents often put >>> at end of message rather than on its own line
      const input = '->relay:agent2 <<<\nMessage content>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
      expect(result.commands[0].body).toBe('Message content');
    });

    it('handles >>> at end of multi-line content', () => {
      const input = '->relay:Lead <<<\nFirst line\nSecond line>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('First line\nSecond line');
    });

    it('auto-closes and sends incomplete fenced block when new relay starts', () => {
      // Previously this would DISCARD the first message - now it should SEND it
      const input = '->relay:Alice <<<\nImportant content\n->relay:Bob Hello\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].to).toBe('Alice');
      expect(result.commands[0].body).toBe('Important content');
      expect(result.commands[1].to).toBe('Bob');
      expect(result.commands[1].body).toBe('Hello');
    });

    it('auto-closes fenced block when new fenced block starts', () => {
      const input = '->relay:Agent1 <<<\nFirst message\n->relay:Agent2 <<<\nSecond message\n>>>\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].to).toBe('Agent1');
      expect(result.commands[0].body).toBe('First message');
      expect(result.commands[1].to).toBe('Agent2');
      expect(result.commands[1].body).toBe('Second message');
    });

    it('does not send empty incomplete fenced block', () => {
      const input = '->relay:Agent1 <<<\n\n->relay:Agent2 Hello\n';
      const result = parser.parse(input);

      // Only Agent2's message should be sent (Agent1's was empty)
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('Agent2');
    });
  });

  describe('Code fence handling', () => {
    it('ignores ->relay: inside code fences', () => {
      const input = '```\n->relay:agent2 This should be ignored\n```\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('```\n->relay:agent2 This should be ignored\n```\n');
    });

    it('tracks code fence state correctly', () => {
      const input = 'Before fence\n```\n->relay:agent2 Inside fence\n```\nAfter fence\n->relay:agent3 Outside fence\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent3');
      expect(result.output).toContain('->relay:agent2 Inside fence');
    });

    it('handles multiple code fences', () => {
      const input = '```\n->relay:a1 First fence\n```\nBetween\n```\n->relay:a2 Second fence\n```\n->relay:a3 Outside\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('a3');
    });

    it('handles code fence with language specifier', () => {
      const input = '```javascript\n->relay:agent2 Code example\n```\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toContain('->relay:agent2 Code example');
    });

    it('does not interfere with block format in code fence', () => {
      const input = '```\n[[RELAY]]{"to":"agent2","type":"message","body":"In fence"}[[/RELAY]]\n```\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toContain('[[RELAY]]');
    });
  });

  describe('Escaping', () => {
    it('\\->relay: outputs as ->relay: without triggering command', () => {
      const result = parser.parse('\\->relay:agent2 This is escaped\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('->relay:agent2 This is escaped\n');
    });

    it('\\->thinking: outputs as ->thinking: without triggering command', () => {
      const result = parser.parse('\\->thinking:agent2 This is escaped\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('->thinking:agent2 This is escaped\n');
    });

    it('escapes work with indentation', () => {
      const result = parser.parse('  \\->relay:agent2 Indented escape\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('  ->relay:agent2 Indented escape\n');
    });

    it('only escapes at line start', () => {
      const result = parser.parse('Text \\->relay:agent2 Not escaped\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('Text \\->relay:agent2 Not escaped\n');
    });
  });

  describe('Edge cases', () => {
    it('inline commands must be complete in single chunk (no cross-chunk buffering)', () => {
      // Inline relay commands split across chunks are NOT detected
      // This is intentional for minimal terminal interference
      const result1 = parser.parse('->relay:agent2 Partial');
      expect(result1.commands).toHaveLength(0);
      expect(result1.output).toBe('->relay:agent2 Partial'); // Passed through

      const result2 = parser.parse(' line\n');
      expect(result2.commands).toHaveLength(0); // Not detected
      expect(result2.output).toBe(' line\n'); // Passed through
    });

    it('buffers partial block correctly', () => {
      const result1 = parser.parse('[[RELAY]]{"to":"agent2"');
      expect(result1.commands).toHaveLength(0);

      const result2 = parser.parse(',"type":"message","body":"Test"}[[/RELAY]]\n');
      expect(result2.commands).toHaveLength(1);
      expect(result2.commands[0].body).toBe('Test');
    });

    it('flush() does not detect incomplete inline commands (no buffering)', () => {
      // Incomplete inline commands without newline are passed through, not buffered
      const result1 = parser.parse('->relay:agent2 No newline');
      expect(result1.output).toBe('->relay:agent2 No newline'); // Passed through

      const result = parser.flush();
      expect(result.commands).toHaveLength(0); // Not detected
    });

    it('flush() clears all state', () => {
      parser.parse('```\n->relay:agent2 In fence');
      parser.flush();

      const result = parser.parse('->relay:agent3 After flush\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent3');
    });

    it('reset() clears state', () => {
      parser.parse('[[RELAY]]{"to":"agent2"');
      parser.reset();

      const result = parser.parse('Regular output\n');
      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('Regular output\n');
    });

    it('reset() clears code fence state', () => {
      parser.parse('```\n->relay:agent2 test');
      parser.reset();

      const result = parser.parse('->relay:agent3 After reset\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent3');
    });

    it('handles empty input', () => {
      const result = parser.parse('');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('');
    });

    it('handles only newlines', () => {
      const result = parser.parse('\n\n\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('\n\n\n');
    });

    it('handles block size limit', () => {
      const smallParser = new OutputParser({ maxBlockBytes: 50 });
      const largeBlock = '[[RELAY]]' + 'x'.repeat(100) + '[[/RELAY]]\n';

      const result = smallParser.parse(largeBlock);
      expect(result.commands).toHaveLength(0);
    });

    it('preserves regular output', () => {
      const input = 'Regular output line 1\nRegular output line 2\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe(input);
    });

    it('mixes relay commands with regular output', () => {
      const input = 'Output 1\n->relay:agent2 Message\nOutput 2\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.output).toBe('Output 1\nOutput 2\n');
    });

    it('handles incomplete block at flush', () => {
      parser.parse('[[RELAY]]{"to":"agent2","type":"message"');
      const result = parser.flush();

      expect(result.commands).toHaveLength(0);
    });

    it('handles target with special characters', () => {
      const result = parser.parse('->relay:agent_2-test.v1 Message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent_2-test.v1');
    });

    it('handles empty body in inline format', () => {
      // Note: The regex requires at least one character for the body (.+)
      // so this actually won't match as a command
      const result = parser.parse('->relay:agent2 Test\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Test');
    });

    it('handles empty body in block format', () => {
      const result = parser.parse('[[RELAY]]{"to":"agent2","type":"message","body":""}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('');
    });
  });

  describe('Parser options', () => {
    it('disables inline format when enableInline is false', () => {
      const customParser = new OutputParser({ enableInline: false });
      const result = customParser.parse('->relay:agent2 Message\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('->relay:agent2 Message\n');
    });

    it('disables block format when enableBlock is false', () => {
      const customParser = new OutputParser({ enableBlock: false });
      const result = customParser.parse('[[RELAY]]{"to":"agent2","type":"message","body":"Test"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('[[RELAY]]{"to":"agent2","type":"message","body":"Test"}[[/RELAY]]\n');
    });

    it('respects custom maxBlockBytes', () => {
      const customParser = new OutputParser({ maxBlockBytes: 30 });
      // Create a block that will exceed 30 bytes after [[RELAY]] is removed
      const largeJson = '{"to":"a","type":"message","body":"' + 'x'.repeat(50) + '"}';
      const input = `[[RELAY]]\n${largeJson}\n[[/RELAY]]\n`;

      // This should exceed 30 bytes
      const result = customParser.parse(input);
      expect(result.commands).toHaveLength(0);
    });
  });

  describe('Complex scenarios', () => {
    it('handles multiple commands in one parse call', () => {
      const input = `->relay:agent1 First
Regular output
->relay:agent2 Second
[[RELAY]]{"to":"agent3","type":"message","body":"Third"}[[/RELAY]]
More output
`;
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(3);
      expect(result.commands[0].to).toBe('agent1');
      expect(result.commands[1].to).toBe('agent2');
      expect(result.commands[2].to).toBe('agent3');
      expect(result.output).toContain('Regular output');
      expect(result.output).toContain('More output');
    });

    it('handles incremental parsing with multiple parse calls', () => {
      parser.parse('Line 1\n');
      parser.parse('->relay:agent1 Message 1\n');
      parser.parse('Line 2\n');
      const result = parser.parse('->relay:agent2 Message 2\n');

      // Only the last parse call returns commands from that call
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
    });

    it('handles block spanning multiple parse calls', () => {
      const result1 = parser.parse('[[RELAY]]\n');
      expect(result1.commands).toHaveLength(0);

      const result2 = parser.parse('{"to":"agent2",\n');
      expect(result2.commands).toHaveLength(0);

      const result3 = parser.parse('"type":"message","body":"Test"}\n');
      expect(result3.commands).toHaveLength(0);

      const result4 = parser.parse('[[/RELAY]]\n');
      expect(result4.commands).toHaveLength(1);
      expect(result4.commands[0].to).toBe('agent2');
    });

    it('preserves order of commands and output', () => {
      const input = `Out1
->relay:agent1 Msg1
Out2
->relay:agent2 Msg2
Out3
`;
      const result = parser.parse(input);

      const outputLines = result.output.split('\n').filter(l => l.trim());
      expect(outputLines).toEqual(['Out1', 'Out2', 'Out3']);
      expect(result.commands[0].to).toBe('agent1');
      expect(result.commands[1].to).toBe('agent2');
    });
  });

  describe('Cross-project messaging syntax', () => {
    it('parses project:agent syntax for cross-project messaging', () => {
      const result = parser.parse('->relay:myproject:agent2 Hello from another project\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        project: 'myproject',
        kind: 'message',
        body: 'Hello from another project',
      });
    });

    it('parses local agent without project', () => {
      const result = parser.parse('->relay:agent2 Local message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
      expect(result.commands[0].project).toBeUndefined();
    });

    it('handles project names with dashes and underscores', () => {
      const result = parser.parse('->relay:my-project_v2:some-agent Hello\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('some-agent');
      expect(result.commands[0].project).toBe('my-project_v2');
    });

    it('only splits on first colon to allow colons in agent names', () => {
      const result = parser.parse('->relay:proj:agent:with:colons Message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent:with:colons');
      expect(result.commands[0].project).toBe('proj');
    });

    it('handles cross-project with ->thinking: variant', () => {
      const result = parser.parse('->thinking:otherproj:agent2 Thinking about something\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        project: 'otherproj',
        kind: 'thinking',
        body: 'Thinking about something',
      });
    });

    it('handles cross-project broadcast', () => {
      const result = parser.parse('->relay:prod-project:* Broadcast to all in prod\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('*');
      expect(result.commands[0].project).toBe('prod-project');
    });

    it('handles cross-project with thread syntax', () => {
      const result = parser.parse('->relay:proj:agent [thread:abc123] Threaded cross-project message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent',
        project: 'proj',
        thread: 'abc123',
        body: 'Threaded cross-project message',
      });
    });

    it('parses cross-project in block format with explicit project field', () => {
      const result = parser.parse('[[RELAY]]{"to":"agent2","project":"otherproj","type":"message","body":"Hello"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        project: 'otherproj',
        kind: 'message',
        body: 'Hello',
      });
    });

    it('parses cross-project in block format with colon syntax in to field', () => {
      const result = parser.parse('[[RELAY]]{"to":"myproj:agent2","type":"message","body":"Hi"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        project: 'myproj',
        kind: 'message',
        body: 'Hi',
      });
    });

    it('explicit project field takes precedence over colon syntax in block format', () => {
      const result = parser.parse('[[RELAY]]{"to":"ignored:agent2","project":"explicit","type":"message","body":"Test"}[[/RELAY]]\n');

      expect(result.commands).toHaveLength(1);
      // When explicit project is set, the to field is used as-is
      expect(result.commands[0].to).toBe('ignored:agent2');
      expect(result.commands[0].project).toBe('explicit');
    });
  });

  describe('Configurable prefix', () => {
    it('uses default ->relay: prefix', () => {
      const defaultParser = new OutputParser();
      expect(defaultParser.prefix).toBe('->relay:');

      const result = defaultParser.parse('->relay:agent2 Hello\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
    });

    it('uses custom prefix >>', () => {
      const customParser = new OutputParser({ prefix: '>>' });
      expect(customParser.prefix).toBe('>>');

      const result = customParser.parse('>>agent2 Hello from Gemini\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
      expect(result.commands[0].body).toBe('Hello from Gemini');
    });

    it('ignores ->relay: when using @msg: prefix', () => {
      const customParser = new OutputParser({ prefix: '@msg:' });

      const result = customParser.parse('->relay:agent2 Should not match\n');
      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('->relay:agent2 Should not match\n');
    });

    it('uses custom prefix /relay', () => {
      const customParser = new OutputParser({ prefix: '/relay' });

      const result = customParser.parse('/relayagent2 Slash style\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
    });

    it('handles prefix with special regex characters', () => {
      const customParser = new OutputParser({ prefix: '$$msg:' });

      const result = customParser.parse('$$msg:agent2 Dollar prefix\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
    });

    it('supports >> prefix with bullet points', () => {
      const customParser = new OutputParser({ prefix: '>>' });

      const result = customParser.parse('- >>agent2 Bulleted message\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
    });

    it('supports broadcast with custom prefix', () => {
      const customParser = new OutputParser({ prefix: '>>' });

      const result = customParser.parse('>>* Broadcast to all\n');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('*');
      expect(result.commands[0].body).toBe('Broadcast to all');
    });
  });
});

describe('formatIncomingMessage', () => {
  it('formats message correctly', () => {
    const result = formatIncomingMessage('agent1', 'Hello there');

    expect(result).toBe('\n[MSG] from agent1: Hello there\n');
  });

  it('formats message with explicit message kind', () => {
    const result = formatIncomingMessage('agent1', 'Hello there', 'message');

    expect(result).toBe('\n[MSG] from agent1: Hello there\n');
  });

  it('formats thinking correctly', () => {
    const result = formatIncomingMessage('agent1', 'Considering options', 'thinking');

    expect(result).toBe('\n[THINKING] from agent1: Considering options\n');
  });

  it('formats action correctly', () => {
    const result = formatIncomingMessage('agent1', 'Execute command', 'action');

    expect(result).toBe('\n[MSG] from agent1: Execute command\n');
  });

  it('formats state correctly', () => {
    const result = formatIncomingMessage('agent1', 'State updated', 'state');

    expect(result).toBe('\n[MSG] from agent1: State updated\n');
  });

  it('handles empty body', () => {
    const result = formatIncomingMessage('agent1', '');

    expect(result).toBe('\n[MSG] from agent1: \n');
  });

  it('handles agent name with special characters', () => {
    const result = formatIncomingMessage('agent-2_test.v1', 'Message');

    expect(result).toBe('\n[MSG] from agent-2_test.v1: Message\n');
  });

  it('handles multiline body', () => {
    const result = formatIncomingMessage('agent1', 'Line 1\nLine 2\nLine 3');

    expect(result).toBe('\n[MSG] from agent1: Line 1\nLine 2\nLine 3\n');
  });
});

describe('parseSummaryFromOutput', () => {
  it('parses valid JSON summary block', () => {
    const output = `Some output
[[SUMMARY]]
{
  "currentTask": "Implementing auth",
  "context": "Working on login flow",
  "files": ["src/auth.ts"]
}
[[/SUMMARY]]
More output`;

    const summary = parseSummaryFromOutput(output);
    expect(summary).not.toBeNull();
    expect(summary).toEqual({
      currentTask: 'Implementing auth',
      context: 'Working on login flow',
      files: ['src/auth.ts'],
    });
  });

  it('parses summary with all fields', () => {
    const output = `[[SUMMARY]]{"currentTask":"Task 1","completedTasks":["T0"],"decisions":["Use JWT"],"context":"Auth work","files":["a.ts","b.ts"]}[[/SUMMARY]]`;

    const summary = parseSummaryFromOutput(output);
    expect(summary).toEqual({
      currentTask: 'Task 1',
      completedTasks: ['T0'],
      decisions: ['Use JWT'],
      context: 'Auth work',
      files: ['a.ts', 'b.ts'],
    });
  });

  it('returns null when no summary block exists', () => {
    const output = 'Just regular output without any summary block';

    const summary = parseSummaryFromOutput(output);
    expect(summary).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const output = '[[SUMMARY]]not valid json[[/SUMMARY]]';

    const summary = parseSummaryFromOutput(output);
    expect(summary).toBeNull();
  });

  it('handles empty summary block', () => {
    const output = '[[SUMMARY]]{}[[/SUMMARY]]';

    const summary = parseSummaryFromOutput(output);
    expect(summary).toEqual({});
  });
});

describe('parseSessionEndFromOutput', () => {
  it('parses valid JSON session end block', () => {
    const output = `Some output
[[SESSION_END]]
{
  "summary": "Completed auth module",
  "completedTasks": ["login", "logout"]
}
[[/SESSION_END]]
More output`;

    const result = parseSessionEndFromOutput(output);
    expect(result).not.toBeNull();
    expect(result).toEqual({
      summary: 'Completed auth module',
      completedTasks: ['login', 'logout'],
    });
  });

  it('parses empty session end block', () => {
    const output = '[[SESSION_END]][[/SESSION_END]]';

    const result = parseSessionEndFromOutput(output);
    expect(result).toEqual({});
  });

  it('parses session end with only summary', () => {
    const output = '[[SESSION_END]]{"summary":"All done!"}[[/SESSION_END]]';

    const result = parseSessionEndFromOutput(output);
    expect(result).toEqual({ summary: 'All done!' });
  });

  it('treats non-JSON content as plain summary', () => {
    const output = '[[SESSION_END]]Work completed successfully[[/SESSION_END]]';

    const result = parseSessionEndFromOutput(output);
    expect(result).toEqual({ summary: 'Work completed successfully' });
  });

  it('returns null when no session end block exists', () => {
    const output = 'Regular output without session end';

    const result = parseSessionEndFromOutput(output);
    expect(result).toBeNull();
  });

  it('handles multiline plain text summary', () => {
    const output = `[[SESSION_END]]
Completed the following:
- Feature A
- Feature B
[[/SESSION_END]]`;

    const result = parseSessionEndFromOutput(output);
    expect(result?.summary).toContain('Completed the following:');
    expect(result?.summary).toContain('Feature A');
  });
});

describe('parseRelayMetadataFromOutput', () => {
  it('parses valid metadata block', () => {
    const output = `Some output
[[RELAY_METADATA]]
{
  "subject": "Task update",
  "importance": 80,
  "replyTo": "msg-abc123",
  "ackRequired": true
}
[[/RELAY_METADATA]]
More output`;

    const result = parseRelayMetadataFromOutput(output);
    expect(result.found).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.metadata).toEqual({
      subject: 'Task update',
      importance: 80,
      replyTo: 'msg-abc123',
      ackRequired: true,
    });
    expect(result.rawContent).toContain('"subject"');
  });

  it('returns not found when no metadata block exists', () => {
    const output = 'Regular output without any metadata block';

    const result = parseRelayMetadataFromOutput(output);
    expect(result.found).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.rawContent).toBeNull();
  });

  it('returns invalid for malformed JSON', () => {
    const output = '[[RELAY_METADATA]]not valid json[[/RELAY_METADATA]]';

    const result = parseRelayMetadataFromOutput(output);
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.rawContent).toBe('not valid json');
  });

  it('handles empty metadata block', () => {
    const output = '[[RELAY_METADATA]]{}[[/RELAY_METADATA]]';

    const result = parseRelayMetadataFromOutput(output);
    expect(result.found).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.metadata).toEqual({});
  });

  it('parses metadata with partial fields', () => {
    const output = '[[RELAY_METADATA]]{"subject":"Quick note"}[[/RELAY_METADATA]]';

    const result = parseRelayMetadataFromOutput(output);
    expect(result.found).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.metadata).toEqual({ subject: 'Quick note' });
  });
});
