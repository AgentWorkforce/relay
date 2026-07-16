---
type: Fixed
level: patch
---

`agent-relay-broker`'s `/api/observer-token` now recovers from an `observer_token_name_conflict` (409) by rotating the existing same-named read-only token, so repeat mints of the fixed-name dashboard observer token succeed instead of failing.
