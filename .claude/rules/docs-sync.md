# Documentation Sync Rule

The docs exist in two locations that **must stay in sync**:

- `web/content/docs/*.mdx` — MDX source (used by the Next.js web app)
- `docs/*.md` — Plain markdown mirror (for LLMs, CLI users, GitHub readers)

## Rules

1. **Any change to an `.mdx` file must be mirrored to the corresponding `.md` file**, and vice versa.
2. The markdown files should have the same content but with MDX components converted to plain markdown:
   - `<CodeGroup>` / `</CodeGroup>` → remove (just keep the code blocks)
   - `<Note>` → `> **Note:**`
   - `<Warning>` → `> **Warning:**`
   - `<Tabs>` / `<Tab>` → use headers or separate code blocks
   - Frontmatter (`---` YAML block) → remove from `.md` files
3. **File mapping** (flat structure, no subdirectories):
   - `web/content/docs/{slug}.mdx` ↔ `docs/{slug}.md`
   - e.g. `web/content/docs/reference-sdk.mdx` ↔ `docs/reference-sdk.md`
4. If you add a new `.mdx` doc, create the corresponding `.md` mirror.
5. If you update default values, API signatures, or examples — update **both** files.
