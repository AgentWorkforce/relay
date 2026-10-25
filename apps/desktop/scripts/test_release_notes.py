#!/usr/bin/env python3
"""Tests for scripts/release-notes.py (run: python3 scripts/test_release_notes.py)."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "release_notes", Path(__file__).with_name("release-notes.py")
)
release_notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_notes)

BASE = """# Changelog

Header.

## Unreleased

- **First change.** Does a thing.
- **Second change.** Does another.

## v2026.01.1

- **Old change.** Shipped.
"""


class ReleaseNotesTests(unittest.TestCase):
    def write(self, text=BASE):
        tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".md", delete=False, encoding="utf-8"
        )
        tmp.write(text)
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        return Path(tmp.name)

    def test_promote_renames_unreleased_and_adds_fresh_one(self):
        path = self.write()
        self.assertTrue(release_notes.promote_changelog(path, "2026.02.1"))
        text = path.read_text(encoding="utf-8")
        self.assertIn("## Unreleased\n\n## v2026.02.1\n\n- **First change.**", text)
        self.assertIn("## v2026.01.1\n\n- **Old change.** Shipped.", text)
        self.assertEqual(
            release_notes.changes_for_version(path, "2026.02.1"),
            "- **First change.** Does a thing.\n- **Second change.** Does another.",
        )

    def test_promote_is_noop_when_version_already_present(self):
        path = self.write()
        release_notes.promote_changelog(path, "2026.02.1")
        before = path.read_text(encoding="utf-8")
        self.assertFalse(release_notes.promote_changelog(path, "2026.02.1"))
        self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_promote_rejects_empty_unreleased(self):
        path = self.write(BASE.replace("- **First change.** Does a thing.\n- **Second change.** Does another.\n", ""))
        with self.assertRaises(ValueError):
            release_notes.promote_changelog(path, "2026.02.1")

    def test_promote_rejects_missing_unreleased(self):
        path = self.write(BASE.replace("## Unreleased", "## Pending"))
        with self.assertRaises(ValueError):
            release_notes.promote_changelog(path, "2026.02.1")

    def test_changes_fall_back_to_unreleased_before_promotion(self):
        path = self.write()
        self.assertEqual(
            release_notes.changes_for_version(path, "2026.02.1"),
            "- **First change.** Does a thing.\n- **Second change.** Does another.",
        )

    def test_merge_keeps_concurrent_bullet_in_unreleased(self):
        path = self.write()
        base = path.read_text(encoding="utf-8")
        release_notes.promote_changelog(path, "2026.02.1")
        promoted = path.read_text(encoding="utf-8")
        latest = base.replace(
            "## Unreleased\n", "## Unreleased\n\n- **Concurrent change.** Landed during the release.\n", 1
        ).replace("- **Old change.** Shipped.", "- **Old change.** Shipped and documented.")
        merged, changed = release_notes.merge_promotion(base, promoted, latest, "2026.02.1")
        self.assertTrue(changed)
        unreleased = merged.split("## v2026.02.1")[0]
        self.assertIn("- **Concurrent change.** Landed during the release.", unreleased)
        self.assertNotIn("- **First change.**", unreleased)
        self.assertIn("## v2026.02.1\n\n- **First change.** Does a thing.", merged)
        self.assertIn("- **Old change.** Shipped and documented.", merged)

    def test_merge_is_noop_when_latest_already_promoted(self):
        path = self.write()
        base = path.read_text(encoding="utf-8")
        release_notes.promote_changelog(path, "2026.02.1")
        promoted = path.read_text(encoding="utf-8")
        merged, changed = release_notes.merge_promotion(base, promoted, promoted, "2026.02.1")
        self.assertFalse(changed)
        self.assertEqual(merged, promoted)

    def test_merge_rejects_a_different_existing_version_section(self):
        path = self.write()
        base = path.read_text(encoding="utf-8")
        release_notes.promote_changelog(path, "2026.02.1")
        promoted = path.read_text(encoding="utf-8")
        latest = promoted.replace("- **First change.** Does a thing.", "- **Other change.** No.")
        with self.assertRaises(ValueError):
            release_notes.merge_promotion(base, promoted, latest, "2026.02.1")

    def test_changes_reject_duplicate_version_sections(self):
        path = self.write(BASE + "\n## v2026.01.1\n\n- **Dup.** No.\n")
        with self.assertRaises(ValueError):
            release_notes.changes_for_version(path, "2026.01.1")


if __name__ == "__main__":
    unittest.main()
