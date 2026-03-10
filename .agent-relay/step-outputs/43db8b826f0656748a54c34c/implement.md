IMPLEMENT_DONE

Created `/tmp/supervisor-test/utils.ts` with a `slugify` function that:
- Returns `""` for empty or whitespace-only input
- Lowercases and trims the input
- Normalizes accented characters (NFD decomposition)
- Replaces any non-alphanumeric characters with hyphens
- Collapses consecutive hyphens into one
- Strips leading/trailing hyphens
- Includes JSDoc with `@param`, `@returns`, and `@example` annotations
