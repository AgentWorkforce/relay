# Fleet disk reaper

`disk_reaper.py` reclaims ignored `node_modules` trees first, then ignored Cargo
`target` trees and explicitly mapped tool caches. It can also remove clean,
fully merged linked worktrees using `git worktree remove` without force. Primary
checkouts and branches are never removed. Python 3.10+, Git, `ps`, and `lsof` are
required on macOS/Linux; there are no package dependencies.

```sh
python3 /path/to/relay/scripts/fleet/disk_reaper.py run --root "$HOME/lanes"
python3 /path/to/relay/scripts/fleet/disk_reaper.py run --root "$HOME/lanes" --apply
```

Each immediate child of `--root` is one lane, containing one or more checkouts.
Repeat `--root` for multiple lane roots. Symlinked roots, lanes, checkouts, and
cache paths are retained. The default age is **7 days**, configurable with
`--days`. Both Git metadata and cache trees must be older than the cutoff; ctime
is included so backdated commits, freshly cloned old histories, and copied
caches are retained. This is deliberately more conservative than commit dates.
A fetch refreshes the retention clock. Run the scheduler from outside lane roots.

## Launch protocol: required before reclamation

Run this as the same unprivileged fleet account that owns the lanes and launches
the agents. These are single-user lane roots, not shared checkouts used by other
Unix accounts. Do not run it with `sudo`. Ensure other accounts cannot access the
lane root (for example, provision new lane roots with mode `0700`).

Configure **every lane launcher**, including manual shells and build jobs that
may use a lane, to hold a lease for its full lifetime:

```sh
python3 /path/to/relay/scripts/fleet/disk_reaper.py lease \
  --lane "$HOME/lanes/my-task" -- agent-command
```

The command must stay in the foreground until its workers exit. The wrapper
holds a shared advisory lock, passes it to its child, and marks the lane as
managed. The reaper requires that marker in both modes and obtains the exclusive
lane lock before planning or deleting. Existing unmanaged lanes are retained;
they are not silently enrolled by a reaper run. After migrating a launcher,
future completed lanes become eligible automatically. Never bypass the wrapper
for a managed lane. Keep the lock files under
`~/.local/state/agent-relay/disk-reaper/`; unlinking a live lock breaks exclusion.

OS probes additionally protect existing processes and open files anywhere in a
lane, including siblings of a checkout. Every surviving process with the fleet
account's effective UID must have readable cwd coverage. Zombies hold no working
resources and are excluded. Permission failures, lsof warnings, missing commands,
or incomplete snapshots retain everything. Probes read only PID/UID/state,
working directories and file names; they never request process arguments or
environments, and do not log raw probe output. New leased starts cannot race
deletion. The advisory protocol must be enforced by the launcher: a process
started outside it can race any filesystem/process snapshot.

## Git and deletion guards

Before any deletion, the reaper repeats Git and process checks while holding the
lane lock. It retains checkouts with:

- Staged, unstaged, or untracked work; stashes; submodules; detached HEAD;
  assume-unchanged or skip-worktree index flags; in-progress Git operations.
- Any local branch without a remote upstream, unpushed commits on **any** local
  branch, or other reachable local-only commits.
- An unavailable remote, or an upstream whose live `ls-remote` tip differs from
  the locally recorded tip. Fetch and wait through retention before retrying.
- Recently modified Git metadata, dependency files, or cache files.

A cache must be ignored by Git and contain no tracked files. Nested repositories,
bare repositories, special files, and filesystem mount boundaries are retained.
Symlinks inside dependencies are unlinked, never traversed. Unknown errors retain
the candidate; no force flags are used. Git command errors are redacted because
remote URLs and credential helpers can contain secrets. Directory sizes use
allocated blocks and are estimates; hard links, compression, concurrent unrelated
writes, and snapshots can make actual free-space changes differ.

Add `--worktrees` to enable merged linked-worktree reclamation. The default merge
target is `refs/remotes/origin/main`, configurable with `--merge-base`; its live
remote tip must also match. Locked worktrees and worktrees with any ignored files
remaining are retained. Dependencies may be reclaimed on one run and the
worktree removed on a later run once its activity clock expires.

## Shared caches

Shared cache deletion is opt-in, with an explicit clean owner checkout:

```sh
python3 /path/to/relay/scripts/fleet/disk_reaper.py run --root "$HOME/lanes" \
  --cache "$HOME/.npm/_cacache=$HOME/lanes/idle/repo" \
  --cache "$HOME/Library/Developer/Xcode/DerivedData=$HOME/lanes/idle/repo"
```

Only `~/.npm/_cacache`, Xcode `DerivedData`, and individual immediate children of
`~/Library/Caches` are allowed. Never point this at a directory containing source
work. The whole `~/Library/Caches` directory is not a deletion target. The owner
must pass every lane/Git guard. A cache inside another checkout is retained even
when its mapped owner is clean. Shared cache removal also takes a global exclusive
lease and checks open files; any live leased lane keeps shared caches. All users
of a shared cache must use the same fleet account and lease protocol. Inspection
errors and embedded repositories keep the cache.

## Schedule and reporting

Start with this daily dry-run cron entry (use absolute installation paths):

```cron
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin
15 3 * * * cd / && /usr/bin/env python3 /path/to/relay/scripts/fleet/disk_reaper.py run --root /home/fleet/lanes >> /home/fleet/disk-reaper.log 2>&1
```

After deploying the launch protocol and inspecting reports, add `--apply` to
that command to enable deletion. No scheduling or deletion is installed by this
PR. `--json` suppresses the human table. Both modes emit one JSON line with event
`fleet_disk_reaper`, `dry_run`, free bytes before/after per root, per-category
`would_reclaim_bytes`, `reclaimed_bytes`, `kept`, and individual decisions.
A zero reclaim with kept entries is a successful safe run; inspect reasons to
understand why capacity did not change. Invalid arguments and fatal setup errors
return nonzero. Category byte counters are allocated-size estimates for fully
completed deletions; an interrupted/failed partial deletion is retained as an
error entry and its actual effect is visible in filesystem free-space readings.

Run the tests without installing node_modules (Node.js 22+ is needed for the
proof-entry-point regression tests):

```sh
python3 -m unittest discover -s tests/fleet -v
python3 -m unittest discover -s tests/fleet-proof -v
```

The suite builds local bare remotes and temporary lanes, exercises successful
removal, protects dirty/unpushed/active lanes, and checks both worktree and cache
safety. The PR proof executes the safety suite against target production code.
Proof-runner regressions live in a separate discovery directory, so they cannot
provide a positive count when the actual reaper safety tests are missing.

## Acquisition follow-ups

Shallow lane clones (`git clone --depth 1`) and one shared npm cache
(`npm_config_cache="$HOME/.npm"`) remain launcher follow-ups. This repository has
no single lane-cloning entry point to change safely here. Full history may be
needed to establish merge ancestry; a shallow history that cannot prove safety
is retained. Neither optimization replaces retention.
