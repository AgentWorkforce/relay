# Trajectory: Preserve highlighted code metadata token in HighlightedPre

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** April 2, 2026 at 11:58 AM
> **Completed:** April 2, 2026 at 12:00 PM

---

## Summary

Preserved encoded docs code-fence metadata on HighlightedPre output while adding normalized language metadata and regression tests for mixed language classes.

**Approach:** Standard approach

---

## Key Decisions

### Preserve encoded code-fence token on rendered code blocks and add normalized language metadata alongside it
- **Chose:** Preserve encoded code-fence token on rendered code blocks and add normalized language metadata alongside it
- **Reasoning:** CodeGroup and other downstream consumers recover labels and filenames from the rendered code class token, so HighlightedPre must not replace that token when adding syntax-highlighting metadata.

---

## Chapters

### 1. Work
*Agent: default*

- Preserve encoded code-fence token on rendered code blocks and add normalized language metadata alongside it: Preserve encoded code-fence token on rendered code blocks and add normalized language metadata alongside it
