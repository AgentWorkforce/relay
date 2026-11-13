# Plan 002: License the self-hosted stack as FSL with an Enterprise tier

> **Executor instructions**: Do not change any LICENSE file until every STOP
> condition below is cleared and a maintainer has confirmed the legal review in
> writing. When complete, update this plan's status in `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM (legal and community)
- **Depends on**: none
- **Category**: licensing / business model
- **Planned at**: 2026-11-12
- **State**: PROPOSED (decision made, legal review pending)

## Outcome

- **Free to self-host for everyone.** The self-hosted stack and the desktop app
  move to the [Functional Source License](https://fsl.software),
  `FSL-1.1-Apache-2.0`. Any organization can self-host and modify it for its own
  use, at any size. Nobody can offer it as a competing hosted service. Each
  release becomes Apache-2.0 two years after it ships.
- **Enterprise features under a commercial license.** An `ee/` area (per repo)
  under an "Agent Relay Enterprise License": source visible, free for
  development and evaluation, production use needs an Agent Relay Enterprise
  agreement. Initial set: single sign-on (OIDC/Okta), SCIM provisioning, audit
  logs, hard delete and retention controls, multi-team administration.
- **What Enterprise sells** beyond the `ee/` features: desktop builds signed and
  notarized by Agent Relay for the customer's domain, supported releases with
  tested upgrades, and support with an SLA.
- **The `relay` SDK and CLI stay Apache-2.0**, since developers use them against
  Agent Relay Cloud and self-hosted installs alike.

## Why

- Open core plus a fair-source license is the common, well-understood model for
  early-stage developer tools that offer self-hosting.
- A company-size threshold (for example BSL with a size-based grant, or PolyForm
  Small Business) was considered and rejected: it relies on self-reported
  headcount, and it is unusual at this stage.
- A license key cannot stop a determined team from patching it out, especially
  with coding agents, and that is not its job. Large organizations pay because
  the license and their own compliance require it, and because they need the
  signed builds, supported upgrades and support.

## Scope

| Repo | Today | Target |
|---|---|---|
| AgentWorkforce/infra | Apache-2.0 | FSL-1.1-Apache-2.0 |
| AgentWorkforce/helm-charts | Apache-2.0 | FSL-1.1-Apache-2.0 |
| Services shipped in the self-host images (relaycast, relayhistory-pipeline, control plane, others) | Apache-2.0 | FSL-1.1-Apache-2.0, with `ee/` for Enterprise features |
| relay-desktop | Apache-2.0 (private) | FSL-1.1-Apache-2.0 when it opens |
| AgentWorkforce/relay (SDK, CLI, broker) | Apache-2.0 | Unchanged |

Releases already published keep Apache-2.0. The new license applies from the
first release after the change.

## Steps

1. **Contributor consent.** List every non-employee author per repo
   (`git log --format='%an <%ae>' | sort -u`) and get written consent or a
   rights assignment from each one for relicensing.
2. **Legal review** of the FSL text and the Enterprise License, including the
   exact list of Enterprise features and the definition of production use.
3. **Mark the boundary.** Move Enterprise features behind an `ee/` path in each
   affected repo, with a short `ee/LICENSE`.
4. **License key (light).** An offline, signed token (organization, expiry,
   features, seats) checked against a public key built into the control plane.
   No phone-home; about 30 days of grace after expiry; nothing is deleted. It
   makes the terms visible in the product. It is not a security control.
5. **Swap the license files** in each repo in one coordinated release, add
   `LICENSE` headers where required, and update package metadata (`license`
   fields, chart annotations).
6. **Docs.** agentrelay.com `/docs/self-hosting` already describes the plan in a
   Licensing section and labels single sign-on as an Enterprise feature. Update
   it to "in effect" with the release number once step 5 ships.
7. **Announce** with the release notes.

## STOP conditions

- Any contributor in scope has not consented: stop and exclude or rewrite their
  code before relicensing that repo.
- Legal review is not complete or recommends changes to the model.
- An existing customer agreement conflicts with the new terms.
