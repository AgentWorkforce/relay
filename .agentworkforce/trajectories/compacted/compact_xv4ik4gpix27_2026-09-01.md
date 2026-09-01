# Trajectory Compaction: Sep 1, 2026 - Sep 1, 2026

## Summary
- Sessions: 14
- Decisions: 19
- Events: 22
- Agents: default
- Files: 0
- Commits: 0

## Tooling
- Count the initial artifact poll separately from timed waits -> Count the initial artifact poll separately from timed waits (traj_8gs3qf296ccv)
- Budget independent producer scheduling skew -> Budget independent producer scheduling skew (traj_8j7i3qiufp6g)
- Resolve base and head artifacts concurrently -> Resolve base and head artifacts concurrently (traj_0ovmpxbnehp8)
- Cancel superseded same-SHA broker builds -> Cancel superseded same-SHA broker builds (traj_ybvq3quk7lzv)
- Derive resolver wait from producer timeout -> Derive resolver wait from producer timeout (traj_y51c07g5i7am)
- Refresh exact artifacts only through trusted lifecycle events -> Refresh exact artifacts only through trusted lifecycle events (traj_vpzkjusz7quh)

## Api
- Request executable memfds explicitly -> Request executable memfds explicitly (traj_8j7i3qiufp6g)
- Disable Rust caching for PR-authored broker builds -> Disable Rust caching for PR-authored broker builds (traj_za4bym6l1lhg)
- Compile only same-repository pull request heads -> Compile only same-repository pull request heads (traj_7upwean9um3p)
- Keep exact pull_request_target run head-SHA binding -> Keep exact pull_request_target run head-SHA binding (traj_vpzkjusz7quh)
- Require exact workflow-run SHA and continuous base artifact coverage -> Require exact workflow-run SHA and continuous base artifact coverage (traj_axhofz5iqf3a)
- Trust only default-branch broker producers and poll for completion -> Trust only default-branch broker producers and poll for completion (traj_axhofz5iqf3a)

## Security
- Require stale PRs to refresh after artifact retention -> Require stale PRs to refresh after artifact retention (traj_0ovmpxbnehp8)
- Execute the verified broker through a parent-held anonymous inode -> Execute the verified broker through a parent-held anonymous inode (traj_nhrrk2odz7z1)

## Testing
- Execute exact-SHA brokers only from an exec-sealed memfd -> Execute exact-SHA brokers only from an exec-sealed memfd (traj_v8sktrvzqu6p)
- Give the dispatcher an explicit composed deadline -> Give the dispatcher an explicit composed deadline (traj_1te865glhbcu)

## Other
- Abort concurrent broker resolution on first failure -> Abort concurrent broker resolution on first failure (traj_8gs3qf296ccv)

## Naming
- Use a stable private broker path protected by inherited Landlock mutation denial -> Use a stable private broker path protected by inherited Landlock mutation denial (traj_h0b8u7mgccpt)

## Database
- Require integer polling bounds -> Require integer polling bounds (traj_bmkh8k2gfoqk)

## Key Learnings
- None

## Key Findings
- None