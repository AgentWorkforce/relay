# SDK issue1359 repair

Summary: Revalidated all three reports against main72d9858. Fixed returned agent API types and immediate actionable listener diagnostics. Autofixes cover unsupported workspace operations, verified event scope, injected clients and exact-token stream reuse. Two independent final code reviews passed.

Validation in this Relay checkout:
- npm --prefix packages/sdk test — 200 passed.
- npm --prefix packages/sdk run test:types — 11 passed.
- npm --prefix packages/sdk run build and npm --prefix packages/sdk run check: passed.
- npm run typecheck built all cross-package prerequisites; final CLI TypeScript check passed after the returned-client-only workspace correction.
- Prettier and git diff --check against the base: passed.

Reproducible companion parity check:
- Source: scripts/verify-sdk-realtime-blocks.mjs in this PR.
- Build Relay SDK and companion Relaycast SDK, then run node scripts/verify-sdk-realtime-blocks.mjs <relaycast-checkout>.
- Verified with Relaycast implementation3af3b99 from AgentWorkforce/relaycast PR634.
- Real built SDK node-WebSocket transport, Relay adapter and public listener preserve a49KB block and the original arbitrary kind/payload object, matching fixture REST readback. All HTTP/WebSocket I/O is mocked. This does not exercise a database or live service.

The upstream transport/schema/engine repair is PR634. Issue1359 remains open until a human-published upstream release is integrated. No merge, release, deployment or production operation was performed. Exact product implementation commits and changed files are recorded in trajectory.json; later verification/evidence-only commits are outside that product-code trace.
