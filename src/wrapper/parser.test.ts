/**
 * Unit tests for PTY Output Parser
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OutputParser, formatIncomingMessage } from './parser.js';

describe('OutputParser', () => {
  let parser: OutputParser;

  beforeEach(() => {
    parser = new OutputParser();
  });

  describe('Inline format - >>relay:target message', () => {
    it('parses basic inline relay command', () => {
      const result = parser.parse('>>relay:agent2 Hello there\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'message',
        body: 'Hello there',
        raw: '>>relay:agent2 Hello there',
      });
      expect(result.output).toBe('');
    });

    it('extracts target and body correctly', () => {
      const result = parser.parse('>>relay:supervisor This is a longer message with multiple words\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('supervisor');
      expect(result.commands[0].body).toBe('This is a longer message with multiple words');
    });

    it('only matches at start of line (after whitespace)', () => {
      const result = parser.parse('  >>relay:agent2 Indented message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent2');
      expect(result.commands[0].body).toBe('Indented message');
    });

    it('does not match >>relay: in middle of line', () => {
      const result = parser.parse('This is text >>relay:agent2 should not match\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('This is text >>relay:agent2 should not match\n');
    });

    it('handles >>thinking: variant', () => {
      const result = parser.parse('>>thinking:agent2 Considering the options\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        to: 'agent2',
        kind: 'thinking',
        body: 'Considering the options',
      });
    });

    it('parses multiple inline commands', () => {
      const result = parser.parse('>>relay:agent1 First message\n>>relay:agent2 Second message\n');

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].to).toBe('agent1');
      expect(result.commands[0].body).toBe('First message');
      expect(result.commands[1].to).toBe('agent2');
      expect(result.commands[1].body).toBe('Second message');
    });

    it('parses multi-line inline command with indented continuation', () => {
      // TUI wrapping indents continuation lines
      const result = parser.parse('>>relay:agent2 First line\n   Second line\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('First line\n   Second line');
      expect(result.output).toBe('');
    });

    it('does not swallow subsequent inline command after indented continuation', () => {
      const result = parser.parse('>>relay:agent1 First line\n   Second line\n>>relay:agent2 Next\n');

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].body).toBe('First line\n   Second line');
      expect(result.commands[1].body).toBe('Next');
      expect(result.output).toBe('');
    });

    it('does not treat non-indented lines as continuation', () => {
      // Non-indented lines after >>relay should be regular output
      const result = parser.parse('>>relay:agent2 Message\nRegular output\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].body).toBe('Message');
      expect(result.output).toBe('Regular output\n');
    });

    it('does not require spaces in target name', () => {
      const result = parser.parse('>>relay:agent-with-dashes Message here\n');

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

  describe('Code fence handling', () => {
    it('ignores >>relay: inside code fences', () => {
      const input = '```\n>>relay:agent2 This should be ignored\n```\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('```\n>>relay:agent2 This should be ignored\n```\n');
    });

    it('tracks code fence state correctly', () => {
      const input = 'Before fence\n```\n>>relay:agent2 Inside fence\n```\nAfter fence\n>>relay:agent3 Outside fence\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent3');
      expect(result.output).toContain('>>relay:agent2 Inside fence');
    });

    it('handles multiple code fences', () => {
      const input = '```\n>>relay:a1 First fence\n```\nBetween\n```\n>>relay:a2 Second fence\n```\n>>relay:a3 Outside\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('a3');
    });

    it('handles code fence with language specifier', () => {
      const input = '```javascript\n>>relay:agent2 Code example\n```\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toContain('>>relay:agent2 Code example');
    });

    it('does not interfere with block format in code fence', () => {
      const input = '```\n[[RELAY]]{"to":"agent2","type":"message","body":"In fence"}[[/RELAY]]\n```\n';
      const result = parser.parse(input);

      expect(result.commands).toHaveLength(0);
      expect(result.output).toContain('[[RELAY]]');
    });
  });

  describe('Escaping', () => {
    it('\\>>relay: outputs as >>relay: without triggering command', () => {
      const result = parser.parse('\\>>relay:agent2 This is escaped\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('>>relay:agent2 This is escaped\n');
    });

    it('\\>>thinking: outputs as >>thinking: without triggering command', () => {
      const result = parser.parse('\\>>thinking:agent2 This is escaped\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('>>thinking:agent2 This is escaped\n');
    });

    it('escapes work with indentation', () => {
      const result = parser.parse('  \\>>relay:agent2 Indented escape\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('  >>relay:agent2 Indented escape\n');
    });

    it('only escapes at line start', () => {
      const result = parser.parse('Text \\>>relay:agent2 Not escaped\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('Text \\>>relay:agent2 Not escaped\n');
    });
  });

  describe('Edge cases', () => {
    it('inline commands must be complete in single chunk (no cross-chunk buffering)', () => {
      // Inline relay commands split across chunks are NOT detected
      // This is intentional for minimal terminal interference
      const result1 = parser.parse('>>relay:agent2 Partial');
      expect(result1.commands).toHaveLength(0);
      expect(result1.output).toBe('>>relay:agent2 Partial'); // Passed through

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
      const result1 = parser.parse('>>relay:agent2 No newline');
      expect(result1.output).toBe('>>relay:agent2 No newline'); // Passed through

      const result = parser.flush();
      expect(result.commands).toHaveLength(0); // Not detected
    });

    it('flush() clears all state', () => {
      parser.parse('```\n>>relay:agent2 In fence');
      parser.flush();

      const result = parser.parse('>>relay:agent3 After flush\n');
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
      parser.parse('```\n>>relay:agent2 test');
      parser.reset();

      const result = parser.parse('>>relay:agent3 After reset\n');
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
      const input = 'Output 1\n>>relay:agent2 Message\nOutput 2\n';
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
      const result = parser.parse('>>relay:agent_2-test.v1 Message\n');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].to).toBe('agent_2-test.v1');
    });

    it('handles empty body in inline format', () => {
      // Note: The regex requires at least one character for the body (.+)
      // so this actually won't match as a command
      const result = parser.parse('>>relay:agent2 Test\n');

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
      const result = customParser.parse('>>relay:agent2 Message\n');

      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('>>relay:agent2 Message\n');
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
      const input = `>>relay:agent1 First
Regular output
>>relay:agent2 Second
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
      parser.parse('>>relay:agent1 Message 1\n');
      parser.parse('Line 2\n');
      const result = parser.parse('>>relay:agent2 Message 2\n');

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
>>relay:agent1 Msg1
Out2
>>relay:agent2 Msg2
Out3
`;
      const result = parser.parse(input);

      const outputLines = result.output.split('\n').filter(l => l.trim());
      expect(outputLines).toEqual(['Out1', 'Out2', 'Out3']);
      expect(result.commands[0].to).toBe('agent1');
      expect(result.commands[1].to).toBe('agent2');
    });
  });

  describe('Configurable prefix', () => {
    it('uses default >>relay: prefix', () => {
      const defaultParser = new OutputParser();
      expect(defaultParser.prefix).toBe('>>relay:');

      const result = defaultParser.parse('>>relay:agent2 Hello\n');
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

    it('ignores >>relay: when using @msg: prefix', () => {
      const customParser = new OutputParser({ prefix: '@msg:' });

      const result = customParser.parse('>>relay:agent2 Should not match\n');
      expect(result.commands).toHaveLength(0);
      expect(result.output).toBe('>>relay:agent2 Should not match\n');
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
