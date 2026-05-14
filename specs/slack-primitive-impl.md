# Slack Primitive — Implementation Workflow

**Status**: Ready
**Date**: 2026-05-08
**Design spec**: [`specs/slack-primitive.md`](./slack-primitive.md)
**Runtime**: local

This is the implementation prompt for ricky. The full design lives in `specs/slack-primitive.md`. This file exists so ricky has an unambiguous, local-only generation target without having to disambiguate the design doc's runtime-selection discussion.

## Goal

Implement the `packages/slack-primitive` package as described in the design spec. Mirror the layout of `packages/github-primitive` 1:1.

## Files to create

Target files (bare paths so the spec parser picks them up as `targetFiles`):

- packages/slack-primitive/package.json
- packages/slack-primitive/tsconfig.json
- packages/slack-primitive/src/index.ts
- packages/slack-primitive/src/types.ts
- packages/slack-primitive/src/client.ts
- packages/slack-primitive/src/workflow-step.ts
- packages/slack-primitive/src/local-runtime.ts
- packages/slack-primitive/src/adapter.ts
- packages/slack-primitive/src/actions/post-message.ts
- packages/slack-primitive/src/actions/resolve-user.ts
- packages/slack-primitive/src/actions/resolve-channel.ts
- packages/slack-primitive/src/__tests__/post-message.test.ts
- packages/slack-primitive/examples/notify-on-pr.ts
- packages/slack-primitive/examples/README.md

## Scope (Phase A of the design spec)

Phase A only — postMessage + resolveUser + resolveChannel, with the local Web API runtime. Do not implement askQuestion, the Nango proxy transport, or interactive Block Kit forms in this pass.

Concretely:

1. Create `packages/slack-primitive/` with `src/index.ts`, `src/types.ts`, `src/client.ts`, `src/workflow-step.ts`, `src/local-runtime.ts`, `src/adapter.ts`, and `src/actions/{post-message,resolve-user,resolve-channel}.ts`.
2. Wire `SLACK_BOT_TOKEN` env-var auth in `local-runtime.ts`. Throw `SlackPostBackError('auth_token_missing')` if absent.
3. Implement `createSlackStep` with `action: 'postMessage'`, supporting `channel`, `text`, `threadTs`, `mentions`, `unfurl`, and `{{steps.X.output.path}}` templating.
4. Mention resolution: `@email@example.com` → `users.lookupByEmail`; bare handle `@khaliq` → user-cache lookup; raw user IDs pass through. Unresolved mentions are a soft error (logged on step output, message still posts).
5. Channel resolution: `#name` → `conversations.list` + match; channel IDs pass through.
6. Add an example workflow at `packages/slack-primitive/examples/notify-on-pr.ts` that posts a one-line PR-opened announcement (paired with `github-primitive`'s `createPR` step).
7. Add unit tests in `packages/slack-primitive/src/__tests__/` covering: token-missing error, channel name resolution, mention resolution success and soft-fail, `{{steps.X.output}}` templating substitution.

## Constraints

- Runtime: local only. Do not generate the alternate-runtime adapter, the Nango proxy code, or the fallback-transport code in this pass — those land in later phases described in the design spec.
- Use `@slack/web-api` as the underlying SDK.
- TypeScript ES modules, follow the conventions in `.claude/rules/typescript.md`.
- Match the public-API shape of `packages/github-primitive` so a developer who learned one can read the other in five minutes.
- Do not modify `packages/github-primitive`. Do not modify the design spec.

## Acceptance gates

1. `pnpm -F slack-primitive build` passes.
2. `pnpm -F slack-primitive test` passes with the unit tests above green.
3. `examples/notify-on-pr.ts` type-checks against the rest of the SDK.
4. A workflow that imports `createSlackStep` and posts to a real channel succeeds when `SLACK_BOT_TOKEN` is set and the bot is invited to the channel. (Manual smoke test — document the steps in `examples/README.md`.)

## Out of scope

- askQuestion (Phase B in the design spec).
- The alternate-runtime adapter and its transports (Phase A's second half + Phase C in the design spec).
- Interactive Block Kit, addReaction, updateMessage, replyToThread (Phase C).
- Workflow runner schema changes for askQuestion audit trail (tracked in issue #825).
