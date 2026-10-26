#!/usr/bin/env python3
"""Select CI jobs conservatively from a NUL-delimited git path list.

Use --base/--head to collect the paths, or pipe the output of
`git diff --name-only --no-renames -z BASE HEAD` into stdin. Disabling rename
detection is essential: both the removed and added paths must be classified.
Unknown paths, malformed/empty stdin and unavailable revisions run all jobs.
A successful Git comparison with no changed paths selects no jobs. The stdout
key=value lines can be appended directly to GITHUB_OUTPUT.
"""

import argparse
import os
from pathlib import Path
import subprocess
import sys


JOBS = (
    "shell", "probe", "macos", "macos_core", "macos_package",
    "linux", "linux_core", "linux_integration", "linux_package",
    "windows", "windows_package",
)
PACKAGE_JOBS = frozenset({"macos_package", "linux_package", "windows_package"})
SWIFT_SOURCE_DIRS = (
    "macos/Sources/RelayDesktop/", "macos/Sources/RelayDesktopCore/",
    "macos/Tests/RelayDesktopTests/",
    "shared/RelaySessionOverview/Sources/RelaySessionOverview/",
    "shared/RelaySessionOverview/Tests/RelaySessionOverviewTests/",
)
MACOS_BUILD_INPUTS = frozenset({
    "macos/Package.swift", "macos/Package.resolved", "macos/Info.plist.template",
    "macos/RelayDesktop.entitlements", "shared/RelaySessionOverview/Package.swift",
    "shared/RelaySessionOverview/Package.resolved",
})
DOCUMENTS = frozenset({
    "README.md", "AGENTS.md", "CLAUDE.md", ".github/README.md",
    "macos/README.md", "linux/README.md", "windows/README.md",
    "probe/README.md", "integrations/capy/README.md", "integrations/replicas/README.md",
    "probe/resources/windows/icons/README.md", "probe/resources/windows/icons/dev/README.md",
    "assets/dmg-background.prompt.txt",
    # These existing prose files were reviewed for build/test consumers.
    # Freeze the paths: a new docs/*.md remains unknown until reviewed.
    "docs/agent-details.md", "docs/agent-driven-setup.md", "docs/agent-relay-probe.md",
    "docs/agents-people.md", "docs/capy-thread-spawn.md", "docs/cloud-receiver.md",
    "docs/contractor-access.md", "docs/e2e-approval-plan.md", "docs/existing-session-injection.md",
    "docs/grok-existing-session-injection.md", "docs/harness-setup.md",
    "docs/hosted-mcp-desktop-identity-live-check.md", "docs/injectable-agents.md",
    "docs/machine-address-verification.md", "docs/macos-core-startup-incident.md",
    "docs/mcp-agent-credentials.md", "docs/muse-managed-msp.md",
    "docs/muse-open-session-injection.md", "docs/native-connect.md", "docs/native-delivery-spec.md",
    "docs/native-spawn.md", "docs/node-lifecycle.md", "docs/openclaw-hermes-delivery.md",
    "docs/opencode-existing-session-injection.md", "docs/ownership-delegation.md",
    "docs/pi-existing-session-injection.md", "docs/plan.md", "docs/probe-ownership-plan.md",
    "docs/quota.md", "docs/session-title-editing.md", "docs/skip-chat.md",
    "docs/spawn-restart-dogfood.md", "docs/spawn-validation.md", "docs/windows-app.md",
    "docs/workspace-layout.md",
})
GENERATED_CONTRACT = "macos/Sources/RelayDesktopCore/CoreContract.swift"
MONOREPO_PREFIX = "apps/desktop/"


def all_jobs():
    return dict.fromkeys(JOBS, True)


def path_jobs(path):
    """An allowlist of safe exclusions; new paths select all component groups."""
    if not path or path.startswith("/") or any(p in (".", "..") for p in path.split("/")):
        return set(JOBS)
    if path in DOCUMENTS:
        return set()
    # Only reviewed prose files and screenshot locations are exempt. In
    # particular, docs/relay-core.md is consumed by Rust contract tests.
    if path.startswith(("docs/images/", "docs/screenshots/")) and path.endswith(".png"):
        return set()
    if path.startswith("ipad/"):
        return set()
    if path == "probe/tests/linux_app_gtk.rs" or (
        path.startswith("probe/tests/linux_app_gtk/") and path.endswith(".rs")
    ):
        # This harness and its Rust modules run only on the GTK platforms.
        return {"linux", "windows"}
    if path == "probe/tests/pi_live_session.rs":
        return {"probe", "macos_core"}
    if path == "scripts/test-pi-live.sh":
        return {"shell", "probe", "macos_core"}
    if path == GENERATED_CONTRACT:
        # Probe regenerates this file and verifies that it matches Rust. The
        # checked-in Swift output is not a Rust/npm input, so the independent
        # macOS core tests are needed only if their own inputs also change.
        return {"probe", "macos"}
    if path in MACOS_BUILD_INPUTS or path.startswith("macos/Sources/RelayDesktop/Resources/"):
        return {"macos", "macos_package"}
    if path.startswith(SWIFT_SOURCE_DIRS) and path.endswith(".swift"):
        return {"macos"}
    if path.startswith("linux/"):
        return {"shell", "linux", "linux_core", "linux_integration", "linux_package"}
    if path.startswith("windows/"):
        return {"shell", "windows", "windows_package"}
    if path == "CHANGELOG.md":
        # Routine changelog edits add no lanes, including alongside code.
        # build.rs still reads the release heading: validate it on the next
        # selected build or the release's explicit force-all prerequisite.
        return set()
    if path.startswith("probe/src/linux_app/ui/") and path.endswith(".rs"):
        # This module is cfg(feature = "gtk"). Exercise the native GTK app
        # and its real-core hosting without scheduling non-GTK core checks.
        return {"linux", "linux_core", "linux_integration", "windows"}
    if path.startswith(("probe/src/", "probe/tests/")) and path.endswith(".rs"):
        # Ordinary crate modules and test code retain all native test/core
        # coverage. Packaging is deferred until release unless build inputs
        # also change. Do not use a repository-wide .rs exemption:
        # build.rs, build_version.rs and new
        # source locations require packaging validation until reviewed.
        return set(JOBS) - PACKAGE_JOBS
    # Cargo/build files, scripts, shared fixtures, resources, assets, config
    # and CI definitions select all component groups, including macos_core.
    return set(JOBS)


def classify_paths(data):
    """Read paths without splitting spaces/newlines or assuming UTF-8 names."""
    if not data or not data.endswith(b"\0"):
        return all_jobs()
    paths = data[:-1].split(b"\0")
    if any(not path for path in paths):
        return all_jobs()
    selected = set()
    for path in paths:
        path = os.fsdecode(path)
        if path.startswith(MONOREPO_PREFIX):
            path = path[len(MONOREPO_PREFIX):]
        selected.update(path_jobs(path))
    return {job: job in selected for job in JOBS}


def diff_paths(base, head):
    """Return both sides of renames and deleted paths, independent of git config."""
    if not base or not head or base.startswith("-") or head.startswith("-"):
        raise ValueError("base and head must be nonempty revisions")
    return subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, head, "--"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="base revision of a two-endpoint diff")
    parser.add_argument("--head", help="head revision of a two-endpoint diff")
    parser.add_argument("--all", action="store_true", help="select every job (fallback)")
    parser.add_argument("--github-output", type=Path, help="also append outputs to this file")
    args = parser.parse_args(argv)
    try:
        if args.all:
            selected = all_jobs()
        elif args.base is not None or args.head is not None:
            paths = diff_paths(args.base, args.head)
            # Only a successful Git comparison establishes an unchanged tree.
            # Empty stdin may instead mean a failed upstream diff/transport.
            selected = classify_paths(paths) if paths else dict.fromkeys(JOBS, False)
        else:
            selected = classify_paths(sys.stdin.buffer.read())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Could not determine changed paths; running all CI jobs: {error}", file=sys.stderr)
        selected = all_jobs()
    output = "".join(f"{job}={str(selected[job]).lower()}\n" for job in JOBS)
    sys.stdout.write(output)
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as destination:
            destination.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
