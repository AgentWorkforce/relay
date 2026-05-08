# Slack Primitive Examples

## Runtime selection

`SlackClient` / `SlackStepExecutor` picks one of three runtimes automatically based on what's in the environment:

| Priority | Runtime | Activated by | Transport |
| --- | --- | --- | --- |
| 1 | `cloud-relay` | `CLOUD_API_TOKEN` + `CLOUD_API_URL` | `POST /api/v1/slack/post-message` on relay-cloud, which uses the workspace's Nango Slack connection (the ricky app). The caller never holds a Slack bot token. |
| 2 | `local` | `SLACK_BOT_TOKEN` | `@slack/web-api` direct to Slack. |
| 3 | `noop` | _(neither)_ | Calls succeed, log a warning, and return a placeholder `ts`. Useful for CI / smoke runs where Slack delivery isn't required. |

Override with `runtime: 'local' | 'cloud-relay' | 'noop' | 'auto'` in the config.

> v1 limitation: in `cloud-relay` mode, `resolveUser` and `resolveChannel` throw `unsupported_in_cloud_relay`. Pass Slack user/channel IDs directly. Mention resolution (`@email@example.com`, `@handle`) is local-only.

## Manual Smoke Test (local runtime)

Set `SLACK_BOT_TOKEN` to a bot token with `chat:write`, `channels:read`, `groups:read`, `users:read`, and `users:read.email` scopes. Invite the bot to the destination channel and set `SLACK_CHANNEL` to either a channel id or a `#channel-name` reference.

Run the notification example from `packages/slack-primitive`:

```bash
SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL=#engineering npx tsx examples/notify-on-pr.ts
```

The workflow should open the configured GitHub pull request step and then post a one-line Slack announcement containing the pull request URL. Use `GITHUB_REPO`, `GITHUB_BASE_BRANCH`, and `GITHUB_BRANCH_OVERRIDE` to point the GitHub step at a prepared sandbox branch.

## Manual Smoke Test (cloud-relay runtime)

Connect Slack on the workspace (one-time, via the cloud dashboard's integrations page). Then point the example at relay-cloud with a CLI api token:

```bash
CLOUD_API_TOKEN=rk_cli_... \
CLOUD_API_URL=https://api.agentrelay.com \
SLACK_CHANNEL=#engineering \
npx tsx examples/notify-on-pr.ts
```

No `SLACK_BOT_TOKEN` is required — the message is posted via the workspace's existing Nango Slack connection.
