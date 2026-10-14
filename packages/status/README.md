# Relay status core

One portable owner for work status, communication policy, native-evidence interpretation, PR completion rules, and transition fixtures. No database, hosted service, transport, or harness parser dependencies.

- Work: working, needs attention, waiting on agent, idle, waiting on PR, done, archived. Reasons explain the current activity or blocker. Freshness is separate; silence never changes state.
- Communication: Open, Knock, Allow list, Busy, Offline. Admission policy survives disconnects and Busy. Delivery adapters must recheck policy immediately before injection.
- History OSS captures and normalizes harness evidence. Hosted History stores and serves evidence. Neither owns product status, work episodes, PR completion rules, or communication policy.
- Cloud persists hosted projections and supplies PR facts. Desktop persists local projections. Both apply these rules; native-language consumers generate wire types from the exported JSON and run the same fixtures.

`npm run contracts` regenerates schemas and fixtures. `npm run contracts:check` detects drift. Run `npm test` for reference semantics. Publication follows the normal Relay release process; creating this package does not enable live delivery enforcement.

PR adapters supply fresh, stable-head provider facts and a durable event ID. Core checks episode identity, complete declared dependencies, evidence age, and all required merges before producing a transition.
