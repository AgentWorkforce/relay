# Changelog fragments

Pending, user-visible changes live here as **one small file per change** instead
of being written directly into the `[Unreleased]` section of the root
`CHANGELOG.md`. Because every change touches its own new file, two PRs never edit
the same lines — so a changelog entry can't merge-conflict or land under the
wrong (already-released) version heading when PRs merge in quick succession.

At release time the fragments in this directory are compiled into a new dated
version section of `CHANGELOG.md` and then deleted. Between releases,
`CHANGELOG.md`'s `[Unreleased]` heading stays empty; the pending narrative is the
set of files here.

See the [changelog rules in `CLAUDE.md`](../CLAUDE.md#changelog) for the
impact-first writing style.

## Adding an entry

Run the helper (recommended — it validates and names the file for you):

```bash
npm run changelog:add -- --type Added --level minor "\`agent-relay foo\` now does X."
```

Or create `changelog.d/<slug>.md` by hand using the format below.

## Fragment format

A fragment is a Markdown file with YAML-style frontmatter and a body:

```md
---
type: Added
level: minor
---

`agent-relay drive` gains an in-band `Ctrl+]` toggle that flips the driven agent
between held and live inbound delivery.
```

- **`type`** — the Keep a Changelog section. One of (listed in the order they
  render in `CHANGELOG.md`): `Breaking Changes`, `Added`, `Changed`,
  `Deprecated`, `Removed`, `Fixed`, `Security`, `Migration Guidance`.
- **`level`** — the SemVer impact of this change: `patch`, `minor`, or `major`.
  The release version bump is the **highest** level across all pending
  fragments (`patch < minor < major`).
- **body** — the entry itself, rendered as a bullet. Prefer one short,
  impact-first bullet: name the command, API, schema, or package touched and the
  practical effect. Multi-line bodies are kept as a single bullet.

Keep one change per file. Filenames are arbitrary (the helper derives a slug from
the text); only the frontmatter and body matter.

## Commands

```bash
npm run changelog:add       # scaffold a new fragment (see flags above)
npm run changelog:preview   # render what [Unreleased] will look like
npm run changelog:check     # validate all fragments (runs in CI)
npm run changelog:release   # compile fragments into CHANGELOG.md at release time
```

`changelog:release` takes `--version <x.y.z>` and optional `--date <YYYY-MM-DD>`;
with no `--version` it bumps the current `package.json` version by the highest
pending level.
