"""Real Git fixture coverage; destructive operations only touch temporary trees."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = (
    Path(os.environ.get("DISK_REAPER_TARGET", Path(__file__).resolve().parents[2]))
    / "scripts/fleet/disk_reaper.py"
)
spec = importlib.util.spec_from_file_location("disk_reaper", SCRIPT)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ReaperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "lanes"
        self.repo = self.root / "idle" / "repo"
        self.repo.mkdir(parents=True)
        self.remote = self.base / "remote.git"
        self.g(self.base, "init", "--bare", str(self.remote))
        self.g(self.repo, "init", "-b", "main")
        self.g(self.repo, "config", "user.name", "Reaper Test")
        self.g(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / ".gitignore").write_text(
            "node_modules/\ntarget/\nsecret-ignored\n"
        )
        (self.repo / "source").write_text("valuable work\n")
        self.g(self.repo, "add", ".")
        self.g(self.repo, "commit", "-m", "initial")
        self.g(self.repo, "remote", "add", "origin", str(self.remote))
        self.g(self.repo, "push", "-u", "origin", "main")
        self.cache = self.repo / "node_modules"
        self.cache.mkdir()
        (self.cache / "regenerable").write_bytes(b"x" * 16384)
        self.args = argparse.Namespace(
            root=[str(self.root)],
            days=0,
            apply=False,
            worktrees=False,
            merge_base="refs/remotes/origin/main",
            cache=[],
        )
        self.home = self.base / "home"
        self.home.mkdir()
        patcher = patch.object(Path, "home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        with r.lease_lock(self.repo.parent, exclusive=False, enroll=True):
            pass

    def g(self, repo, *args):
        return (
            subprocess.check_output(
                ["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL
            )
            .decode()
            .strip()
        )

    def report(self, paths=()):
        return r.run(self.args, snapshot=lambda: set(paths))

    def selected(self, report):
        return [
            e
            for e in report["entries"]
            if e["status"] in {"would_reclaim", "reclaimed"}
        ]

    def assert_kept(self):
        self.args.apply = True
        result = self.report()
        self.assertFalse(self.selected(result), result)
        self.assertTrue((self.cache / "regenerable").exists())

    def test_dry_run_reports_allocated_bytes_without_deleting(self):
        report = self.report()
        self.assertTrue(report["dry_run"])
        self.assertGreater(
            report["categories"]["node_modules"]["would_reclaim_bytes"], 0
        )
        self.assertEqual(report["categories"]["node_modules"]["reclaimed_bytes"], 0)
        self.assertTrue(self.cache.exists())

    def test_apply_removes_only_ignored_cache(self):
        self.args.apply = True
        report = self.report()
        self.assertEqual(len(self.selected(report)), 1, report)
        self.assertFalse(self.cache.exists())
        self.assertEqual((self.repo / "source").read_text(), "valuable work\n")
        self.assertTrue((self.repo / ".git").exists())

    def test_dirty_tracked(self):
        (self.repo / "source").write_text("uncommitted")
        self.assert_kept()

    def test_staged_work(self):
        (self.repo / "source").write_text("staged")
        self.g(self.repo, "add", "source")
        self.assert_kept()

    def test_untracked_work(self):
        (self.repo / "new-work").write_text("untracked")
        self.assert_kept()

    def test_unpushed_head(self):
        self.g(self.repo, "commit", "--allow-empty", "-m", "unpushed")
        self.assert_kept()

    def test_unpushed_other_branch(self):
        self.g(self.repo, "checkout", "-b", "other")
        self.g(self.repo, "branch", "--set-upstream-to", "origin/main")
        self.g(self.repo, "commit", "--allow-empty", "-m", "precious")
        self.g(self.repo, "checkout", "main")
        self.assert_kept()

    def test_no_upstream(self):
        self.g(self.repo, "branch", "--unset-upstream")
        self.assert_kept()

    def test_unreachable_remote(self):
        self.g(self.repo, "remote", "set-url", "origin", str(self.base / "missing.git"))
        self.assert_kept()

    def test_remote_ref_deleted(self):
        self.g(self.remote, "update-ref", "-d", "refs/heads/main")
        self.assert_kept()

    def test_stash(self):
        (self.repo / "source").write_text("stashed")
        self.g(self.repo, "stash", "push")
        self.assert_kept()

    def test_assume_unchanged_hides_dirty_work(self):
        self.g(self.repo, "update-index", "--assume-unchanged", "source")
        (self.repo / "source").write_text("hidden")
        self.assert_kept()

    def test_skip_worktree_hides_dirty_work(self):
        self.g(self.repo, "update-index", "--skip-worktree", "source")
        (self.repo / "source").write_text("hidden")
        self.assert_kept()

    def test_default_seven_days_retains_fresh_clone(self):
        self.args.days = 7
        self.assert_kept()

    def test_active_cwd_in_sibling_directory_protects_whole_lane(self):
        self.args.apply = True
        self.assertFalse(self.selected(self.report([self.repo.parent / "notes"])))
        self.assertTrue(self.cache.exists())

    def test_open_file_in_cache(self):
        self.assertFalse(self.selected(self.report([self.cache / "regenerable"])))

    def test_unknown_process_inventory(self):
        def unavailable():
            raise r.Keep("process inventory unavailable")

        self.args.apply = True
        self.assertFalse(self.selected(r.run(self.args, snapshot=unavailable)))
        self.assertTrue(self.cache.exists())

    def test_active_lease_without_cwd(self):
        with r.lease_lock(self.repo.parent, exclusive=False):
            self.assert_kept()

    def test_recheck_catches_agent_starting_after_planning(self):
        calls = 0

        def snapshot():
            nonlocal calls
            calls += 1
            return {self.repo} if calls >= 2 else set()

        self.args.apply = True
        self.assertFalse(self.selected(r.run(self.args, snapshot=snapshot)))
        self.assertTrue(self.cache.exists())

    def test_symlink_cache_is_not_selected(self):
        self.cache.rename(self.base / "outside")
        self.cache.symlink_to(self.base / "outside", target_is_directory=True)
        self.assert_kept()

    def test_embedded_repo_is_kept(self):
        self.g(self.cache, "init")
        self.assert_kept()

    def test_tracked_cache_file_is_kept(self):
        self.g(self.repo, "add", "-f", "node_modules/regenerable")
        self.g(self.repo, "commit", "-m", "tracked dependency")
        self.g(self.repo, "push")
        self.assert_kept()

    def test_linked_worktree_removed_through_git_only(self):
        worktree = self.root / "merged" / "repo"
        worktree.parent.mkdir()
        self.g(
            self.repo, "worktree", "add", "-b", "merged", str(worktree), "origin/main"
        )
        with r.lease_lock(worktree.parent, exclusive=False, enroll=True):
            pass
        self.args.worktrees = True
        self.args.apply = True
        report = self.report()
        self.assertFalse(worktree.exists(), report)
        self.assertNotIn(
            str(worktree), self.g(self.repo, "worktree", "list", "--porcelain")
        )
        self.assertTrue(self.repo.exists())

    def test_ignored_noncache_work_prevents_worktree_removal(self):
        worktree = self.root / "merged" / "repo"
        worktree.parent.mkdir()
        self.g(
            self.repo, "worktree", "add", "-b", "merged", str(worktree), "origin/main"
        )
        (worktree / "secret-ignored").write_text("valuable")
        with r.lease_lock(worktree.parent, exclusive=False, enroll=True):
            pass
        self.args.worktrees = self.args.apply = True
        self.report()
        self.assertTrue(worktree.exists())

    def test_unmerged_pushed_worktree_is_retained(self):
        worktree = self.root / "unmerged" / "repo"
        worktree.parent.mkdir()
        self.g(
            self.repo, "worktree", "add", "-b", "unmerged", str(worktree), "origin/main"
        )
        self.g(worktree, "commit", "--allow-empty", "-m", "pushed but unmerged")
        self.g(worktree, "push", "-u", "origin", "unmerged")
        with r.lease_lock(worktree.parent, exclusive=False, enroll=True):
            pass
        self.args.worktrees = self.args.apply = True
        self.report()
        self.assertTrue(worktree.exists())

    def test_detached_head_is_kept(self):
        self.g(self.repo, "checkout", "--detach")
        self.assert_kept()

    def test_git_operation_lock_is_kept(self):
        (self.repo / ".git" / "index.lock").touch()
        self.assert_kept()

    def test_old_checkout_selects_cache_with_default_retention(self):
        self.args.days = 7
        with patch.object(r.time, "time", return_value=time.time() + 8 * r.DAY):
            self.assertEqual(len(self.selected(self.report())), 1)

    def test_remote_advanced_without_fetch_is_kept(self):
        other = self.base / "other"
        self.g(self.base, "clone", str(self.remote), str(other))
        self.g(other, "checkout", "main")
        self.g(other, "config", "user.name", "Test")
        self.g(other, "config", "user.email", "test@example.invalid")
        self.g(other, "commit", "--allow-empty", "-m", "remote advanced")
        self.g(other, "push")
        self.assert_kept()

    def test_shared_npm_cache_only_removed_when_idle(self):
        cache = self.home / ".npm" / "_cacache"
        cache.mkdir(parents=True)
        (cache / "blob").write_text("regenerable")
        self.args.cache = [str(cache) + "=" + str(self.repo)]
        self.args.apply = True
        with r.lease_lock("shared-caches", exclusive=False):
            report = self.report()
        self.assertTrue(cache.exists(), report)
        report = self.report()
        self.assertFalse(cache.exists(), report)
        self.assertGreater(report["categories"]["tool_cache"]["reclaimed_bytes"], 0)

    def test_shared_cache_rejects_arbitrary_directory(self):
        cache = self.home / "Documents"
        cache.mkdir()
        (cache / "work").write_text("valuable")
        self.args.cache = [str(cache) + "=" + str(self.repo)]
        self.args.apply = True
        self.report()
        self.assertTrue((cache / "work").exists())

    def test_shared_cache_preserved_for_dirty_owner(self):
        cache = self.home / ".npm" / "_cacache"
        cache.mkdir(parents=True)
        self.args.cache = [str(cache) + "=" + str(self.repo)]
        (self.repo / "source").write_text("dirty")
        self.assert_kept()
        self.assertTrue(cache.exists())

    def test_real_process_cwd_is_observed(self):
        if not r.shutil.which("lsof"):
            self.skipTest("lsof is unavailable; production fails closed")
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"], cwd=self.repo
        )
        try:
            # A complete inventory must see this cwd. An unrelated unreadable
            # process is a legitimate global retention result on shared hosts.
            try:
                paths = r.process_snapshot()
            except r.Keep:
                self.assertFalse(self.selected(r.run(self.args)))
            else:
                self.assertIn(self.repo, paths)
                with self.assertRaises(r.Keep):
                    r.idle(self.repo.parent, paths)
        finally:
            child.terminate()
            child.wait(timeout=10)

    def test_cli_lease_blocks_reaper_until_child_exits(self):
        ready = self.base / "ready"
        code = (
            "from pathlib import Path; import time; Path("
            + repr(str(ready))
            + ").touch(); time.sleep(30)"
        )
        child = subprocess.Popen(
            [
                sys.executable,
                str(SCRIPT),
                "lease",
                "--lane",
                str(self.repo.parent),
                "--",
                sys.executable,
                "-c",
                code,
            ],
            env={**os.environ, "HOME": str(self.home)},
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists())
            self.assert_kept()
        finally:
            # Terminate the wrapper AND its test child through the process group.
            import signal

            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=10)

    def test_unmanaged_lane_is_retained(self):
        with r.lease_lock(self.repo.parent, exclusive=True) as fd:
            os.ftruncate(fd, 0)
        self.assert_kept()

    def test_bare_repo_inside_cache_is_retained(self):
        self.g(self.cache, "init", "--bare", "precious.git")
        self.assert_kept()

    def test_reset_unpushed_commit_in_reflog_is_retained(self):
        self.g(
            self.repo, "commit", "--allow-empty", "-m", "recoverable unpublished work"
        )
        self.g(self.repo, "reset", "--hard", "origin/main")
        self.assert_kept()

    def test_duplicate_roots_do_not_double_count(self):
        self.args.root.append(str(self.root))
        self.assertEqual(len(self.selected(self.report())), 1)

    def test_shared_cache_dry_run_respects_global_lease(self):
        cache = self.home / ".npm" / "_cacache"
        cache.mkdir(parents=True)
        self.args.cache = [str(cache) + "=" + str(self.repo)]
        with r.lease_lock("shared-caches", exclusive=False):
            result = self.report()
        self.assertFalse(
            [e for e in self.selected(result) if e["category"] == "tool_cache"]
        )

    def test_caller_git_environment_cannot_redirect_checkout_checks(self):
        with patch.dict(
            os.environ,
            {
                "GIT_DIR": str(self.remote),
                "GIT_INDEX_FILE": str(self.base / "wrong-index"),
            },
        ):
            self.assertEqual(len(self.selected(self.report())), 1)
            (self.repo / "source").write_text("uncommitted work")
            self.assert_kept()

    def test_shared_cache_cannot_bypass_another_checkouts_git_guards(self):
        cache = self.home / ".npm" / "_cacache"
        cache.mkdir(parents=True)
        self.g(self.home, "init")
        valuable = cache / "uncommitted-source"
        valuable.write_text("precious")
        self.args.cache = [str(cache) + "=" + str(self.repo)]
        self.args.apply = True
        self.report()
        self.assertTrue(valuable.exists())

    def test_invalid_age_rejected(self):
        for value in ["nan", "inf", "-1"]:
            with self.assertRaises(SystemExit) as result:
                r.main(["run", "--root", str(self.root), "--days", value])
            self.assertEqual(result.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
