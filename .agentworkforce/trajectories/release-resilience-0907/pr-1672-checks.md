# Existing PR #1672 check snapshot

Head: `79d0fbf6cfea5b25658455aa76752ec7329bd205`. Mergeability: `CONFLICTING`.

This is not CI for the release-resilience lane. SKIPPED means absent coverage.

| Workflow | Job | Result |
| --- | --- | --- |
| CI | [changes / Detect change scope](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489342946) | SUCCESS |
| E2E Tests | [E2E Integration Test (ubuntu-latest, 22.14.0)](https://github.com/AgentWorkforce/relay/actions/runs/34034264020/job/101489342762) | SUCCESS |
| Fleet E2E | [Two-node fleet matrix](https://github.com/AgentWorkforce/relay/actions/runs/34034264021/job/101489342751) | SUCCESS |
| Large File Check | [check](https://github.com/AgentWorkforce/relay/actions/runs/34034264017/job/101489342507) | SUCCESS |
| Node.js Compatibility | [changes / Detect change scope](https://github.com/AgentWorkforce/relay/actions/runs/34034264110/job/101489342958) | SUCCESS |
| Package Validation | [changes / Detect change scope](https://github.com/AgentWorkforce/relay/actions/runs/34034264113/job/101489343126) | SUCCESS |
| Prettier Auto-Format | [Auto-format Prettier files](https://github.com/AgentWorkforce/relay/actions/runs/34034264026/job/101489342601) | SUCCESS |
| Relay Evals | [Offline evals](https://github.com/AgentWorkforce/relay/actions/runs/34034264008/job/101489342923) | SUCCESS |
| RelayFlow PR Proof | [RelayFlow PR proof dispatcher](https://github.com/AgentWorkforce/relay/actions/runs/34034263051/job/101489339825) | SUCCESS |
| RelayFlow PR Proof Broker | [Build exact Linux broker](https://github.com/AgentWorkforce/relay/actions/runs/34034263072/job/101489339868) | SUCCESS |
| Rust Auto-Format | [Auto-format Rust code](https://github.com/AgentWorkforce/relay/actions/runs/34034264042/job/101489342512) | SUCCESS |
| Security Scan | [changes / Detect change scope](https://github.com/AgentWorkforce/relay/actions/runs/34034264096/job/101489343017) | SUCCESS |
| Test | [changes / Detect change scope](https://github.com/AgentWorkforce/relay/actions/runs/34034264112/job/101489343157) | SUCCESS |
| E2E Tests | [E2E Integration Test (macos-latest, 22.14.0)](https://github.com/AgentWorkforce/relay/actions/runs/34034264020/job/101489342606) | FAILURE |
| CI | [Rust Tests (ubuntu-latest)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498495) | SUCCESS |
| Node.js Compatibility | [Install Test (Node 22.14.0)](https://github.com/AgentWorkforce/relay/actions/runs/34034264110/job/101489485950) | SUCCESS |
| Package Validation | [Build & Validate](https://github.com/AgentWorkforce/relay/actions/runs/34034264113/job/101489516143) | SUCCESS |
| Security Scan | [Dependency Review](https://github.com/AgentWorkforce/relay/actions/runs/34034264096/job/101489342892) | SUCCESS |
| Test | [test (ubuntu-latest, 22.14.0)](https://github.com/AgentWorkforce/relay/actions/runs/34034264112/job/101489522575) | SUCCESS |
| CI | [Rust Tests (macos-latest)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498552) | FAILURE |
| Node.js Compatibility | [Install Test (Node 24)](https://github.com/AgentWorkforce/relay/actions/runs/34034264110/job/101489485955) | SUCCESS |
| Test | [test (macos-latest, 22.14.0)](https://github.com/AgentWorkforce/relay/actions/runs/34034264112/job/101489522662) | SUCCESS |
| CI | [Relay PTY Synchronization Tests (windows-latest)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498619) | SUCCESS |
| Node.js Compatibility | [Fresh Install (Node 22.14.0)](https://github.com/AgentWorkforce/relay/actions/runs/34034264110/job/101489485992) | SUCCESS |
| Package Validation | [Publish Fresh Install Build](https://github.com/AgentWorkforce/relay/actions/runs/34034264113/job/101489516106) | SUCCESS |
| Security Scan | [Secret Scanning](https://github.com/AgentWorkforce/relay/actions/runs/34034264096/job/101489343004) | SUCCESS |
| Test | [Coverage (upload)](https://github.com/AgentWorkforce/relay/actions/runs/34034264112/job/101489522559) | SUCCESS |
| Node.js Compatibility | [Fresh Install (Node 24)](https://github.com/AgentWorkforce/relay/actions/runs/34034264110/job/101489486052) | SUCCESS |
| CI | [Cross-compile check (aarch64-unknown-linux-gnu)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498492) | SUCCESS |
| Package Validation | [Standalone macOS Smoke](https://github.com/AgentWorkforce/relay/actions/runs/34034264113/job/101489516174) | SUCCESS |
| Security Scan | [NPM Audit](https://github.com/AgentWorkforce/relay/actions/runs/34034264096/job/101489499955) | SUCCESS |
| Test | [lint](https://github.com/AgentWorkforce/relay/actions/runs/34034264112/job/101489522563) | SUCCESS |
| CI | [Cross-compile check (x86_64-apple-darwin)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498536) | SUCCESS |
| Test | [Swift SDK Tests](https://github.com/AgentWorkforce/relay/actions/runs/34034264112/job/101489523650) | SKIPPED |
| CI | [Clippy (ubuntu-latest)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498593) | SUCCESS |
| Security Scan | [CodeQL Analysis](https://github.com/AgentWorkforce/relay/actions/runs/34034264096/job/101489500244) | SUCCESS |
| CI | [Clippy (macos-latest)](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498498) | SUCCESS |
| CI | [Format](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498461) | SUCCESS |
| Security Scan | [License Compliance](https://github.com/AgentWorkforce/relay/actions/runs/34034264096/job/101489499998) | SUCCESS |
| CI | [SDK TypeScript Check](https://github.com/AgentWorkforce/relay/actions/runs/34034264111/job/101489498558) | SUCCESS |
|  | [cubic · AI code reviewer](https://www.cubic.dev/pr/AgentWorkforce/relay/pull/1672) | NEUTRAL |
|  | [CodeQL](https://github.com/AgentWorkforce/relay/runs/101489886418) | SUCCESS |
| External status | CodeRabbit | SUCCESS |
| External status | [Devin Review](https://app.devin.ai/review/agentworkforce/relay/pull/1672) | SUCCESS |
| External status | [RelayFlow PR proof](https://github.com/AgentWorkforce/relay/actions/runs/34034263051/attempts/1) | SUCCESS |
