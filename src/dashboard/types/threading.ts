export interface ThreadMetadata {
  threadId: string;
  replyCount: number;
  participants: string[];
  lastReplyAt: number;
  lastReplyPreview?: string;
}
