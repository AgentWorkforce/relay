# Trajectory: Fast workspace seeding — symlink mount + tar bulk upload

> **Status:** ❌ Abandoned
> **Task:** [691](https://github.com/AgentWorkforce/relay/pull/691)
> **Started:** April 7, 2026 at 03:28 PM
> **Completed:** April 10, 2026 at 01:22 PM

---

## Key Decisions

### Local symlink mount as default mode for agent-relay on

- **Chose:** Local symlink mount as default mode for agent-relay on
- **Reasoning:** Uploading 18K files / 400MB to relayfile over network was hanging. For solo local use, copying files locally with .agentignore/.agentreadonly enforcement is instant and needs no network. Relayfile only needed for shared/cloud modes.

### Tar-based bulk upload for distributed/shared modes

- **Chose:** Tar-based bulk upload for distributed/shared modes
- **Reasoning:** Reuses proven createTarball() pattern from agent-relay run --cloud. Single gzipped HTTP POST replaces 366 sequential JSON batch uploads. Falls back to existing batch on 404 for backwards compat with servers that dont have the tar import endpoint yet.

### Three CLI modes: default (solo), --shared (multi-agent), --cloud --url (remote)

- **Chose:** Three CLI modes: default (solo), --shared (multi-agent), --cloud --url (remote)
- **Reasoning:** Default should be the fastest path (symlink mount, no network). --shared enables relayfile for multi-agent file collaboration on same machine. --cloud --url for remote cloud environments. Replaces confusing --local/--port-auth/--port-file flags.

### Grant opencode OPENCODE_PERMISSION in workflow runner

- **Chose:** Grant opencode OPENCODE_PERMISSION in workflow runner
- **Reasoning:** Opencode auto-rejects external_directory access in non-interactive mode, blocking cross-repo workflows. Setting OPENCODE_PERMISSION env var with external_directory allow fixes this without requiring changes to opencode itself.

### Preview workflow failure was caused by empty CLOUDFLARE_DEFAULT_ACCOUNT_ID after switching preview-web.yml from secrets.CLOUDFLARE_ACCOUNT_ID to vars.CLOUDFLARE_ACCOUNT_ID

- **Chose:** Preview workflow failure was caused by empty CLOUDFLARE_DEFAULT_ACCOUNT_ID after switching preview-web.yml from secrets.CLOUDFLARE_ACCOUNT_ID to vars.CLOUDFLARE_ACCOUNT_ID
- **Reasoning:** Job 70359516576 authenticated to AWS successfully, then failed in sst deploy with Cloudflare ZoneLookup for pr-695.agentrelay.net. The failing log showed CLOUDFLARE_DEFAULT_ACCOUNT_ID empty, while later successful preview runs showed that env populated.

### Removed the manual SST Command GitHub Actions workflow

- **Chose:** Removed the manual SST Command GitHub Actions workflow
- **Reasoning:** The repository only had a single dedicated workflow file for this action at .github/workflows/sst-command.yml, with no other code or docs references requiring follow-up edits.

### Publish failed because root package tarball contains nested openclaw node_modules hard link from esbuild

- **Chose:** Publish failed because root package tarball contains nested openclaw node_modules hard link from esbuild
- **Reasoning:** npm registry rejects hard-link tar headers; local npm pack reproduced package/packages/openclaw/node_modules/esbuild/bin/esbuild as a hard link to @esbuild platform binary

### Added relay workflow to harden npm publish with validated tarball staging

- **Chose:** Added relay workflow to harden npm publish with validated tarball staging
- **Reasoning:** Most robust long-term fix is to publish a single validated .tgz, exclude nested workspace node_modules from package contents, and run the same tarball gate in PR validation and release publish

### Validated harden-npm-publish workflow with agent-relay dry run

- **Chose:** Validated harden-npm-publish workflow with agent-relay dry run
- **Reasoning:** Dry run parsed the TypeScript workflow, produced 17 steps across 13 waves, and returned validation pass with zero warnings

### Made harden-npm-publish setup idempotent

- **Chose:** Made harden-npm-publish setup idempotent
- **Reasoning:** The first workflow run created .worktrees/npm-publish-hardening and checked out fix/npm-publish-hardening before retrying; subsequent retries failed because the branch was already checked out. The setup step now detects the registered worktree and continues.

---

## Chapters

### 1. Work

_Agent: default_

- Local symlink mount as default mode for agent-relay on: Local symlink mount as default mode for agent-relay on
- Tar-based bulk upload for distributed/shared modes: Tar-based bulk upload for distributed/shared modes
- Three CLI modes: default (solo), --shared (multi-agent), --cloud --url (remote): Three CLI modes: default (solo), --shared (multi-agent), --cloud --url (remote)
- Grant opencode OPENCODE_PERMISSION in workflow runner: Grant opencode OPENCODE_PERMISSION in workflow runner
- Implemented fast workspace seeding across relay and cloud repos. The core problem was agent-relay on hanging on large projects (18K files / 400MB) because it uploaded every file individually to relayfile. Two solutions: (1) symlink mount for solo local use — copies files locally with permission enforcement, no network, instant. (2) tar bulk upload for shared/cloud — single gzipped POST instead of 366 batch requests. Cloud repo gets a tar import endpoint. Relay repo gets the symlink mount module, tar seeder, updated CLI flags (default/--shared/--cloud), and opencode permission fix for cross-repo workflows. PRs: relay#691, cloud#83.
- Preview workflow failure was caused by empty CLOUDFLARE_DEFAULT_ACCOUNT_ID after switching preview-web.yml from secrets.CLOUDFLARE_ACCOUNT_ID to vars.CLOUDFLARE_ACCOUNT_ID: Preview workflow failure was caused by empty CLOUDFLARE_DEFAULT_ACCOUNT_ID after switching preview-web.yml from secrets.CLOUDFLARE_ACCOUNT_ID to vars.CLOUDFLARE_ACCOUNT_ID
- Removed the manual SST Command GitHub Actions workflow: Removed the manual SST Command GitHub Actions workflow
- Publish failed because root package tarball contains nested openclaw node_modules hard link from esbuild: Publish failed because root package tarball contains nested openclaw node_modules hard link from esbuild
- Added relay workflow to harden npm publish with validated tarball staging: Added relay workflow to harden npm publish with validated tarball staging
- Validated harden-npm-publish workflow with agent-relay dry run: Validated harden-npm-publish workflow with agent-relay dry run
- Made harden-npm-publish setup idempotent: Made harden-npm-publish setup idempotent
- Abandoned: Clearing stale active PR 691 trajectory so new CI hardening work can record its own trail
