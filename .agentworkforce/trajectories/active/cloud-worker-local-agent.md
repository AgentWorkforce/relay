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

## Compose merged enrollment inputs

Forward-merged main a5ea7bd0 after the credential-input feature landed. The sole manual conflict was the changelog; both pending Minor entries are retained. Local-agent feature edits and its four other source/test/documentation files match the previous reviewed head exactly. Registration changes from main merge automatically. Adversarial and contextual composition reviews found no behavior or authority changes beyond the two intended features. All 54 combined credential/local-agent tests, full typecheck and whitespace checks passed; package and lock remain exactly main. Required hosted checks and review remain separate.

## Isolated authored Surface resolution

The required runtime review found that a filename classifier does not prove dependency resolution: the SDK anchors Surface resolution at the isolated authored file. Supply the CLI's installed, lock-pinned SDK Surface through a package-directory link only when the assignment has no Surface. Preserve supplied dependencies, including refusing broken packages unchanged, and refuse writing through archive-provided parent links. The standalone path reuses the existing pinned SDK provisioning store. The assignment runner still controls credentials, exit status and run-directory cleanup.

The regression enters the actual assignment runner, launches a real child process, imports the installed SDK loader and isolated authored file, and executes its body using the same Surface instance. Both a missing-dependency fallback and a physically separate compatible assignment dependency pass; removing the fallback causes the same flow to fail. This is module/body execution evidence, not daemon, journal, provider or hosted enrollment qualification.

The original worker feature landed while this repair was in progress. Forward-merged its main commit; the resulting full tree was byte-identical to the tested repair before adding this follow-up record and the Fixed changelog entry. The new PR therefore contains only the Surface repair and its regression, not a second copy of the landed worker feature.

Exact CI Node 22.14 execution exposed an additional causal defect: native `.flow.ts` imports require explicit type stripping on that release. Enable the supported flag in the TypeScript assignment child's NODE_OPTIONS, preserving prior options and leaving the parent and YAML environments unchanged. The environment also reaches the standalone Bun CLI's separately launched Node SDK process. Node assignments below Surface's minimum Node 22.12 refuse explicitly; direct Bun remains supported. The regression captures the actual child environment and reuses it for the missing-Surface negative control, so that control cannot pass merely because TypeScript loading was disabled.

Addressed the repository naming review by renaming all five new module-level test constants to UPPER_CASE; reverse-renaming reproduced the prior file byte-for-byte. A loaded-host run exposed the integration test's five-second default deadline. The test now independently cancels its real child at 20 seconds, bounds the negative subprocess at 10 seconds, and has a 40-second test deadline; all import, body, dependency-preservation and causal-refusal assertions remain. The bounded four-case subset passes.
