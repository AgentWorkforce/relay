IMPLEMENT_DONE

Created `/tmp/supervisor-test/utils.ts` with a `slugify` function that:
- Returns `""` for empty or whitespace-only input
- Normalizes unicode (strips accents via NFD decomposition)
- Lowercases the result
- Replaces special characters with hyphens
- Collapses multiple spaces/hyphens into single hyphens
- Strips leading/trailing hyphens
