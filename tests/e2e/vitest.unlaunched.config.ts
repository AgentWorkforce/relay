import path from 'node:path';

import { defineConfig } from 'vitest/config';

import e2eConfig from '../../vitest.e2e.config.js';

// The unlaunched-delivery suite: a message reaching a session relay did NOT
// launch. `docs/native-delivery-migration.md` calls this "the gate that does
// not exist yet", and it is the exit criterion for every native-delivery
// phase.
//
// It needs its own config because `vitest.e2e.config.ts` deliberately EXCLUDES
// `tests/e2e/unlaunched/**` — these scenarios need a real CLI on the box and a
// hosted workspace, so the default `npm run test:e2e` sweep must not pick them
// up. That exclude is correct and is kept.
//
// What was not correct: a vitest positional argument is a FILTER applied after
// include/exclude globbing, so it cannot resurrect an excluded file. Both
// `npm run test:e2e:unlaunched` and the `unlaunched-*-delivery` cleanroom
// scenarios pointed at `vitest.e2e.config.ts` with a path argument and
// therefore collected zero test files, exiting 1 with "No test files found" —
// a red that says nothing about delivery. This config inverts the include so
// the suite can actually run.
//
// It lives under `tests/e2e/` rather than at the repo root because the
// native-delivery phase lanes only admit `tests/**` on the TypeScript side,
// and one directory up from the suite rather than inside it because
// `unlaunched-gate` typechecks every `.ts` under `tests/e2e/unlaunched/` as
// suite source — a build config sitting there would drag `vitest.e2e.config.ts`
// into that check and fail it on a pre-existing, unrelated `minWorkers` type
// error. `root` is pinned back to the repo root so the inherited globs and the
// cleanroom scenario's positional filter stay repo-relative.
//
// Everything else (workspace aliases, single-threaded forks, no retry) is
// inherited by spread, so the two configs cannot drift. `mergeConfig` is
// deliberately NOT used: it concatenates arrays, so the inherited
// `include`/`exclude` would survive and this config would run the whole e2e
// sweep while still excluding the one suite it exists to run.
const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  ...e2eConfig,
  root: repoRoot,
  test: {
    ...e2eConfig.test,
    root: repoRoot,
    include: ['tests/e2e/unlaunched/**/*.test.ts'],
    exclude: [],
    // A bare CLI has to start, register itself and be delivered into; the
    // e2e default is not enough headroom for a cold start plus the retry
    // window these scenarios must sit through before counting copies.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 120_000,
  },
});
