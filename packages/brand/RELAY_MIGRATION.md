# Migrating relay from local brand.css to @relaycast/brand

This guide covers switching the relay web app from its vendored `brand.css` to the
shared `@relaycast/brand` package. The CSS variable names are identical — only the
import path changes.

---

## 1. Install the package

```bash
npm install @relaycast/brand
```

Pin to an exact version to avoid surprise style changes:

```bash
npm install @relaycast/brand@x.y.z
```

Verify the pinned version in `package.json`:

```json
{
  "dependencies": {
    "@relaycast/brand": "1.2.3"
  }
}
```

Use an exact version (no `^` or `~`). Brand tokens affect every visible pixel
of the UI — a patch bump from upstream should be a deliberate, reviewed update.

---

## 2. Update globals.css

`relay/web/app/globals.css` currently imports the local file:

```css
/* before */
@import "../public/brand.css";
```

Replace it with the package import:

```css
/* after */
@import '@relaycast/brand/brand.css';
```

Full diff:

```diff
 @import "tailwindcss";
-@import "../public/brand.css";
+@import '@relaycast/brand/brand.css';

 html {
   background: var(--bg);
```

No other changes are needed. Every `var(--bg)`, `var(--primary)`,
`var(--fg-muted)`, etc. referenced in `globals.css` and throughout the codebase
resolves identically from the shared package.

---

## 3. Handle public/brand.css

`relay/web/public/brand.css` serves two purposes:

1. **CSS source for globals.css** — replaced by the npm import above.
2. **Download link in BrandShowcase** — see step 4 below.

Once step 4 is handled you can delete the file:

```bash
rm relay/web/public/brand.css
```

Alternatively, keep it as a **generated copy** produced at build time (see
optional step below) so the `/brand.css` URL continues to work without serving
the npm package file directly.

---

## 4. Update BrandShowcase.tsx

The component currently exposes a download link pointing at the local public file.
Update it to link to the npm-published file instead.

**Option A — link to the npm CDN copy** (simplest, no build changes):

```tsx
// before
<a href="/brand.css" download="brand.css">Download brand.css</a>

// after
<a
  href="https://unpkg.com/@relaycast/brand/brand.css"
  download="brand.css"
  rel="noopener noreferrer"
>
  Download brand.css
</a>
```

**Option B — copy at build time and keep the `/brand.css` route** (self-hosted):

Add a `postinstall` or build script that copies the file:

```json
// package.json (relay/web)
{
  "scripts": {
    "prebuild": "cp node_modules/@relaycast/brand/brand.css public/brand.css"
  }
}
```

Then keep the existing `href="/brand.css"` in `BrandShowcase.tsx` unchanged.

Pick whichever option matches the team's hosting preferences.

---

## 5. No breaking changes

All CSS custom properties (`--bg`, `--fg`, `--primary`, `--line`, `--surface`,
`--bg-elevated`, `--shadow-strong`, `--syntax-*`, `--shiki-*`, etc.) are
defined with the same names in `@relaycast/brand`. Every rule in `globals.css`
and every component stylesheet continues to work without modification.

---

## 6. Updating the pinned version

When a new brand release is available:

1. Review the `@relaycast/brand` changelog for any token additions or removals.
2. Update the exact version in `relay/web/package.json`.
3. Run `npm install` and visually verify the UI.
4. Commit the `package.json` and `package-lock.json` changes together.

---

## 7. Rollback

If anything looks wrong after the migration, revert `globals.css` to the local
import:

```css
@import "../public/brand.css";
```

This requires no other changes. The local file is the ground truth; restoring
the import is a zero-risk, zero-downtime rollback. Remove `@relaycast/brand`
from `package.json` once confirmed.

---

## Migration checklist

- [ ] `npm install @relaycast/brand@x.y.z` (exact version, no `^`)
- [ ] `globals.css`: replace `@import "../public/brand.css"` with `@import '@relaycast/brand/brand.css'`
- [ ] `BrandShowcase.tsx`: update download href (Option A or B)
- [ ] `relay/web/public/brand.css`: delete or generate via build script
- [ ] Visual smoke-test in light and dark modes
- [ ] Commit `package.json`, `package-lock.json`, `globals.css`, `BrandShowcase.tsx`
