#!/usr/bin/env python3
"""Check Cargo's integration-test binary selection without compiling the probe.

The fixture copies the real binary target gates, replaces application code and
external dependencies with tiny programs, and exercises Cargo's actual target
selection. No registry access, GTK installation or production build is needed.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
PRODUCTION_FEATURE = "production-binaries"
FAKE_CORE = "agent-relay-fake-core"


def cargo(manifest, *arguments):
    # Ignore an inherited target directory so this test never writes into a
    # real application build or shares outputs between temporary fixtures.
    environment = os.environ.copy()
    environment.pop("CARGO_TARGET_DIR", None)
    environment["CARGO_INCREMENTAL"] = "0"
    result = subprocess.run(
        ["cargo", *arguments, "--manifest-path", str(manifest), "--offline"],
        cwd=manifest.parent,
        env=environment,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    return result.stdout


def compiled_binaries(output):
    binaries = set()
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # The test runner also writes its ordinary text output to stdout.
            continue
        if event.get("reason") == "compiler-artifact":
            target = event["target"]
            if "bin" in target["kind"]:
                binaries.add(target["name"])
    return binaries


class CargoTargetSelection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        metadata = json.loads(
            cargo(REPO / "probe/Cargo.toml", "metadata", "--no-deps", "--format-version", "1")
        )
        package = next(package for package in metadata["packages"] if package["name"] == "agent-relay-probe")
        cls.features = package["features"]
        cls.binaries = {
            target["name"]: target for target in package["targets"] if "bin" in target["kind"]
        }

    def test_defaults_keep_production_targets_and_fake_core_is_ungated(self):
        self.assertIn(PRODUCTION_FEATURE, self.features.get("default", []))
        self.assertEqual(self.features[PRODUCTION_FEATURE], [])
        self.assertEqual(self.binaries[FAKE_CORE].get("required-features", []), [])
        self.assertEqual(
            set(self.binaries) - {FAKE_CORE},
            {"agent-relay-desktop", "agent-relay-probe", "relay-contract-codegen"},
        )
        for name, target in self.binaries.items():
            if name != FAKE_CORE:
                self.assertEqual(target.get("required-features"), [PRODUCTION_FEATURE], name)

    def test_cargo_only_builds_fake_core_for_targeted_windows_style_tests(self):
        with tempfile.TemporaryDirectory(prefix="relay-cargo-targets-") as directory:
            root = Path(directory)
            (root / "src/bin").mkdir(parents=True)
            (root / "tests").mkdir()
            manifest = root / "Cargo.toml"
            entries = [
                '[package]\nname = "target-selection-fixture"\nversion = "0.0.0"\nedition = "2021"',
                "[workspace]",
                "[features]\ndefault = " + json.dumps(self.features.get("default", [])),
                PRODUCTION_FEATURE + " = " + json.dumps(self.features[PRODUCTION_FEATURE]),
                "gtk = []",
            ]
            for name, target in sorted(self.binaries.items()):
                entries.append(
                    "[[bin]]\nname = " + json.dumps(name)
                    + "\npath = " + json.dumps("src/bin/" + name + ".rs")
                    + "\nrequired-features = " + json.dumps(target.get("required-features", []))
                )
                (root / "src/bin" / (name + ".rs")).write_text(
                    'fn main() { println!("fake-core"); }\n'
                    if name == FAKE_CORE else "fn main() {}\n"
                )
            entries.append(
                '[[test]]\nname = "linux_app_gtk"\npath = "tests/linux_app_gtk.rs"'
                '\nharness = false\nrequired-features = ["gtk"]'
            )
            manifest.write_text("\n\n".join(entries) + "\n")
            (root / "src/lib.rs").write_text(
                "pub fn window() -> bool { true }\n"
                "#[test] fn state() { assert!(window()); }\n"
            )
            # The real GTK harness constructs the window in-process. On
            # Windows, hosting spawns only this fake executable; APP is Unix-only.
            (root / "tests/linux_app_gtk.rs").write_text(
                "fn main() { assert!(target_selection_fixture::window()); }\n"
            )
            (root / "tests/linux_app_hosting.rs").write_text(
                '#[test] fn hosts_fake_core() {\n'
                ' let output = std::process::Command::new(env!("CARGO_BIN_EXE_agent-relay-fake-core"))'
                '.output().unwrap();\n'
                ' assert!(output.status.success());\n'
                ' assert_eq!(output.stdout, b"fake-core\\n");\n}\n'
            )
            targeted = cargo(
                manifest, "test", "--no-default-features", "--features", "gtk",
                "--lib", "--test", "linux_app_gtk", "--test", "linux_app_hosting",
                "--message-format", "json",
            )
            self.assertEqual(compiled_binaries(targeted), {FAKE_CORE})
            default = cargo(manifest, "check", "--features", "gtk", "--bins", "--message-format", "json")
            self.assertEqual(compiled_binaries(default), set(self.binaries))
            app_check = cargo(
                manifest, "check", "--features", "gtk", "--bin", "agent-relay-desktop", "--message-format", "json"
            )
            self.assertEqual(compiled_binaries(app_check), {"agent-relay-desktop"})


if __name__ == "__main__":
    unittest.main()
