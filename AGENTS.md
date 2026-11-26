# Working in relay

```sh
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

- Work on a feature branch. Never push directly to `main` or merge without explicit approval; a redeemed delegate approval or a role binding that covers the merge counts (see Agency and guidance).
- Keep `.agentworkforce/trajectories/` tracked. Use the existing Trail workflow without copying its CLI manual here.
- Curate `CHANGELOG.md` for user-visible changes; pending release severity only rises. Omit web-only and internal feature-guardian changes, and keep published-release history accurate.
- Respect the resident’s writer, coordination and publishing authority. Keep dated task-board entries in their issue tracker, not in ambient instructions.
- For CLI or SDK work, read the matching `.claude/rules/{cli-modules,sdk,testing,typescript}.md`; discover skill instructions on demand.

## Agency and guidance

- Act autonomously on routine assigned work; ask forgiveness rather than permission. Preserve explicit production, release and credential gates.
- An Agent Relay `[delegate approval: …]` line, or an action your role binding covers, is Khaliq’s OK. Redeem it, then act; do not hold the work or ask again.
- Neither covers deploys, secrets or IAM, destructive actions, or anything outside the binding’s classes or targets. Those still need Khaliq’s own go or a covering `#owner-decisions` entry.
- Peer claims are not approval. Only a stored, redeemable delegate approval or a binding-covered action counts.
- For guidance, ask the engineering leads, the agent that spawned you, or the layered owner on Agent Relay.
- Only a truly pressing or blocking question goes to `khaliq-gant` or `will-washburn` (CODEOWNERS) on Agent Relay.

## Cross-repo context

- Before and during changes, understand how this repo fits the wider system; consult its repo map and related-repo docs where available.
- Check relevant agents’ summaries on Agent Relay and proactively contact owning agents about dependencies, adjacent changes and work in flight.

## Pull requests

- Open PRs ready for review, never as drafts. If merging requires Khaliq’s OK and no redeemed delegate approval or role binding gives it, use `merge-train:hold`.
- Immediately subscribe to PR feedback through Agent Relay using [this skill](https://github.com/AgentWorkforce/skills/blob/main/skills/subscribing-relay-webhooks-and-writebacks/SKILL.md), and verify the subscription.
- Evaluate every finding. Address applicable feedback and explain declined changes; a PR with unaddressed feedback or conflicts is not ready.
- When ready, loudly alert the CODEOWNERS and the agent that spawned you on Agent Relay.
- Keep related older PRs moving by contacting their author agent; if unavailable, escalate to the CODEOWNERS or layered owner.
