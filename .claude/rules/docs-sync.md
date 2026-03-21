# Documentation Sync Rule

The docs exist in three locations that **must stay in sync**:

- `docs/*.mdx` — Mintlify source (rendered at docs.agent-relay.com)
- `web/content/docs/*.mdx` — Copy used by the Next.js web app (must match `docs/*.mdx`)
- `docs/markdown/*.md` — Plain markdown mirror (for LLMs, CLI users, GitHub readers)

## Rules

1. **Any change to a `.mdx` file must be mirrored to the corresponding `.md` file and `web/content/docs/` copy**, and vice versa.
2. The markdown files should have the same content but with MDX components converted to plain markdown:
   - `<CodeGroup>` / `</CodeGroup>` → remove (just keep the code blocks)
   - `<Note>` → `> **Note:**`
   - `<Warning>` → `> **Warning:**`
   - `<Tabs>` / `<Tab>` → use headers or separate code blocks
   - Frontmatter (`---` YAML block) → remove from `.md` files
3. **File mapping:**
   - `docs/introduction.mdx` ↔ `docs/markdown/introduction.md`
   - `docs/quickstart.mdx` ↔ `docs/markdown/quickstart.md`
   - `docs/reference/sdk.mdx` ↔ `docs/markdown/reference/sdk.md`
   - `docs/reference/sdk-py.mdx` ↔ `docs/markdown/reference/sdk-py.md`
   - `docs/reference/openclaw.mdx` ↔ `docs/markdown/reference/openclaw.md`
4. If you add a new `.mdx` doc, create the `.md` mirror and add it to `docs/markdown/README.md`.
5. If you update default values, API signatures, or examples — update **both** files.
