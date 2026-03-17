# AI SDK + Relay Helpdesk Example

A small consumer-facing Next.js app that uses the AI SDK adapter as the point-person layer and escalates bigger requests into a Relay workflow.

## What it demonstrates

- `onRelay()` attached to an AI SDK model via `wrapLanguageModel()`
- normal user-facing chat turns through `streamText()`
- a simple escalation gate that kicks off `runWorkflow()` for longer multi-step work
- a workflow file that uses a lead + specialist review path

## Files

- `app/page.tsx` — tiny browser UI
- `app/api/chat/route.ts` — AI SDK route with Relay communicate middleware
- `workflows/helpdesk-escalation.yaml` — Relay workflow used for escalations

## Run

```bash
cd examples/ai-sdk-relay-helpdesk
npm install
npm run dev
```

Set the env vars your app needs first, for example:

```bash
export OPENAI_API_KEY=...
export RELAY_API_KEY=...
export RELAY_BASE_URL=http://localhost:3888
```

Then open `http://localhost:3000` and try:

- a normal question like `Summarize the latest support issue`
- an escalation like `Please escalate: coordinate a migration plan for repo X`

If the prompt begins with `Please escalate:`, the route starts the Relay workflow and returns the workflow run id instead of trying to finish everything in one chat turn.
