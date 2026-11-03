# Security Policy

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

- The affected component and version (`agent-relay --version`, or the npm
  package and version).
- The type of issue (authentication bypass, credential disclosure, injection,
  privilege escalation across agents, denial of service, and so on).
- Step-by-step reproduction, ideally as a minimal workspace or script.
- The impact: what an attacker gains, and what access they need to start.
- Any proof-of-concept code, logs, or transcripts.

**Redact credentials before you send them.** Workspace keys, agent tokens, node tokens,
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

Releases before 11.0 (CLI and packages) are unsupported — we will not
investigate a report that reproduces only there. The `agent-relay-broker`
Rust broker and the `@agent-relay/harness-driver`, `@agent-relay/harnesses`,
`@agent-relay/fleet`, `@agent-relay/evals` and `@agent-relay/broker-*` packages were retired: their
published versions stay installable but receive no further releases, so a
report that reproduces only there is out of scope.
Upgrade before reporting against an older release; the issue may already be
fixed.

## Scope

**In scope:**

- The `agent-relay` CLI and the published `@agent-relay/*` npm packages, except
  the retired packages listed under Supported versions.
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
- **CodeQL analyzes JavaScript and TypeScript only.** The Rust code in this
  repository is not covered by CodeQL.
- Several of these jobs are advisory rather than blocking, so a green run does
  not by itself mean no findings.

Automated scanning catches regressions in the paths it covers. It is not a
substitute for the reports we get from you, and the gaps above are exactly
where your reports matter most.
