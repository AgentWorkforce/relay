# Trajectory: Fix ScheduleContent code highlighter nesting bug from chained replace calls

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** April 2, 2026 at 01:10 PM
> **Completed:** April 2, 2026 at 01:13 PM

---

## Summary

Fixed the dormant ScheduleContent highlighter bug by moving the formatting into a pure helper that escapes HTML, isolates strings first, isolates line comments next, and then highlights the remaining plain text with one combined token regex. Added a focused regression test that asserts the formatter no longer wraps injected class attributes as strings and still highlights comments, methods, and literals correctly.

**Approach:** Standard approach

---

## Key Decisions

### Replaced ScheduleContent's chained HTML-mutating regexes with a string-first tokenizer plus single-pass plain-text token matching
- **Chose:** Replaced ScheduleContent's chained HTML-mutating regexes with a string-first tokenizer plus single-pass plain-text token matching
- **Reasoning:** String matching after span injection corrupted class attributes, and splitting strings/comments before a combined token regex prevents later passes from reprocessing generated HTML while keeping the lightweight custom highlighter.

---

## Chapters

### 1. Work
*Agent: default*

- Replaced ScheduleContent's chained HTML-mutating regexes with a string-first tokenizer plus single-pass plain-text token matching: Replaced ScheduleContent's chained HTML-mutating regexes with a string-first tokenizer plus single-pass plain-text token matching

---

## Artifacts

**Commits:** fcfa7b83
**Files changed:** 1
