# Documentation Rule

## Public docs live in `web/content/docs/*.mdx`

This is the single source of truth — the Next.js web app under
`web/` reads this directory directly to build the published docs
site. New pages go here, period.

When you add a new page:

- Create `web/content/docs/{slug}.mdx` with the standard frontmatter
  (`title:` and `description:`).
- Add an entry to the navigation in `web/lib/docs-nav.ts` under the
  appropriate group, OR to the `ALL_SLUGS` "hidden but routable"
  list if it shouldn't appear in the sidebar.

That's it. Don't create or update files in the top-level `docs/`
directory.

## The top-level `docs/` directory is legacy

It contains a partial mirror of a handful of MDX pages converted to
plain markdown. It was originally maintained as an "LLMs / CLI users
/ GitHub readers" alternate, but it drifted out of sync long ago
(5 pages survive vs 40+ in `web/content/docs/`) and is no longer
authoritative. Do not add new files to it, and do not "mirror" your
MDX changes into it.

Existing pages there will be cleaned up separately. Treat the
directory as read-only legacy until that happens.
