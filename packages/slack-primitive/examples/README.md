# Slack Primitive Examples

## Manual Smoke Test

First, set `SLACK_BOT_TOKEN` to a bot token with `chat:write`, `channels:read`, `groups:read`, `users:read`, and `users:read.email` scopes. Then invite the bot to the destination channel and set `SLACK_CHANNEL` to either a channel id or a `#channel-name` reference.

Run the notification example from `packages/slack-primitive`:

```bash
SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL=#engineering npx tsx examples/notify-on-pr.ts
```

The workflow should open the configured GitHub pull request step and then post a one-line Slack announcement containing the pull request URL. Use `GITHUB_REPO`, `GITHUB_BASE_BRANCH`, and `GITHUB_BRANCH_OVERRIDE` to point the GitHub step at a prepared sandbox branch.
