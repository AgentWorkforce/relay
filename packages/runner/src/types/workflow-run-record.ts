export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  askQuestionExchanges?: AskQuestionExchange[];
}

export interface AskQuestionExchange {
  channel: string;
  questionTimestamp: string;
  questionText: string;
  replierUserId?: string;
  replyText?: string;
  replyTimestamp?: string;
  matchedChoices?: string[];
  matchedRegexGroups?: Record<string, string>;
  timeoutOutcome?: 'timeout' | 'cancelled' | null;
}
