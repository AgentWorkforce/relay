#!/usr/bin/env python3
"""Build release notes from CHANGELOG.md and promote its Unreleased section."""

import argparse
import re
from pathlib import Path

UNRELEASED_HEADING = "## Unreleased"


def _sections(text: str) -> list[str]:
    return re.split(r"(?=^## )", text, flags=re.MULTILINE)


def _section_body(section: str) -> str:
    return "\n".join(section.splitlines()[1:]).strip()


def _require_bullets(heading: str, body: str) -> str:
    if not re.search(r"^[-*] \S", body, flags=re.MULTILINE):
        raise ValueError(f"{heading} must contain at least one release note bullet")
    return body


def changes_for_version(changelog: Path, version: str) -> str:
    sections = _sections(changelog.read_text(encoding="utf-8"))
    heading = f"## v{version}"
    matches = [s for s in sections if s.startswith(f"{heading}\n")]
    if len(matches) > 1:
        raise ValueError(f"Expected exactly one {heading} section in {changelog}")
    if matches:
        return _require_bullets(heading, _section_body(matches[0]))

    unreleased = [s for s in sections if s.startswith(f"{UNRELEASED_HEADING}\n")]
    if len(unreleased) != 1:
        raise ValueError(
            f"Expected one {heading} or {UNRELEASED_HEADING} section in {changelog}"
        )
    return _require_bullets(UNRELEASED_HEADING, _section_body(unreleased[0]))


def promote_changelog(changelog: Path, version: str) -> bool:
    """Rename Unreleased to v<version> above a fresh Unreleased. True if written."""
    text = changelog.read_text(encoding="utf-8")
    sections = _sections(text)
    heading = f"## v{version}"
    if any(s.startswith(f"{heading}\n") for s in sections):
        changes_for_version(changelog, version)
        return False

    indexes = [i for i, s in enumerate(sections) if s.startswith(f"{UNRELEASED_HEADING}\n")]
    if len(indexes) != 1:
        raise ValueError(f"Expected exactly one {UNRELEASED_HEADING} section in {changelog}")
    body = _require_bullets(UNRELEASED_HEADING, _section_body(sections[indexes[0]]))
    sections[indexes[0]] = f"{UNRELEASED_HEADING}\n\n{heading}\n\n{body}\n\n"
    changelog.write_text("".join(sections), encoding="utf-8")
    return True


def _section_index(sections: list[str], heading: str) -> int | None:
    indexes = [i for i, s in enumerate(sections) if s.startswith(f"{heading}\n")]
    if len(indexes) > 1:
        raise ValueError(f"Expected at most one {heading} section")
    return indexes[0] if indexes else None


def merge_promotion(base_text: str, promoted_text: str, latest_text: str, version: str) -> tuple[str, bool]:
    """Apply a snapshot's promotion onto the newest changelog.

    The v<version> section takes the snapshot's Unreleased bullets. Lines the
    newest changelog added to Unreleased after the snapshot stay in Unreleased.
    """
    heading = f"## v{version}"
    promoted = _sections(promoted_text)
    p_idx = _section_index(promoted, heading)
    if p_idx is None:
        raise ValueError(f"Promoted snapshot has no {heading} section")
    version_body = _require_bullets(heading, _section_body(promoted[p_idx]))

    latest = _sections(latest_text)
    v_idx = _section_index(latest, heading)
    if v_idx is not None:
        if _section_body(latest[v_idx]) != version_body:
            raise ValueError(f"Latest changelog already has a different {heading} section")
        return latest_text, False

    base = _sections(base_text)
    b_idx = _section_index(base, UNRELEASED_HEADING)
    base_lines = _section_body(base[b_idx]).splitlines() if b_idx is not None else []

    l_idx = _section_index(latest, UNRELEASED_HEADING)
    if l_idx is None:
        raise ValueError(f"Latest changelog has no {UNRELEASED_HEADING} section")
    remaining = _section_body(latest[l_idx]).splitlines()
    for line in base_lines:
        if line in remaining:
            remaining.remove(line)
    additions = "\n".join(remaining).strip()
    if additions:
        latest[l_idx] = f"{UNRELEASED_HEADING}\n\n{additions}\n\n{heading}\n\n{version_body}\n\n"
    else:
        latest[l_idx] = f"{UNRELEASED_HEADING}\n\n{heading}\n\n{version_body}\n\n"
    return "".join(latest), True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--changelog", type=Path, default=Path("CHANGELOG.md"))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--promote", action="store_true")
    parser.add_argument("--base", type=Path)
    parser.add_argument("--merge", type=Path)
    parser.add_argument("--repository", default="AgentWorkforce/relay-desktop-releases")
    parser.add_argument("--probe-version")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.merge:
        if not args.base:
            parser.error("--base is required with --merge")
        merged, changed = merge_promotion(
            args.base.read_text(encoding="utf-8"),
            args.changelog.read_text(encoding="utf-8"),
            args.merge.read_text(encoding="utf-8"),
            args.version,
        )
        if changed:
            args.merge.write_text(merged, encoding="utf-8")
            print(f"Merged v{args.version} promotion into {args.merge}")
        else:
            print(f"v{args.version} already promoted in {args.merge}")
        return

    if args.promote:
        changed = promote_changelog(args.changelog, args.version)
        print(f"Promoted Unreleased to v{args.version}" if changed else f"v{args.version} already in CHANGELOG.md")
        return

    changes = changes_for_version(args.changelog, args.version)
    if args.check:
        return
    if not args.probe_version or not args.output:
        parser.error("--probe-version and --output are required unless --check or --promote is set")

    tag = f"v{args.version}"
    base = f"https://github.com/{args.repository}/releases/download/{tag}"
    body = f"""Agent Relay for macOS, Linux and Windows {tag}.

**Downloads**

- Apple silicon: [`AgentRelay-macOS-arm64.dmg`]({base}/AgentRelay-macOS-arm64.dmg)
- Intel: [`AgentRelay-macOS-x64.dmg`]({base}/AgentRelay-macOS-x64.dmg)
- Linux x64: [`AgentRelay-Linux-x64.deb`]({base}/AgentRelay-Linux-x64.deb) or [`AgentRelay-Linux-x64.tar.gz`]({base}/AgentRelay-Linux-x64.tar.gz)
- Linux arm64: [`AgentRelay-Linux-arm64.deb`]({base}/AgentRelay-Linux-arm64.deb) or [`AgentRelay-Linux-arm64.tar.gz`]({base}/AgentRelay-Linux-arm64.tar.gz)
- Windows x64: [`AgentRelay-Windows-x64-Setup.exe`]({base}/AgentRelay-Windows-x64-Setup.exe) or [`AgentRelay-Windows-x64.zip`]({base}/AgentRelay-Windows-x64.zip)
- Windows arm64: [`AgentRelay-Windows-arm64-Setup.exe`]({base}/AgentRelay-Windows-arm64-Setup.exe) or [`AgentRelay-Windows-arm64.zip`]({base}/AgentRelay-Windows-arm64.zip)

## What's new in this release

{changes}

**Bundled probe**

Bundled `agent-relay-probe`: `{args.probe_version}`.
"""
    args.output.write_text(body, encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        raise SystemExit(f"release-notes: {exc}") from exc
