All 15 tests pass. The test file at `/tmp/supervisor-test/utils.test.ts` covers:

1. Basic space-to-hyphen conversion and lowercasing
2. Multiple/extra spaces collapsing
3. Accented/diacritical character stripping (NFD normalization)
4. Special character replacement (`&`, `!@#$%^*()`)
5. Empty string input
6. Whitespace-only input
7. Already-valid slug passthrough
8. Leading/trailing hyphen stripping
9. Special-characters-only input (returns `""`)
10. Complex mixed input (accents + symbols + spaces)
11. Number preservation
12. Consecutive hyphens collapsing
13. All-uppercase input
14. Single word
15. Numeric-only input

TESTS_DONE
