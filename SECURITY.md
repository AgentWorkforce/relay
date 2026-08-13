# Security Policy

## Human sponsor binding

Agent registration is a delegated identity issuance action, not a capability of
the shared workspace key by itself. Chief obtains an `identity.create` sponsor
proof from RelayAuth for the currently SSO-authenticated human and passes the
returned values to the broker as `RELAYAUTH_SPONSOR_ID` and
`RELAYAUTH_SPONSOR_PROOF`, together with the pinned
`RELAYAUTH_SIGNING_KEY_PEM_PUBLIC`, `RELAYAUTH_ISSUER`, and
`RELAYAUTH_SPONSOR_ORG_ID`. The broker validates those claims before startup,
then sends the signed proof and a secret work-unit key to Relaycast's
registration authority. Relaycast independently verifies the RS256 signature,
pinned key ID, issuer, organization, audience, expiry, `identity.create` intent,
token type, and OIDC subject before it creates a workspace, registers an agent,
or rotates an agent credential. This server-side check is the security
boundary: a workspace key holder calling the REST API, node-control socket, or
A2A endpoint directly cannot bypass it.

Relaycast stores the sponsor and work-unit binding in immutable database
columns and a durable name claim, never in caller-editable agent metadata. It
stores only a digest of the replayable proof. Crash recovery must present the
same sponsor and secret work-unit key. A legacy agent with no immutable binding
can be bound once only by presenting its incumbent agent bearer token; a
workspace key is deliberately insufficient.

### Sponsor-enforcement rollout order

Existing persistent brokers need a staged rollout because older versions did
not retain their incumbent agent token. Deploy the client update first and
restart every persistent broker while the old registration authority is still
active. A successful startup writes an owner-only, atomically replaced
`state-<broker>.json.agent-credentials.json` cache beside broker state. The file
contains the scoped agent token and only a SHA-256 fingerprint of the workspace
key.

After that pre-stage is verified across the fleet, migrate the Relaycast
database and enable its sponsor-verification configuration. On the next broker
restart, the cached token authenticates the exact incumbent agent and performs
the one-time immutable binding. Hosts that skipped the pre-stage need their
incumbent `RELAY_AGENT_TOKEN` supplied explicitly; they fail closed rather than
falling back to a workspace-key-only reclaim. Do not enable hosted enforcement
before the client pre-stage is complete.

Agent Relay moves messages, credentials, and tool invocations between
autonomous agents. A defect here can expose a workspace to agents — or people —
that should never have reached it, so we treat security reports as a priority
over feature work.

## Reporting a vulnerability

**Report privately through GitHub Security Advisories:**

> https://github.com/AgentWorkforce/relay/security/advisories/new

That form is visible only to the maintainers until an advisory is published,
and it lets us open a private fix branch and credit you on release.

**Please do not** report vulnerabilities through public GitHub issues, pull
requests, or the Discord server. Those are public the moment you post, which
puts every workspace running the affected version at risk before a fix exists.

If GitHub Security Advisories is unavailable to you, open a public issue that
says only that you have a security report and asks for a private channel —
no details, no reproduction steps — and a maintainer will follow up.

### What to include

The more of this you can provide, the faster we can confirm and fix:

- The affected component and version (`agent-relay --version`, the npm package
  and version, or the broker build).
- The type of issue (authentication bypass, credential disclosure, injection,
  privilege escalation across agents, denial of service, and so on).
- Step-by-step reproduction, ideally as a minimal workspace or script.
- The impact: what an attacker gains, and what access they need to start.
- Any proof-of-concept code, logs, or transcripts.

**Redact credentials before you send them.** Workspace keys, broker keys,
observer tokens, API keys, and OAuth tokens frequently appear in Relay logs and
terminal transcripts. Replace them with placeholders. If a report requires a
live credential to demonstrate, say so and we will arrange a channel for it
rather than having it sit in an advisory thread.

### What to expect

- **Acknowledgement:** we aim to confirm receipt within 3 business days.
- **Assessment:** we aim to confirm or dispute the report, with a severity
  assessment, within 10 business days.
- **Updates:** we will keep you posted on remediation progress, and will tell
  you if a fix is going to take longer than expected.
- **Disclosure:** we publish an advisory once a fixed version is available. We
  will credit you by name or handle unless you prefer otherwise.

We ask that you give us a reasonable opportunity to ship a fix before
disclosing publicly. We do not run a paid bug bounty.

## Supported versions

We investigate reports against any release on the lines below. Fixes ship only
at the head of that line: we do not patch earlier minors in place, and we do
not backport across majors. If you are running an older 11.x, upgrading to the
current 11.x is how you receive the fix.

| Component                                       | Reports investigated | Fix delivered in |
| ----------------------------------------------- | -------------------- | ---------------- |
| `agent-relay` CLI and `@agent-relay/*` packages | any 11.x             | latest 11.x      |
| `agent-relay-broker` crate                      | any 3.x              | latest 3.x       |

Releases before 11.0 (CLI and packages) and before 3.0 (broker) are
unsupported — we will not investigate a report that reproduces only there.
Upgrade before reporting against an older release; the issue may already be
fixed.

## Scope

**In scope:**

- The `agent-relay` CLI and the published `@agent-relay/*` npm packages.
- The `agent-relay-broker` Rust crate and its prebuilt platform binaries.
- The message protocol itself: authentication, authorization between agents,
  workspace and channel isolation, delivery integrity, action routing.
- Credential handling: how keys and tokens are stored on disk, passed to
  spawned harnesses, and surfaced in output, logs, and error text.
- Agent-to-agent trust boundaries, including prompt or tool injection that
  crosses from message content into another agent's privileged actions.

**Out of scope:**

- Vulnerabilities in third-party agent harnesses (Claude Code, Codex, Gemini
  CLI, and others). Report those to their maintainers; tell us if Relay's
  integration makes an existing harness issue materially worse.
- Findings that require an attacker to already hold the same local user account
  as the agent process. Weaknesses that let a _different_ local user or process
  reach agent state — group- or world-readable key files, permissive directory
  modes, predictable paths in shared temp directories — are in scope.
- Dependency advisories with no demonstrated exploit path through Relay. We
  track these through automated scanning; a report is welcome if you can show
  the path.
- Missing hardening headers, TLS configuration, or similar findings on the
  marketing site, absent a concrete impact.
- Reports generated by automated scanners with no validation or reproduction.

## Security tooling

`.github/workflows/security.yml` runs on pushes to `main`, on pull requests
targeting `main`, and weekly. Coverage is not uniform, so it is worth being
precise about what actually runs:

- **Gitleaks secret scanning** runs on every trigger.
- **CodeQL, `npm audit`, and license compliance** run only when a change
  touches the Node toolchain, so docs-only and Swift-only changes skip them.
- **Dependency review** runs on pull requests only.
- **CodeQL analyzes JavaScript and TypeScript only.** The `agent-relay-broker`
  Rust crate is in scope for this policy but is not covered by CodeQL.
- Several of these jobs are advisory rather than blocking, so a green run does
  not by itself mean no findings.

Automated scanning catches regressions in the paths it covers. It is not a
substitute for the reports we get from you, and the gaps above are exactly
where your reports matter most.
