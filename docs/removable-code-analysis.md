# Removable Code Analysis

Requested: identify code/assets likely safe to remove (unused, legacy, or duplicates).

## Candidates
1) `run-dashboard.js`  
   - Purpose: helper to start dashboard from built `dist/dashboard/server.js`.  
   - Evidence: Dashboard now exposed via CLI subcommand `dashboard` in `src/cli/index.ts`. No `rg` references to `run-dashboard.js`. Redundant helper.

2) `scripts/games/*` and `scripts/tictactoe-setup.sh`  
   - Purpose: old demo/game scripts (hearts/tictactoe).  
   - Evidence: Not referenced by CLI commands or docs (checked with `rg`). Pure examples; removable if demos not needed.

3) `src/hooks/check-inbox.sh`  
   - Purpose: legacy hook example for Claude stop-event inbox check.  
   - Evidence: Replaced by compiled hook in `dist/hooks/inbox-check/*` and TypeScript sources in `src/hooks/inbox-check/*`. No other references via `rg`, so redundant.

4) `coverage/` directory  
   - Purpose: test coverage artifacts.  
   - Evidence: Generated output; not source. Safe to delete/regenerate.

5) `TOMORROW.md`  
   - Purpose: session notes / planning doc.  
   - Evidence: Not used by runtime or tests; optional to keep for historical notes only.
