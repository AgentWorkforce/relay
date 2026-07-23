# Protocol Framing Rubric

A passing protocol-framing case must:

- Exercise the Relay SDK executor without connecting to a live broker.
- Preserve stable protocol identifiers such as message ids, parent ids, action names, and event types.
- Populate `observed.content`, `observed.events`, and `observed.toolCalls` so deterministic checks can validate the run.
- Keep seeded state and operation-created state visible through the same in-memory SDK surfaces.

Cases fail if they require a live broker, drop sender/channel/thread identity, or emit events that cannot be checked through the executor observed-result contract.
