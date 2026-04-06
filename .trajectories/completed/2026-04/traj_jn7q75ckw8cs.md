# Trajectory: Review PR #651 for performance issues

> **Status:** ❌ Abandoned
> **Started:** March 27, 2026 at 10:01 AM
> **Completed:** April 2, 2026 at 08:14 AM

---

## Key Decisions

### Adjusted homepage hero top padding at the container level
- **Chose:** Adjusted homepage hero top padding at the container level
- **Reasoning:** This increases spacing below the sticky nav for both hero columns without shifting later sections or only the text column.

### Reduced homepage hero overlap with the sticky nav
- **Chose:** Reduced homepage hero overlap with the sticky nav
- **Reasoning:** The previous change only increased inner hero padding. Reducing the negative hero-section offset adds actual separation between the nav and the hero block so the top whitespace reads closer to the hero's bottom spacing.

### Reduced homepage hero overlap slightly further
- **Chose:** Reduced homepage hero overlap slightly further
- **Reasoning:** A small follow-up change tightens the visual balance between the nav gap and the bottom of the hero without reworking the hero internals.

### Removed the homepage text column's top offset on mobile
- **Chose:** Removed the homepage text column's top offset on mobile
- **Reasoning:** The desktop hero uses extra top offset to balance the two-column layout, but once the hero collapses to one column that offset creates unnecessary empty space above the headline.

### Made the shared dark secondary CTA surface opaque
- **Chose:** Made the shared dark secondary CTA surface opaque
- **Reasoning:** Secondary buttons already use a solid background in light theme. Switching the dark theme token from rgba to a solid surface fixes the see-through effect across all matching CTAs without duplicating button-specific overrides.

---

## Chapters

### 1. Work
*Agent: default*

- Adjusted homepage hero top padding at the container level: Adjusted homepage hero top padding at the container level
- Reduced homepage hero overlap with the sticky nav: Reduced homepage hero overlap with the sticky nav
- Reduced homepage hero overlap slightly further: Reduced homepage hero overlap slightly further
- Removed the homepage text column's top offset on mobile: Removed the homepage text column's top offset on mobile
- Made the shared dark secondary CTA surface opaque: Made the shared dark secondary CTA surface opaque
- Abandoned: User requested abandoning active trajectory traj_jn7q75ckw8cs
