---
name: relay-protocol
description: Use when a Gemini relay agent needs to communicate with a lead or worker - defines ACK/DONE messaging and inbox discipline
---

# Relay Protocol

All Gemini relay agents should follow a simple communication contract: acknowledge the task quickly, do the work, and report completion clearly.

## Required Signals

- `ACK: <your understanding of the task>`
- `DONE: <what you accomplished>`

Send status updates to your lead, not as broad channel chatter, unless the task explicitly requires channel coordination.

## Start Of Task

1. Check your inbox with `mcp_relaycast_inbox_check`.
2. Identify who assigned the work.
3. Send an ACK with your understanding of the task and any important assumptions.

Example:

```text
ACK: I’m reviewing the Gemini hook output format and will report any spec mismatches.
```

## During Work

- Check your inbox periodically during long tasks.
- If you are missing critical context, send one clear question to your lead.
- If the task changes, send a refreshed ACK or short status note so your lead knows you adjusted course.

## Completion

Send one DONE message with the outcome, not a long play-by-play.

A good DONE message includes:
- What you completed
- Important files or artifacts
- Any open risks or follow-up items

Example:

```text
DONE: Added the BeforeModel hook and Gemini command TOML files. Risk: needs end-to-end validation inside Gemini CLI.
```

## Lead Expectations

Leads should:
- ACK worker ACKs when clarification is needed
- Keep tasks bounded and concrete
- Watch the inbox for blocked or completed workers
- Synthesize worker output instead of forwarding raw message spam

## Worker Expectations

Workers should:
- Stay within the assigned scope
- Prefer direct replies to the lead
- Report DONE promptly when the task is complete
- Avoid spawning more agents unless the task explicitly calls for it
