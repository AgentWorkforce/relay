#!/usr/bin/env python3
"""Conservative per-user fleet retention. No third-party Python dependencies."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

DAY = 86400
CATEGORIES = ("node_modules", "build_cache", "tool_cache", "worktree")
CACHE_NAMES = {"node_modules": "node_modules", "target": "build_cache"}


class Keep(Exception):
    """A safety precondition is false or cannot be proved."""


def command(args, cwd=None):
    git_overrides = {
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_SHALLOW_FILE",
    }
    environment = {
        key: value for key, value in os.environ.items() if key not in git_overrides
    }
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            timeout=30,
            env={
                **environment,
                "GIT_NO_REPLACE_OBJECTS": "1",
                "GIT_OPTIONAL_LOCKS": "0",
                "GIT_TERMINAL_PROMPT": "0",
            },
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Keep("command unavailable or timed out") from None
    if result.returncode:
        # Never echo stderr: remote URLs and credential helpers may contain secrets.
        raise Keep("command failed")
    return result.stdout.decode("utf-8", errors="strict")


def git(repo, *args):
    return command(
        [
            "git",
            *(["--literal-pathspecs"] if args[0] == "ls-files" else []),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            str(repo),
            *args,
        ]
    ).strip()


def within(path, parent):
    return path == parent or parent in path.parents


def canonical(path):
    path = Path(os.path.abspath(os.path.expanduser(str(path))))
    if path.resolve(strict=True) != path:
        raise Keep("symlink in path")
    if not path.is_dir() or path.stat().st_uid != os.getuid():
        raise Keep("directory must belong to the reaper user")
    return path


def process_snapshot():
    """Require cwd coverage for every surviving process owned by this user.

    lsof output is parsed privately; neither argv nor environment is collected.
    An unreadable process, warning, or incomplete inventory stops reclamation.
    """

    def pids():
        try:
            with subprocess.Popen(
                ["ps", "-e", "-o", "pid=,uid=,stat="],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ) as probe:
                output, errors = probe.communicate(timeout=30)
                if probe.returncode or errors:
                    raise Keep("process list unavailable")
                records = [line.split() for line in output.splitlines()]
                if not records or any(len(record) != 3 for record in records):
                    raise Keep("malformed process list")
                return {
                    int(pid)
                    for pid, uid, state in records
                    if int(uid) == os.getuid() and not state.startswith(b"Z")
                } - {probe.pid}
        except (OSError, subprocess.TimeoutExpired):
            raise Keep("process list unavailable") from None

    pids()
    try:
        result = subprocess.run(
            ["lsof", "-nP", "-a", "-u", str(os.getuid()), "-F0pfn"],
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Keep("process inventory unavailable") from None
    if result.returncode or result.stderr.strip():
        raise Keep("process inventory incomplete")
    covered, paths = set(), set()
    pid, fd = None, None
    for field in result.stdout.decode("utf-8", errors="strict").split("\0"):
        field = field.lstrip("\n")
        if field.startswith("p"):
            pid, fd = int(field[1:]), None
        elif field.startswith("f"):
            fd = field[1:]
        elif field.startswith("n"):
            name = field[1:]
            if fd == "cwd":
                if not name.startswith("/") or name.endswith(" (deleted)"):
                    raise Keep("process cwd unreadable")
                covered.add(pid)
            if name.startswith("/"):
                paths.add(Path(name.removesuffix(" (deleted)")).resolve())
    if pids() - covered - {os.getpid()}:
        raise Keep("process inventory changed or lacks cwd coverage")
    return paths


def idle(lane, paths):
    if any(within(path, lane) for path in paths):
        raise Keep("active lane or open file")


def git_safe(repo, days, now):
    if Path(git(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
        raise Keep("not a checkout root")
    git(
        repo, "symbolic-ref", "--quiet", "HEAD"
    )  # Detached HEAD is deliberately retained.
    if git(
        repo,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ):
        raise Keep("uncommitted or untracked work")
    if git(repo, "stash", "list"):
        raise Keep("stashed work")
    index = git(repo, "ls-files", "--stage")
    if index.startswith("160000 ") or "\n160000 " in index:
        raise Keep("submodules require manual retention")
    # skip-worktree / assume-unchanged can hide edits from status.
    if any(
        line and (line[0].islower() or line[0] == "S")
        for line in git(repo, "ls-files", "-v").splitlines()
    ):
        raise Keep("index flags can hide uncommitted work")
    branches = git(
        repo,
        "for-each-ref",
        "--format=%(refname)\t%(upstream)\t%(upstream:remotename)\t%(upstream:remoteref)",
        "refs/heads/",
    )
    if not branches:
        raise Keep("no local branch")
    for line in branches.splitlines():
        fields = line.split("\t")
        if len(fields) != 4 or not all(fields) or fields[2] == ".":
            raise Keep("branch has no remote upstream")
        branch, upstream, remote, remote_ref = fields
        advertised = git(
            repo, "ls-remote", "--exit-code", "--", remote, remote_ref
        ).splitlines()
        expected = git(repo, "rev-parse", upstream)
        if advertised != [expected + "\t" + remote_ref]:
            raise Keep("remote upstream changed; fetch before reaping")
        if git(repo, "rev-list", upstream + ".." + branch):
            raise Keep("unpushed commits")
    if git(repo, "rev-list", "--reflog", "--all", "--not", "--remotes"):
        raise Keep("local-only reachable commits")
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    private = Path(git(repo, "rev-parse", "--absolute-git-dir"))
    newest = max(repo.stat().st_mtime, repo.stat().st_ctime)
    for directory in {common, private}:
        for base, dirs, files in os.walk(
            directory, onerror=lambda e: (_ for _ in ()).throw(e)
        ):
            for name in dirs + files:
                info = (Path(base) / name).lstat()
                newest = max(newest, info.st_mtime, info.st_ctime)
                if name.endswith(".lock") or name in {
                    "MERGE_HEAD",
                    "REBASE_HEAD",
                    "CHERRY_PICK_HEAD",
                    "rebase-merge",
                    "rebase-apply",
                }:
                    raise Keep("Git operation in progress")
    if now - newest < days * DAY:
        raise Keep("recent Git activity")


def tree_info(path, worktree=False):
    """Never follow symlinks or cross mounts; embedded repositories are retained."""
    if path.is_mount():
        raise Keep("candidate is a filesystem mount")
    root_device = path.lstat().st_dev
    total, newest = 0, 0
    for base, dirs, files in os.walk(
        path, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)
    ):
        if "HEAD" in files and "objects" in dirs:
            raise Keep("embedded bare repository")
        for name in dirs + files:
            child = Path(base) / name
            info = child.lstat()
            if (
                name == ".git"
                and not (worktree and Path(base) == path and stat.S_ISREG(info.st_mode))
            ) or info.st_dev != root_device:
                raise Keep("embedded repository or mounted filesystem")
            if not (
                stat.S_ISREG(info.st_mode)
                or stat.S_ISDIR(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
            ):
                raise Keep("special file in candidate")
            total += info.st_blocks * 512
            newest = max(newest, info.st_mtime, info.st_ctime)
    info = path.lstat()
    return total + info.st_blocks * 512, max(newest, info.st_mtime, info.st_ctime)


def candidates(repo):
    """Find dependency and Cargo output trees, including monorepo packages."""
    for base, dirs, _ in os.walk(
        repo, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)
    ):
        dirs[:] = sorted(
            d for d in dirs if d != ".git" and not (Path(base) / d).is_symlink()
        )
        if Path(base) != repo and (Path(base) / ".git").exists():
            dirs[:] = []
            continue
        for name in list(dirs):
            if name in CACHE_NAMES:
                yield Path(base) / name, CACHE_NAMES[name]
                dirs.remove(name)


def checkout_roots(lane):
    for base, dirs, files in os.walk(
        lane, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)
    ):
        if ".git" in dirs or ".git" in files:
            yield Path(base)
            dirs[:] = []
        else:
            dirs[:] = sorted(
                d
                for d in dirs
                if not (Path(base) / d).is_symlink() and d not in CACHE_NAMES
            )


def cache_safe(repo, path, days, now, external=False):
    canonical(path)
    if within(path, repo):
        relative = path.relative_to(repo).as_posix()
        if git(repo, "ls-files", "--", relative):
            raise Keep("cache contains tracked files")
        git(repo, "check-ignore", "--", relative + "/")
    elif not external:
        raise Keep("cache outside checkout")
    else:
        # An explicit owner mapping cannot waive another checkout's Git safety.
        # lstat failures other than absence propagate and retain the cache.
        for ancestor in (path, *path.parents):
            try:
                (ancestor / ".git").lstat()
            except FileNotFoundError:
                pass
            else:
                raise Keep("external cache belongs to another checkout")
            if (ancestor / "HEAD").exists() and (ancestor / "objects").is_dir():
                raise Keep("external cache belongs to a bare repository")
    size, newest = tree_info(path)
    if now - newest < days * DAY:
        raise Keep("recent cache activity")
    return size


def worktree_safe(repo, base):
    private = Path(git(repo, "rev-parse", "--absolute-git-dir"))
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    if private == common:
        raise Keep("primary checkout is never removed")
    if (private / "locked").exists():
        raise Keep("worktree is locked")
    # The merge target must itself be a verified remote-tracking ref.
    if not base.startswith("refs/remotes/"):
        raise Keep("merge target must be a remote-tracking ref")
    if git(repo, "for-each-ref", "--format=%(refname)", base) != base:
        raise Keep("merge target missing or ambiguous")
    remote_branch = base[len("refs/remotes/") :]
    remote, branch = remote_branch.split("/", 1)
    ref = "refs/heads/" + branch
    if git(repo, "ls-remote", "--exit-code", "--", remote, ref).splitlines() != [
        git(repo, "rev-parse", base) + "\t" + ref
    ]:
        raise Keep("merge target changed; fetch before reaping")
    git(repo, "merge-base", "--is-ancestor", "HEAD", base)
    if git(repo, "ls-files", "--others", "--ignored", "--exclude-standard"):
        raise Keep("ignored files remain; reap caches first")
    # Reject nested repositories (including ignored/bare repositories).
    tree_info(repo, worktree=True)
    return common


@contextlib.contextmanager
def lease_lock(lane, exclusive, enroll=False):
    state = Path.home() / ".local" / "state" / "agent-relay" / "disk-reaper"
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    canonical(state)
    if state.stat().st_mode & 0o077:
        raise Keep("lease directory must be private (mode 0700)")
    key = hashlib.sha256(os.fsencode(str(lane))).hexdigest()
    fd = os.open(state / (key + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
        ):
            raise Keep("unsafe lease file")
        try:
            fcntl.flock(
                fd, (fcntl.LOCK_EX | fcntl.LOCK_NB) if exclusive else fcntl.LOCK_SH
            )
        except BlockingIOError:
            raise Keep("active lane lease") from None
        if enroll:
            os.pwrite(fd, b"fleet-reaper-lease-v1\n", 0)
        yield fd
    finally:
        os.close(fd)


def external_cache(path):
    home = Path.home().resolve()
    allowed = [
        home / ".npm" / "_cacache",
        home / "Library" / "Developer" / "Xcode" / "DerivedData",
    ]
    if path in allowed or (path.parent == home / "Library" / "Caches"):
        return
    raise Keep("external cache is not an allowlisted regenerable location")


def run(args, snapshot=process_snapshot):
    rows = []
    before = {}
    visited = set()

    def row(path, category, status, reason="", size=0):
        rows.append(
            dict(
                path=str(path),
                category=category,
                status=status,
                reason=reason,
                bytes=size,
            )
        )

    try:
        initial_paths = snapshot()
        inventory_error = None
    except (Keep, OSError, ValueError) as error:
        initial_paths, inventory_error = set(), str(error)
    for root_arg in args.root:
        try:
            root = canonical(root_arg)
            before[str(root)] = shutil.disk_usage(root).free
            lanes = sorted(root.iterdir())
        except (Keep, OSError, ValueError) as error:
            row(root_arg, "node_modules", "kept", str(error))
            continue
        for lane in lanes:
            if not lane.is_dir() or lane.is_symlink():
                continue
            try:
                canonical(lane)
                with lease_lock(lane, exclusive=True) as lane_fd:
                    if inventory_error:
                        raise Keep(inventory_error)
                    idle(lane, initial_paths)
                    repos = list(checkout_roots(lane))
                    for repo in repos:
                        if repo in visited:
                            continue
                        visited.add(repo)
                        try:
                            git_safe(repo, args.days, time.time())
                        except (Keep, OSError, ValueError) as error:
                            row(repo, "node_modules", "kept", str(error))
                            continue
                        if os.pread(lane_fd, 64, 0) != b"fleet-reaper-lease-v1\n":
                            row(
                                repo,
                                "node_modules",
                                "kept",
                                "unmanaged lane: launch agents through lease before enabling retention",
                            )
                            continue
                        targets = list(candidates(repo))
                        for mapping in args.cache:
                            cache, owner = mapping.split("=", 1)
                            if Path(owner).expanduser().resolve() == repo:
                                targets.append((Path(cache).expanduser(), "tool_cache"))
                        for path, category in targets:
                            try:
                                if path in visited:
                                    continue
                                visited.add(path)
                                external = category == "tool_cache"
                                if external:
                                    external_cache(path)
                                with contextlib.ExitStack() as locks:
                                    if external:
                                        locks.enter_context(
                                            lease_lock("shared-caches", exclusive=True)
                                        )
                                    size = cache_safe(
                                        repo, path, args.days, time.time(), external
                                    )
                                    idle(path, initial_paths)
                                    if args.apply:
                                        # Fresh guards while leases exclude cooperating launches.
                                        git_safe(repo, args.days, time.time())
                                        paths = snapshot()
                                        idle(lane, paths)
                                        idle(path, paths)
                                        cache_safe(
                                            repo, path, args.days, time.time(), external
                                        )
                                        if not shutil.rmtree.avoids_symlink_attacks:
                                            raise Keep(
                                                "platform lacks safe directory deletion"
                                            )
                                        shutil.rmtree(path)
                                    row(
                                        path,
                                        category,
                                        "reclaimed" if args.apply else "would_reclaim",
                                        size=size,
                                    )
                            except (Keep, OSError, ValueError) as error:
                                row(path, category, "kept", str(error))
                        if args.worktrees:
                            try:
                                common = worktree_safe(repo, args.merge_base)
                                size = tree_info(repo, worktree=True)[0]
                                idle(lane, snapshot())
                                if args.apply:
                                    git_safe(repo, args.days, time.time())
                                    worktree_safe(repo, args.merge_base)
                                    idle(lane, snapshot())
                                    command(
                                        [
                                            "git",
                                            "--git-dir=" + str(common),
                                            "worktree",
                                            "remove",
                                            "--",
                                            str(repo),
                                        ]
                                    )
                                row(
                                    repo,
                                    "worktree",
                                    "reclaimed" if args.apply else "would_reclaim",
                                    size=size,
                                )
                            except (Keep, OSError, ValueError) as error:
                                row(repo, "worktree", "kept", str(error))
            except (Keep, OSError, ValueError) as error:
                row(lane, "node_modules", "kept", str(error))
    after = {root: shutil.disk_usage(root).free for root in before}
    totals = {
        category: {"would_reclaim_bytes": 0, "reclaimed_bytes": 0, "kept": 0}
        for category in CATEGORIES
    }
    for item in rows:
        key = item["status"] + "_bytes"
        if key in totals[item["category"]]:
            totals[item["category"]][key] += item["bytes"]
        else:
            totals[item["category"]]["kept"] += 1
    return dict(
        event="fleet_disk_reaper",
        dry_run=not args.apply,
        free_before_bytes=before,
        free_after_bytes=after,
        categories=totals,
        entries=rows,
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    reap = sub.add_parser("run", help="Report candidates; deletion requires --apply")
    reap.add_argument(
        "--root",
        action="append",
        required=True,
        help="Directory whose children are lanes",
    )
    reap.add_argument("--days", type=float, default=7)
    reap.add_argument("--apply", action="store_true")
    reap.add_argument("--worktrees", action="store_true")
    reap.add_argument("--merge-base", default="refs/remotes/origin/main")
    reap.add_argument(
        "--cache", action="append", default=[], metavar="CACHE=OWNER_CHECKOUT"
    )
    reap.add_argument("--json", action="store_true")
    lease = sub.add_parser(
        "lease", help="Hold a lane lease for the entire agent lifetime"
    )
    lease.add_argument("--lane", required=True)
    lease.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.action == "lease":
            cmd = args.command[1:] if args.command[:1] == ["--"] else args.command
            if not cmd:
                parser.error("lease requires a command after --")
            with lease_lock("shared-caches", exclusive=False) as global_fd:
                with lease_lock(
                    canonical(args.lane), exclusive=False, enroll=True
                ) as fd:
                    return subprocess.call(cmd, pass_fds=(global_fd, fd))
        if not math.isfinite(args.days) or args.days < 0:
            parser.error("--days must be a finite nonnegative number")
        if any(
            "=" not in mapping or not all(mapping.split("=", 1))
            for mapping in args.cache
        ):
            parser.error("--cache requires CACHE=OWNER_CHECKOUT")
        report = run(args)
        if not args.json:
            print("DRY RUN" if report["dry_run"] else "APPLY")
            print("Category          Would reclaim bytes    Reclaimed bytes    Kept")
            for category, counts in report["categories"].items():
                print(
                    f"{category:<18}{counts['would_reclaim_bytes']:>19}{counts['reclaimed_bytes']:>19}{counts['kept']:>8}"
                )
            for root, free in report["free_before_bytes"].items():
                print(
                    f"Free bytes {root!r}: {free} -> {report['free_after_bytes'][root]}"
                )
            for item in report["entries"]:
                print(
                    f"{item['status']}: {item['path']!r} ({item['bytes']} bytes) {item['reason']}"
                )
        print(json.dumps(report, sort_keys=True))
        return 0
    except (Keep, OSError, ValueError) as error:
        print(
            json.dumps(
                dict(event="fleet_disk_reaper", error=str(error), reclaimed_bytes=0)
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
