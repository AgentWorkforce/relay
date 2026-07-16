---
type: Fixed
level: patch
---

`agent-relay-broker`'s `/api/observer-token` recovers from an `observer_token_name_conflict` (409) by rotating the existing same-named token to return fresh, usable material instead of failing the mint, so repeat mints of the fixed-name dashboard observer token succeed. It rotates only a token whose scopes exactly match the endpoint's read-only set and that carries no filters; any other conflict still propagates unchanged.
