# Actions Rubric

Action cases pass when `register_action` and `invoke_action` exercise the same semantics as `InMemoryAgentRelayActions` and `ActionRegistry`: normalized names, stored descriptors, default visibility, caller context propagation, successful fixture outputs, denied policy results, handler failure results, unregister behavior, and resilient listener emission. Passing output should expose action result payloads in `observed.content`, include invoked/completed/failed/denied events in `observed.events`, and trace both registration and invocation operations.
