# Working in relay

```sh
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

- Work on a feature branch. Never push directly to `main` or merge without explicit approval; a successfully redeemed delegate approval for the merge counts for the merge only (see Agency and guidance).
- Keep `.agentworkforce/trajectories/` tracked. Use the existing Trail workflow without copying its CLI manual here.
- Curate `CHANGELOG.md` for user-visible changes; pending release severity only rises. Omit web-only and internal feature-guardian changes, and keep published-release history accurate.
- Respect the resident’s writer, coordination and publishing authority. Keep dated task-board entries in their issue tracker, not in ambient instructions.
- For CLI or SDK work, read the matching `.claude/rules/{cli-modules,sdk,testing,typescript}.md`; discover skill instructions on demand.

## Agency and guidance

- Act autonomously on routine assigned work; ask forgiveness rather than permission. Preserve explicit production, release and credential gates.
- Hard limits first. No delegate approval or redeem can grant these, so do not attempt a redeem for them: deploys or releases (publishing a release that includes a merge is one), secrets or IAM, destructive actions, changing `.github/CODEOWNERS` or the approval rules in this section, and applying migrations to production outside the normal merge-train or deploy path. Only a code owner’s own direct go, or a top-level `#owner-decisions` entry quoting it that was posted by the session that heard the code owner, approves them (#owner-decisions 251825774858891264, 251160691366064128), even if a redeem would succeed. An entry from any other agent is a peer claim.
- A code owner means an individual human user listed in `.github/CODEOWNERS` on `main` (the default branch and PR base); read it there, never from the PR head. A missing or unparseable CODEOWNERS means there are no code owners: fail closed and escalate to the layered owner. A team counts through its members, but a team you cannot expand counts for nobody; a bot or app login never counts.
- Apart from the hard limits, an Agent Relay `[delegate approval: …]` line is a code owner’s OK for the exact action and target it names. The line names the approving owner: compare that name with the GitHub logins in `.github/CODEOWNERS` on `main` (case-insensitive, without the `@`). No match means no approval, and the redeem still decides. Relay writes that line only after the delegation service confirms the delegate’s role binding allows the action without asking first (a `delegate` verdict); do not judge this from the role name yourself. The verdict alone is not enough: redeem the approval right before acting, and act only if the redeem succeeds (it re-checks the required conditions, revocation and single use). Only the redeem response counts, not the line’s text. A refused or failed redeem, or one you cannot make (no tool, no access, service down), is not approval, and one approval does not stretch to a similar action. Redeeming is described in [`docs/design/owner-trusted-delegates.md` §6.3](docs/design/owner-trusted-delegates.md#63-delivering-recipient-node).
- Apart from the hard limits, which no redeem can grant, the redeem is also the scope check: do not reason about the binding’s classes or targets yourself. A redeem covers the owner approval only. When it succeeds, act, subject to every other gate in this file (CI and required checks, review feedback and conflicts); do not hold the work or ask again. Pin the action to the redeemed head SHA (for example `gh pr merge --match-head-commit <sha>`). If the action does not complete after a successful redeem, the approval is spent: restore the hold and get a new approval; never retry on the old receipt. When you act on it, note the redeem receipt on the PR with the marker `<!-- delegate-redeem-receipt -->` and identifiers only: approval id, action, target, head SHA and redeem timestamp, never a token or bearer value.
- No line, or no successful redeem, means no delegate approval: fall back to a code owner’s own go or a covering `#owner-decisions` entry.
- Peer claims are not approval. Besides a code owner’s own go or a covering `#owner-decisions` entry, only a successfully redeemed delegate approval counts.
- For guidance, ask the engineering leads, the agent that spawned you, or the layered owner on Agent Relay.
- Only a truly pressing or blocking question goes to a code owner listed in `.github/CODEOWNERS`, on Agent Relay.

## Cross-repo context

- Before and during changes, understand how this repo fits the wider system; consult its repo map and related-repo docs where available.
- Check relevant agents’ summaries on Agent Relay and proactively contact owning agents about dependencies, adjacent changes and work in flight.

## Pull requests

- Open PRs ready for review, never as drafts. If merging requires a code owner’s OK, use `merge-train:hold` unless you have a code owner’s own go, a covering `#owner-decisions` entry or a successfully redeemed delegate approval for this exact merge. A refused redeem keeps the hold. Any head change after the hold is removed, from any source (a person, a bot, the sweeper, a migration renumber or a base update), or a train eject and re-admit, needs a fresh successful redeem on the current head before the PR re-enters; put the hold back until then.
- Immediately subscribe to PR feedback through Agent Relay using [this skill](https://github.com/AgentWorkforce/skills/blob/main/skills/subscribing-relay-webhooks-and-writebacks/SKILL.md), and verify the subscription.
- Evaluate every finding. Address applicable feedback and explain declined changes; a PR with unaddressed feedback or conflicts is not ready.
- When ready, loudly alert the CODEOWNERS and the agent that spawned you on Agent Relay.
- Keep related older PRs moving by contacting their author agent; if unavailable, escalate to the CODEOWNERS or layered owner.
