## REVIEW_COMPLETE

### Implementation (`utils.ts`) — Verdict: **PASS**

**Correctness:** All 15 test cases should produce correct results. Manual trace of the regex pipeline confirms:

| Step | Regex/Op | Purpose |
|------|----------|---------|
| 1 | Early return on empty/whitespace | Edge case guard |
| 2 | `.trim()` | Normalizes outer whitespace before processing |
| 3 | `.toLowerCase()` | Case normalization |
| 4 | `.normalize('NFD')` | Decomposes characters (é → e + combining acute) |
| 5 | `/[\u0300-\u036f]/g` → `''` | Strips diacritical/combining marks |
| 6 | `/[^a-z0-9-]+/g` → `'-'` | Replaces all non-slug chars with hyphen (greedy, collapses adjacent) |
| 7 | `/-{2,}/g` → `'-'` | Collapses remaining consecutive hyphens |
| 8 | `/^-+\|-+$/g` → `''` | Strips leading/trailing hyphens |

The `&` behavior is correct: `'Salt & Pepper'` → after step 6, `' & '` matches as a single run → one `-` → `'salt-pepper'`. The greedy `+` quantifier handles adjacent special chars in a single replacement, so step 7 is mainly needed for cases like `'foo---bar'` (pre-existing hyphens).

**Edge cases handled:**
- `''` / `'   '` → `''` via early return ✓
- NFD normalization before stripping combining marks (correct order) ✓
- Numbers preserved (`'12345'`, `'Version 2.0 Release'`) ✓
- Special-chars-only → `''` after stripping residual hyphens ✓

**Code quality:**
- Clean regex pipeline with clear comments
- JSDoc with `@example` entries
- Defensive `!input` check covers potential `null`/`undefined` at runtime despite TS types
- No unnecessary complexity

**Minor notes (non-blocking):**
- `toLowerCase()` before `normalize('NFD')` is functionally fine for this ASCII-output use case, but normalizing first then lowercasing is more canonically correct for Unicode. No practical difference here.
- The `+` quantifier in step 6 already handles most consecutive-special-char collapsing, making step 7 partially redundant — but it is still needed for inputs containing existing hyphen sequences. Keeping step 7 is correct and intentional.

### Tests (`utils.test.ts`) — Verdict: **PASS**

All 15 tests accurately reflect implementation behavior. Coverage is solid:
- Core happy path (spaces, case, accents)
- Empty/whitespace edge cases
- Boundary conditions (leading/trailing hyphens, special-chars-only)
- Character classes (unicode, `&`, `.`, `!`, numbers)
- Idempotency (`'already-slug'` unchanged)

The correction noting `&` → hyphen (not `"and"`) is accurate — the implementation has no `&`→`and` substitution, and the tests correctly match actual behavior.

**Gaps (acceptable for scope):**
- No runtime `null`/`undefined` test — acceptable given TypeScript typing
- No test for tab/newline input — low priority, would be handled correctly by step 6
- No test for mixed numbers + special chars only (`'123!'` → `'123'`) — minor gap

### Summary

The implementation is correct, clean, and well-documented. All 15 test cases accurately verify behavior. The implementation-test contract is consistent. No blocking issues found.

**REVIEW_COMPLETE**
