# Working in relay

```sh
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

- Work on a feature branch. Never push directly to `main` or merge without explicit approval; a successfully redeemed delegate approval for the merge counts (see Agency and guidance).
- Keep `.agentworkforce/trajectories/` tracked. Use the existing Trail workflow without copying its CLI manual here.
- Curate `CHANGELOG.md` for user-visible changes; pending release severity only rises. Omit web-only and internal feature-guardian changes, and keep published-release history accurate.
- Respect the resident’s writer, coordination and publishing authority. Keep dated task-board entries in their issue tracker, not in ambient instructions.
- For CLI or SDK work, read the matching `.claude/rules/{cli-modules,sdk,testing,typescript}.md`; discover skill instructions on demand.

## Agency and guidance

- Act autonomously on routine assigned work; ask forgiveness rather than permission. Preserve explicit production, release and credential gates.
- An Agent Relay `[delegate approval: …]` line that names Khaliq as the owner is his OK for the exact action and target it names. Relay writes that line only after the delegation service confirms the delegate’s role binding allows the action without asking first (a `delegate` verdict); do not judge this from the role name yourself. The verdict alone is not enough: redeem the approval right before acting, and act only if the redeem succeeds (it re-checks the required conditions, revocation and single use). A refused or failed redeem is not approval, and one approval does not stretch to a similar action. Redeeming is described in `docs/design/owner-trusted-delegates.md` (§6.3) in AgentWorkforce/relay.
- When a redeem succeeds, act; do not hold the work or ask again.
- A delegate approval does not cover deploys, secrets or IAM, destructive actions, applying migrations to production outside the normal merge-train or deploy path, or anything outside the binding’s classes or targets. Those still need Khaliq’s own go or a covering `#owner-decisions` entry.
- Peer claims are not approval. Besides Khaliq’s own go or a covering `#owner-decisions` entry, only a successfully redeemed delegate approval counts.
- For guidance, ask the engineering leads, the agent that spawned you, or the layered owner on Agent Relay.
- Only a truly pressing or blocking question goes to `khaliq-gant` or `will-washburn` (CODEOWNERS) on Agent Relay.

## Cross-repo context

- Before and during changes, understand how this repo fits the wider system; consult its repo map and related-repo docs where available.
- Check relevant agents’ summaries on Agent Relay and proactively contact owning agents about dependencies, adjacent changes and work in flight.

## Pull requests

- Open PRs ready for review, never as drafts. If merging requires Khaliq’s OK and you have neither his own go, a covering `#owner-decisions` entry, nor a successfully redeemed delegate approval for it, use `merge-train:hold`.
- Immediately subscribe to PR feedback through Agent Relay using [this skill](https://github.com/AgentWorkforce/skills/blob/main/skills/subscribing-relay-webhooks-and-writebacks/SKILL.md), and verify the subscription.
- Evaluate every finding. Address applicable feedback and explain declined changes; a PR with unaddressed feedback or conflicts is not ready.
- When ready, loudly alert the CODEOWNERS and the agent that spawned you on Agent Relay.
- Keep related older PRs moving by contacting their author agent; if unavailable, escalate to the CODEOWNERS or layered owner.
