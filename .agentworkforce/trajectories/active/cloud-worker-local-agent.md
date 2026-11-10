# Cloud worker local execution opt-in

Task: connect fresh Cloud worker assignments to the existing explicit Relayflows local-agent execution option.

Decision: default stays disabled; propagate one public start flag through foreground and daemon paths. Do not infer available provider credentials or advertise new remote authority. Preserve resume refusal and nonzero runner failure handling.

Validation plan: actual command/queue/assignment boundaries with injected fetch and process dependencies; exact YAML/TS arguments, default-off, daemon, parked failure and state-bearing refusal. No worker enrollment, provider calls or deployment.

Trail CLI is unavailable in this environment; this tracked record captures the delegated decision directly.

Review follow-up: SDK2.0.65 attaches a YAML agent worker but its authored TypeScript path also attaches LLM execution. Narrow generic capability wording. Control may supply ordinary `.ts` filenames, so normalize only the materialized TypeScript filename to `.flow.ts`, retaining source bytes and directory; validate against the actual published SDK path classifier.

Main-forward: preserve the released 18.0.0 history and keep this pending feature under Unreleased Minor. Both feature modules, their tests and the worker documentation remain byte-identical to the reviewed predecessor. The real lock-pinned SDK 2.0.66 tarball integrity was verified; its actual authored-path classifier passed the materialization controls. All 25 selected tests and strict selected TypeScript checks pass on the composed tree. No provider, registration, publication or runtime operation is claimed.

Review passes: adversarial pass rechecked default-off, daemon propagation, safe materialization, state-bearing refusal and nonzero failure handling; contextual pass compared all five feature files and retained main’s release/package changes. Both are source-only clearance.

## Release-lock repair integration

Forward-merged accepted main f86ebb61. All five feature source, test and documentation files remain byte-identical to the prior reviewed head, and manifests and lockfile are exactly main. Adversarial review confirmed default-off executor selection, fresh-only state refusal and nonzero runner failures; contextual review confirmed daemon propagation and the supported authored-flow filename. Clean npm ci with lifecycle scripts disabled, 15 focused tests and full npm run typecheck passed; diff whitespace check passed. Cross-platform hosted checks remain required.
