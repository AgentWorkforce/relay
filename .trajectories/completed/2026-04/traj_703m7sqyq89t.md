# Trajectory: Fix production docs loader using build-machine absolute MDX paths

> **Status:** ✅ Completed
> **Confidence:** 84%
> **Started:** April 10, 2026 at 12:33 PM
> **Completed:** April 10, 2026 at 12:35 PM

---

## Summary

Fixed docs/blog content loading so runtime resolves MDX from the deployed filesystem instead of a build-machine absolute path, and added content/docs plus content/blog to Next output file tracing. Verification was partial because next build still hits unrelated intermittent prerender errors after compile and type-check.

**Approach:** Standard approach

---

## Key Decisions

### Stopped docs and blog content loaders from binding to build-machine absolute paths, and explicitly traced MDX content into the Next server bundle
- **Chose:** Stopped docs and blog content loaders from binding to build-machine absolute paths, and explicitly traced MDX content into the Next server bundle
- **Reasoning:** The production stack showed a read against /home/runner/work/.../web/content/docs/introduction.mdx, which means the docs loader baked the GitHub runner path into the server chunk via import.meta.url. Resolving content from runtime cwd candidates fixes the path, and tracing content/docs plus content/blog ensures those source files are present in the deployed artifact.

---

## Chapters

### 1. Work
*Agent: default*

- Stopped docs and blog content loaders from binding to build-machine absolute paths, and explicitly traced MDX content into the Next server bundle: Stopped docs and blog content loaders from binding to build-machine absolute paths, and explicitly traced MDX content into the Next server bundle
