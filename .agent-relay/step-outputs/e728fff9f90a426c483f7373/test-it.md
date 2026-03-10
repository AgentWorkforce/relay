All 15 tests pass. The test file at `/tmp/supervisor-test/utils.test.ts` covers:

- Basic space-to-hyphen conversion and lowercasing
- Multiple/extra space collapsing
- Unicode accent stripping (NFD normalization)
- Special character replacement (`&`, `!`, `.`, etc.)
- Empty string input
- Whitespace-only input
- Already-valid slug passthrough
- Leading/trailing hyphen stripping
- Special-characters-only input (returns `""`)
- Mixed complex input (accents + symbols + spaces)
- Number preservation
- Consecutive hyphens collapsing
- All-uppercase input
- Single word input
- Numeric-only input

TESTS_DONE
