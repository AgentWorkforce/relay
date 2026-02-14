# Webhook & Acknowledgment Improvements Specification

## Executive Summary

Investigation of reported issues revealed two critical bugs causing thread dropout and missing acknowledgments:

1. **Thread context is lost** when spawning agents - threads drop off because agent responses don't include the original thread_ts
2. **No message acknowledgment protocol** - spawn commands can be silently lost without detection or retry

This spec proposes fixes and architectural improvements for reliability.

---

## Current Issues

### Issue 1: Thread Context Dropout

**Problem**: Thread_ts is captured at webhook ingestion but NOT propagated in spawn commands.

**Root Cause** (router.ts:223-237):
```typescript
await db.linkedDaemons.queueMessage(onlineDaemon.id, {
  // ... spawn command ...
  metadata: {
    eventId: event.id,
    source: event.source,
    eventType: event.type,
    repository: event.context.name,
    itemNumber: event.item?.number,
    // MISSING: threadTs is not included!
  },
});
```

**Impact**:
- Agents spawned without thread context
- Responses posted outside threads
- Users see fragmented conversations
- Thread_ts lost between webhook parser and agent execution

**Affected Files**:
- `/packages/cloud/src/webhooks/router.ts` (lines 223-237)
- `/packages/cloud/src/webhooks/parsers/slack.ts` (lines 119-122) - captures but doesn't propagate
- `/packages/cloud/src/db/schema.ts` - no thread tracking in fix attempt records

---

### Issue 2: Missing Message Acknowledgment

**Problem**: No confirmation that spawn commands reached the daemon.

**Current Flow**:
1. Webhook received and parsed ✅
2. Spawn command queued to daemon
3. **NO ACK from daemon** ❌
4. If daemon offline/busy, message silently lost

**Root Cause**:
- `/packages/cloud/src/services/cloud-message-bus.ts` is a simple event emitter with no persistence
- `/packages/cloud/src/webhooks/router.ts` queues to daemon but doesn't wait for ACK
- No timeout, retry, or failure detection

**Impact**:
- Spawn commands lost without detection
- No escalation when daemon is offline
- Users don't know if task was actually queued
- Silent failures lead to confusion

**Related Issues**:
- No correlation IDs to track event→agent→response
- No retry logic (TTL/backoff)
- Completion not tracked back to original request

---

## Proposed Solutions

### Solution 1: Thread Context Propagation

**Files to Modify**:
1. `router.ts` - Include threadTs in spawn metadata
2. `schema.ts` - Add thread tracking to fix_attempts and ci_fix_attempts tables
3. Agent spawn interface - Ensure agents receive and use thread_ts

**Implementation**:

**Step 1: Update router.ts (lines 227-233)**
```typescript
const metadata = {
  eventId: event.id,
  source: event.source,
  eventType: event.type,
  repository: event.context.name,
  itemNumber: event.item?.number,
  // NEW: Include thread context
  channelId: event.metadata?.channelId,
  threadTs: event.metadata?.threadTs,
  ts: event.metadata?.ts,
};
```

**Step 2: Update schema.ts - Add thread tracking**
```typescript
export const fixAttempts = pgTable('fix_attempts', {
  // ... existing fields ...
  // NEW: Thread context fields
  slackChannelId: varchar('slack_channel_id'),
  slackThreadTs: varchar('slack_thread_ts'),
  slackEventTs: varchar('slack_event_ts'),
});

export const ciFixAttempts = pgTable('ci_fix_attempts', {
  // ... existing fields ...
  // NEW: Thread context fields
  slackChannelId: varchar('slack_channel_id'),
  slackThreadTs: varchar('slack_thread_ts'),
});
```

**Step 3: Agents receive thread_ts**
- Pass threadTs through spawn command metadata
- Agents read threadTs and include in responses
- Slack responder uses threadTs to reply in thread

**Success Criteria**:
- All agent responses appear in correct thread
- Thread_ts persisted to database for audit trail
- Can query fix attempts by thread for debugging

---

### Solution 2: Message Acknowledgment Protocol

**Files to Modify**:
1. `cloud-message-bus.ts` - Add ACK protocol
2. `router.ts` - Implement ACK waiting
3. `schema.ts` - Add message tracking table

**Implementation**:

**Step 1: Add Message Tracking Table (schema.ts)**
```typescript
export const queuedMessages = pgTable('queued_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  daemonId: varchar('daemon_id').notNull(),
  messageId: varchar('message_id').notNull(),
  type: varchar('type').notNull(), // 'spawn', 'message', etc
  status: varchar('status').default('pending'), // pending, acked, failed
  payload: jsonb('payload'),
  queuedAt: timestamp('queued_at').defaultNow().notNull(),
  ackedAt: timestamp('acked_at'),
  failedAt: timestamp('failed_at'),
  retryCount: integer('retry_count').default(0),
  error: text('error'),
  correlationId: varchar('correlation_id'), // Link to webhook event
});
```

**Step 2: Implement ACK Protocol (cloud-message-bus.ts)**
```typescript
export async function queueMessageWithAck(
  daemonId: string,
  message: QueuedMessage,
  options: {
    timeout?: number; // default 5s
    retries?: number; // default 3
    backoffMs?: number; // default 1000
  }
): Promise<{ success: boolean; ackTs?: string; error?: string }> {
  const messageId = generateMessageId();
  const correlationId = generateCorrelationId();

  // 1. Store in database
  await db.queuedMessages.insert({
    daemonId,
    messageId,
    correlationId,
    type: message.type,
    status: 'pending',
    payload: message,
    queuedAt: new Date(),
  });

  // 2. Send message with timeout
  message.metadata = {
    ...message.metadata,
    messageId,
    correlationId,
  };

  try {
    await this.emit(daemonId, message);
  } catch (err) {
    await db.queuedMessages.update(messageId, {
      status: 'failed',
      error: err.message,
      failedAt: new Date(),
    });
    return { success: false, error: err.message };
  }

  // 3. Wait for ACK with timeout
  const ackPromise = this.waitForAck(messageId, {
    timeout: options.timeout || 5000,
  });

  try {
    const ack = await ackPromise;
    await db.queuedMessages.update(messageId, {
      status: 'acked',
      ackedAt: new Date(),
    });
    return { success: true, ackTs: ack.ts };
  } catch (err) {
    // 4. Implement retry logic
    if (options.retries && options.retries > 0) {
      await new Promise(r => setTimeout(r, options.backoffMs || 1000));
      return this.queueMessageWithAck(daemonId, message, {
        ...options,
        retries: options.retries - 1,
      });
    }

    await db.queuedMessages.update(messageId, {
      status: 'failed',
      error: 'ACK timeout',
      failedAt: new Date(),
      retryCount: (options.retries || 3) - (options.retries || 3),
    });

    return { success: false, error: 'ACK timeout after retries' };
  }
}
```

**Step 3: Update router.ts to use ACK (lines 227-237)**
```typescript
const ackResult = await cloudMessageBus.queueMessageWithAck(
  onlineDaemon.id,
  {
    from: { daemonId: 'cloud', daemonName: 'Agent Relay Cloud', agent: 'system' },
    to: '__spawner__',
    content: JSON.stringify({
      type: 'spawn_agent',
      agentName,
      cli: 'claude',
      task: prompt,
      metadata: { /* ... */ },
    }),
    metadata: { type: 'spawn_command' },
  },
  { timeout: 5000, retries: 3, backoffMs: 1000 }
);

if (!ackResult.success) {
  // Handle failure: log alert, try next daemon, or fail gracefully
  await alerting.sendAlert({
    level: 'warning',
    message: `Failed to spawn agent: ${ackResult.error}`,
    daemon: onlineDaemon.id,
    correlationId: event.id,
  });
  return {
    success: false,
    error: `Failed to queue spawn command: ${ackResult.error}`
  };
}
```

**Success Criteria**:
- All spawn commands tracked in database
- ACK received before considering message delivered
- Failed messages logged and alerted
- Automatic retry on daemon timeout
- Can query message delivery status for debugging

---

### Solution 3: Request Correlation & Tracing

**Files to Modify**:
1. `router.ts` - Generate correlation IDs
2. `schema.ts` - Add correlation ID to tracking tables
3. All event handlers - Propagate correlation ID

**Implementation**:

Add correlationId to all request flows:
- Webhook event parsed → correlationId generated
- Spawn command → includes correlationId
- Agent response → includes correlationId
- Database records → linked by correlationId

**Benefits**:
- Trace webhook → daemon → agent → response
- Debug message loss by following correlation trail
- Link user-facing events to internal system events

---

### Solution 4: Thread Timestamp Validation

**Files to Modify**:
1. `responders/slack.ts` - Validate thread_ts before posting

**Implementation**:

```typescript
async function postToSlack(message: SlackResponse) {
  if (message.metadata?.threadTs) {
    // Validate thread still exists (not older than 7 days in Slack)
    const threadAge = Date.now() - (parseInt(message.metadata.threadTs) * 1000);
    if (threadAge > 7 * 24 * 60 * 60 * 1000) {
      // Thread too old, post to channel instead
      return await postToChannel(message);
    }
  }

  // Post with thread_ts
  return await slack.chat.postMessage({
    channel: message.metadata.channelId,
    thread_ts: message.metadata.threadTs,
    text: message.text,
  });
}
```

---

## Implementation Timeline

### Phase 1: Critical Fixes (Thread Context)
**Priority**: P0 - Fixes thread dropout
**Effort**: 2-3 hours
1. Update router.ts to include threadTs in spawn metadata
2. Update schema.ts with thread tracking fields
3. Test agent responses appear in correct thread

### Phase 2: Message ACK Protocol
**Priority**: P0 - Fixes silent message loss
**Effort**: 4-5 hours
1. Add queuedMessages table to schema
2. Implement ACK protocol in cloud-message-bus
3. Update router.ts to use ACK waiting
4. Implement alerting for failed spawns
5. Add retry logic with exponential backoff

### Phase 3: Correlation & Tracing
**Priority**: P1 - Improves debugging
**Effort**: 3-4 hours
1. Add correlationId to queuedMessages
2. Propagate correlationId through all handlers
3. Link fix_attempts/ci_fix_attempts by correlation
4. Build query tools for tracing

### Phase 4: Thread Timestamp Validation
**Priority**: P2 - Edge case handling
**Effort**: 1-2 hours
1. Add thread age validation to responders
2. Fallback to channel post for old threads

---

## Success Metrics

| Metric | Current | Target | Timeline |
|--------|---------|--------|----------|
| Threads drop off | Frequent | 0 incidents | P1 completion |
| Message ACK failures detected | 0 | 100% | P2 completion |
| Message delivery success rate | Unknown | 99%+ | P2 completion |
| Spawn command failures alerted | No | Yes | P2 completion |
| Avg time to diagnose issue | Hours | Minutes | P3 completion |
| Daemon downtime detection | Manual | Automatic | P2 completion |

---

## Files to Modify Summary

| File | Phase | Changes |
|------|-------|---------|
| `router.ts` | 1, 2, 3 | Add threadTs, implement ACK waiting, correlationId |
| `schema.ts` | 1, 2, 3 | Add thread fields, queuedMessages table, correlationId |
| `cloud-message-bus.ts` | 2, 3 | Implement ACK protocol, tracing |
| `responders/slack.ts` | 4 | Thread timestamp validation |
| `mention-handler.ts` | 3 | Propagate correlationId |
| `ci-agent-spawner.ts` | 3 | Propagate correlationId |

---

## Testing Strategy

1. **Unit Tests**: ACK protocol, correlation ID generation, thread validation
2. **Integration Tests**: Webhook → spawn → agent → response with threadTs
3. **Error Tests**: Daemon offline, timeout, retry logic
4. **E2E Tests**: User mention → agent spawn → response in thread
5. **Load Tests**: Message queueing under high volume
6. **Chaos Tests**: Daemon failures, network issues, timeout scenarios

---

## Rollout Plan

1. Deploy Phase 1 to staging - verify thread context works
2. Deploy Phase 2 to staging - test ACK protocol with real daemons
3. Canary Phase 1+2 to production (10% traffic)
4. Monitor metrics for 24 hours
5. Full rollout if metrics healthy
6. Deploy Phase 3+4 after P1+2 stable in production

---

## Monitoring & Alerting

**Alerts to Implement**:
1. Message ACK timeout (warning after 5s, critical after 3 retries)
2. Daemon offline detected
3. Thread_ts propagation failures
4. High spawn command failure rate (>1%)

**Dashboard Metrics**:
1. Messages queued vs acked (stacked bar chart)
2. Spawn success rate by daemon
3. Thread context propagation success rate
4. Average ACK latency

---

## References

- Investigation Report: Analysis of webhook handling, thread context, ACK logic
- Affected Files:
  - `/packages/cloud/src/webhooks/router.ts` (lines 223-237, 196-206)
  - `/packages/cloud/src/webhooks/parsers/slack.ts` (lines 119-122)
  - `/packages/cloud/src/services/cloud-message-bus.ts` (entire file)
  - `/packages/cloud/src/db/schema.ts` (lines 650-799)
