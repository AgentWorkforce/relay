All 15 tests pass. The test file is at `/tmp/supervisor-test/utils.test.ts` and covers:

- Basic space-to-hyphen conversion + lowercasing
- Multiple/extra spaces collapsing
- Unicode accent stripping
- Ampersand (`&`) → `"and"` replacement
- Empty string and whitespace-only inputs
- Already-valid slugs (unchanged)
- Leading/trailing hyphens from special chars
- Special-characters-only input
- Complex mixed input (accents + symbols + spaces)
- Number preservation
- Consecutive special characters collapsing
- All-uppercase input
- Single word
- Numeric-only input

TESTS_DONE
