# Trajectory: Make doctor tolerant of missing better-sqlite3

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** February 10, 2026 at 01:22 PM
> **Completed:** February 21, 2026 at 11:17 PM

---

## Summary

Wired workflow conventions into spawn so agents explicitly use relay_send ACK/DONE; patched active dashboard dist spawn path to apply conventions immediately.

**Approach:** Standard approach

---

## Key Decisions

### Enabled workflow-convention task injection at dashboard spawn + SDK adapter

- **Chose:** Enabled workflow-convention task injection at dashboard spawn + SDK adapter
- **Reasoning:** includeWorkflowConventions flag was not wired, so agents spawned without explicit relay_send ACK/DONE behavior and often stayed silent.

---

## Chapters

### 1. Work

_Agent: default_

- Enabled workflow-convention task injection at dashboard spawn + SDK adapter: Enabled workflow-convention task injection at dashboard spawn + SDK adapter

---

## Artifacts

**Commits:** 5dd4e7ac, 1345d49e, 6e5031d6, 1de18c33, ad99b465, 8a159ab7, b3e43149, b50cb767, 81bdb411, 0a9f8b94, c2651bd5, 8d79fe43, 18883065, 243be385, 199fd1dd, 38f185a1, 7d555f08, f78aa9cc, 7b4bfdb1, b7534914, 3d014230, 2e64a0de, 76c9b2e3, d127ce39, 1f22a7bc, d09938e1, 703a08ce, c9609e7d, 4314cc2c, 9b464f22, 47ad664a, 758bddf0, a9f6d469, df02f703, 580552be, 1cea9593, 29c05c29, 81388eeb, 5105539b, 0646dbb7, 3025a281, 777e6525, 4e1613df, da27a975, 21ec7a4e, 63904ccb, 2a3178ec, 87b9272e, 329f608c, 15b5c9ba, f88f5321, 76dbab6e, 0e0af4d1, 8ccb515e, b6c208c0, 7e54ca9b, 1f147cc6, 5d6088c4, 4264445e, 4ede7fb3, 8580a65c, fa2049cb, e27e6cff, 15cbbb80, d0f3dd5d, ef02358d, 1d63d525, a7a92685, d35ac6fb, 9fac5081, 660c8e4a, bc08b16c, e384ca96, cf26336d, 8259b6be, 404cd121, fe7ef33e, c638bc5f, 481c1c55, 72cac787, c9dbc5f3, 7f21e80b, ede75439, 181b2b20, 8abc0dd1, 1958f685, 172ca791, ffddcfdb, 75a8a0e3, c914e1e2, a38e45c0, 421a8c97, dfe9686f, 509c6d4e, bce15b4d, 2674aadd, f9861a9a, e8a6a70d, ba23e978, d1e8c6c3, 16c9182e, 672cd10e, ea17614b, 087503b8, 3f0afa49, 5fe50043, 647965d9, d070c7dd, e8d8169e, 6c9731be, ae0465e9, 61d13121, 1a271f0c, a8f1b669, d480b46b, cf93556f, 845b9ece, 47e230d9, 7f84e9b0, c5912fde, a6255cbc, c596a33c, 1f3a23d7, 2c5c3197, bd7c22de, 65642e18, 20dc4199, 415b9a7f, ad409cd4, 5800e866, a92bdd6c, 5b505f68, 7ac0fee1, d4ee0287, 029df191, 5673326e, 67c679de, 7638575e, 67368809, c8b02e4b, 017e1cc3, 15537dd8, ec61da32, c16b9e03, 6a3f7544, 0a53aec5, e98981e8, 85c0b707, 883b27ad, 5e246c6f, 03247f1f, 7c41511f, e569b2a2, 1e4d7e41, e7a06e78, a1f93a07, 9a7ba4ea, f674f70c, 83177d5b, 4476d139, 61e9878b, b8a90a75, 61b5340a, 953d7c57, 9996510a, 2e83e8eb, d1166cf9
**Files changed:** 732
