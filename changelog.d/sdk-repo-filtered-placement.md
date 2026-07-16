---
type: Fixed
level: patch
---

`@agent-relay/sdk` repo-filtered message placement now matches nodes: `toRelayNode` derives a node's `repoKeys` from its `repo:<key>` registration tags when no dedicated repo field is present, so a placement repo filter is no longer a no-op that never matches. Explicit `repoKeys`/`repo_keys`/`repoPaths` fields still take precedence.
