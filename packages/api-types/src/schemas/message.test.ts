import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  MessageStatusSchema,
  AttachmentSchema,
  MessageSchema,
  ThreadSchema,
  type Message,
  type Attachment,
  type Thread,
} from './message.js';

describe('MessageStatusSchema', () => {
  it('accepts valid status values', () => {
    expect(MessageStatusSchema.parse('unread')).toBe('unread');
    expect(MessageStatusSchema.parse('read')).toBe('read');
    expect(MessageStatusSchema.parse('acked')).toBe('acked');
    expect(MessageStatusSchema.parse('sending')).toBe('sending');
    expect(MessageStatusSchema.parse('failed')).toBe('failed');
  });

  it('rejects invalid status values', () => {
    expect(() => MessageStatusSchema.parse('pending')).toThrow();
    expect(() => MessageStatusSchema.parse('')).toThrow();
  });
});

describe('AttachmentSchema', () => {
  it('accepts valid attachment', () => {
    const attachment: Attachment = {
      id: 'att-123',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 1024,
      url: 'https://example.com/att-123',
    };
    const result = AttachmentSchema.parse(attachment);
    expect(result).toEqual(attachment);
  });

  it('accepts attachment with all optional fields', () => {
    const attachment: Attachment = {
      id: 'att-123',
      filename: 'image.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
      url: 'https://example.com/image.jpg',
      filePath: '/tmp/uploads/image.jpg',
      width: 800,
      height: 600,
      data: 'base64data...',
    };
    const result = AttachmentSchema.parse(attachment);
    expect(result.filePath).toBe('/tmp/uploads/image.jpg');
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.data).toBe('base64data...');
  });

  it('rejects attachment without required fields', () => {
    expect(() =>
      AttachmentSchema.parse({ id: 'att-123', filename: 'test.png' })
    ).toThrow();
  });
});

describe('MessageSchema', () => {
  it('accepts minimal valid message', () => {
    const message: Message = {
      id: 'msg-123',
      from: 'Agent1',
      to: 'Agent2',
      content: 'Hello!',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const result = MessageSchema.parse(message);
    expect(result).toEqual(message);
  });

  it('accepts message with all optional fields', () => {
    const message: Message = {
      id: 'msg-123',
      from: 'Agent1',
      to: 'Agent2',
      content: 'Hello with thread!',
      timestamp: '2024-01-01T00:00:00Z',
      thread: 'thread-456',
      isBroadcast: false,
      isRead: true,
      replyCount: 5,
      threadSummary: {
        id: 'thread-456',
        rootMessage: 'Original message',
        participantCount: 3,
        messageCount: 10,
        lastActivityAt: '2024-01-02T00:00:00Z',
      },
      status: 'acked',
      attachments: [
        {
          id: 'att-1',
          filename: 'file.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          url: 'https://example.com/file.pdf',
        },
      ],
      channel: 'general',
    };
    const result = MessageSchema.parse(message);
    expect(result.thread).toBe('thread-456');
    expect(result.status).toBe('acked');
    expect(result.attachments).toHaveLength(1);
  });

  it('rejects message without required id', () => {
    expect(() =>
      MessageSchema.parse({
        from: 'A',
        to: 'B',
        content: 'test',
        timestamp: '2024-01-01',
      })
    ).toThrow();
  });

  it('rejects message without required from', () => {
    expect(() =>
      MessageSchema.parse({
        id: '1',
        to: 'B',
        content: 'test',
        timestamp: '2024-01-01',
      })
    ).toThrow();
  });
});

describe('ThreadSchema', () => {
  it('accepts valid thread', () => {
    const thread: Thread = {
      id: 'thread-123',
      messages: [
        {
          id: 'msg-1',
          from: 'A',
          to: 'B',
          content: 'First',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: 'msg-2',
          from: 'B',
          to: 'A',
          content: 'Reply',
          timestamp: '2024-01-01T00:01:00Z',
        },
      ],
      participants: ['A', 'B'],
      lastActivity: '2024-01-01T00:01:00Z',
    };
    const result = ThreadSchema.parse(thread);
    expect(result.messages).toHaveLength(2);
    expect(result.participants).toContain('A');
    expect(result.participants).toContain('B');
  });

  it('accepts thread with empty messages array', () => {
    const thread: Thread = {
      id: 'thread-123',
      messages: [],
      participants: ['A'],
      lastActivity: '2024-01-01T00:00:00Z',
    };
    const result = ThreadSchema.parse(thread);
    expect(result.messages).toHaveLength(0);
  });
});

describe('Type inference', () => {
  it('infers Message type correctly', () => {
    const message: Message = {
      id: '1',
      from: 'A',
      to: 'B',
      content: 'Test',
      timestamp: '2024-01-01',
    };
    const parsed: z.infer<typeof MessageSchema> = MessageSchema.parse(message);
    expect(parsed.content).toBe('Test');
  });
});
