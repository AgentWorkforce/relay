# Action Schema Rubric

Action schema cases pass when action registration and invocation enforce the SDK's JSON-schema-lite subset and descriptor conversion behavior. Valid inputs should complete; missing required fields, unknown properties, array item errors, failed oneOf matches, and invalid outputs should return deterministic invalid_input or invalid_output results with precise paths in `observed.content`. Descriptor cases should preserve object schema fields. Zod-like fixture cases should prove parsed values reach handlers without requiring live zod dependencies.
