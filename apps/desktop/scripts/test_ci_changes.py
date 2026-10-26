#!/usr/bin/env python3
"""Regression tests for CI exclusions and the actual git-diff transport."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("ci-changes.py")
SPEC = importlib.util.spec_from_file_location("ci_changes", SCRIPT)
CHANGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHANGES)
NATIVE_GROUPS = {"shell", "probe", "macos", "macos_core", "linux", "linux_core",
                 "linux_integration", "windows"}
GTK_UI_GROUPS = {"linux", "linux_core", "linux_integration", "windows"}


def selected(*paths):
    data = b"".join(path.encode("utf-8") + b"\0" for path in paths)
    return {name for name, enabled in CHANGES.classify_paths(data).items() if enabled}


class ClassificationTests(unittest.TestCase):
    def test_monorepo_prefix_is_removed_before_classification(self):
        direct = CHANGES.classify_paths(b"probe/src/lib.rs\0")
        nested = CHANGES.classify_paths(b"apps/desktop/probe/src/lib.rs\0")
        self.assertEqual(nested, direct)
        self.assertTrue(nested["probe"])
        self.assertFalse(nested["linux_package"])

    def test_reviewed_documentation_only(self):
        self.assertEqual(selected("README.md", "docs/workspace-layout.md", "linux/README.md"), set())
        self.assertEqual(selected("docs/images/new screenshot\nnight.png"), set())

    def test_explicit_reviewed_prose_paths_are_inert_without_exempting_new_documents(self):
        for path in ("docs/agent-details.md", "docs/pi-existing-session-injection.md",
                     "docs/contractor-access.md", "probe/README.md",
                     "integrations/capy/README.md", "integrations/replicas/README.md",
                     "probe/resources/windows/icons/README.md",
                     "probe/resources/windows/icons/dev/README.md", "assets/dmg-background.prompt.txt"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set())
        self.assertEqual(selected("docs/relay-core.md"), set(CHANGES.JOBS))
        for path in ("docs/new-guide.md", "probe/resources/windows/icons/new-README.md",
                     "integrations/new-connector/README.md", "assets/new.prompt.txt"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set(CHANGES.JOBS))

    def test_mobile_only(self):
        self.assertEqual(selected("ipad/native/Sources/RelayClient.swift"), set())

    def test_swift_and_shared_package(self):
        for path in ("macos/Sources/RelayDesktop/AgentsView.swift",
                     "macos/Tests/RelayDesktopTests/NavigationTests.swift",
                     "macos/Sources/RelayDesktopCore/CoreBridge.swift",
                     "shared/RelaySessionOverview/Sources/RelaySessionOverview/SessionOverview.swift",
                     "shared/RelaySessionOverview/Tests/RelaySessionOverviewTests/SessionOverviewTests.swift"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), {"macos"})

    def test_swift_build_inputs_also_select_macos_packaging(self):
        for path in ("macos/Package.swift", "macos/Package.resolved", "macos/Info.plist.template",
                     "macos/RelayDesktop.entitlements", "macos/Sources/RelayDesktop/Resources/capy.svg",
                     "shared/RelaySessionOverview/Package.swift", "shared/RelaySessionOverview/Package.resolved"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), {"macos", "macos_package"})

    def test_future_swift_package_paths_are_not_automatically_exempted(self):
        for path in ("macos/new-build.swift", "macos/Sources/NewTarget/main.swift",
                     "macos/Sources/RelayDesktop/toolchain.toml", "macos/Tests/NewTarget/main.swift",
                     "shared/RelaySessionOverview/new-build.swift",
                     "shared/RelaySessionOverview/Resources/new.json"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set(CHANGES.JOBS))

    def test_generated_swift_also_checks_rust_generator(self):
        self.assertEqual(selected(CHANGES.GENERATED_CONTRACT), {"probe", "macos"})

    def test_macos_core_only_runs_when_rust_or_other_shared_inputs_change(self):
        # A generated Swift edit must pass regeneration but cannot change
        # Rust/npm behavior. A matching Rust registry edit restores core tests.
        self.assertEqual(selected(CHANGES.GENERATED_CONTRACT, "README.md"), {"probe", "macos"})
        for source in ("macos/Sources/RelayDesktop/AgentsView.swift", CHANGES.GENERATED_CONTRACT,
                       "shared/RelaySessionOverview/Sources/RelaySessionOverview/SessionOverview.swift"):
            for shared_input in ("probe/src/relay/contract/mod.rs", "probe/Cargo.lock",
                                 ".github/workflows/desktop-ci.yml", "rust-toolchain.toml",
                                 "scripts/test-pi-live.sh", "config/posthog.json"):
                with self.subTest(source=source, shared_input=shared_input):
                    expected = set(CHANGES.JOBS)
                    if shared_input == "probe/src/relay/contract/mod.rs":
                        expected = NATIVE_GROUPS
                    elif shared_input == "scripts/test-pi-live.sh":
                        expected = {"shell", "probe", "macos", "macos_core"}
                    self.assertEqual(selected(source, shared_input), expected)
        # Adding an independent packaging change should not re-enable the
        # macOS Rust/npm lane simply because two components changed.
        self.assertEqual(selected("macos/Package.swift", "linux/install.sh"),
                         {"shell", "macos", "macos_package", "linux", "linux_core",
                          "linux_integration", "linux_package"})

    def test_core_and_shared_inputs_select_all_component_groups(self):
        for path in ("probe/Cargo.toml", "probe/Cargo.lock", "probe/build.rs",
                     "probe/build_version.rs", "config/posthog.json",
                     "shared/session-filter-actions.json", "assets/agent-relay-mark.svg",
                     "docs/relay-core.md"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set(CHANGES.JOBS))

    def test_shared_gtk_bridge_host_models_keep_broad_native_coverage(self):
        for path in ("probe/src/linux_app/models.rs", "probe/src/linux_app/bridge.rs",
                     "probe/src/linux_app/host.rs", "probe/src/linux_app.rs"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), NATIVE_GROUPS)

    def test_cfg_gated_gtk_ui_implementation_selects_gtk_and_real_core_lanes_only(self):
        for path in ("probe/src/linux_app/ui/mod.rs", "probe/src/linux_app/ui/shell.rs",
                     "probe/src/linux_app/ui/widgets/assets.rs"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), GTK_UI_GROUPS)
        self.assertEqual(selected("probe/src/linux_app/ui/shell.rs",
                                  "macos/Sources/RelayDesktop/AgentsView.swift"), GTK_UI_GROUPS | {"macos"})
        self.assertEqual(selected("probe/src/linux_app/ui/shell.rs", "probe/src/relay.rs"), NATIVE_GROUPS)
        self.assertEqual(selected("probe/src/linux_app/ui/shell.rs", "macos/Info.plist.template"),
                         GTK_UI_GROUPS | {"macos", "macos_package"})
        for path in ("probe/src/linux_app/ui_config.rs", "probe/src/linux_app/ui.rs"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), NATIVE_GROUPS)
        self.assertEqual(selected("probe/src/linux_app/ui/new-config.toml"), set(CHANGES.JOBS))

    def test_gtk_harness_and_rust_modules_select_only_gtk_platforms(self):
        for path in ("probe/tests/linux_app_gtk.rs", "probe/tests/linux_app_gtk/pages.rs",
                     "probe/tests/linux_app_gtk/take_over.rs"):
            with self.subTest(path=path):
                self.assertEqual(selected(path, "CHANGELOG.md"), {"linux", "windows"})

    def test_gtk_harness_mixed_with_core_and_unknown_inputs_restores_coverage(self):
        gtk = "probe/tests/linux_app_gtk/pages.rs"
        self.assertEqual(selected(gtk, "probe/src/relay.rs"),
                         NATIVE_GROUPS)
        self.assertEqual(selected(gtk, "probe/Cargo.lock"), set(CHANGES.JOBS))
        self.assertEqual(selected(gtk, "probe/tests/linux_app_gtk/new-helper.toml"), set(CHANGES.JOBS))
        # Unreviewed test helpers outside the audited harness retain the broad
        # native-source rule; the GTK prefix must not swallow sibling paths.
        for helper in ("probe/tests/new-helper.rs", "probe/tests/linux_app_gtk_extra.rs"):
            with self.subTest(helper=helper):
                self.assertEqual(selected(helper), NATIVE_GROUPS)

    def test_pi_live_inputs_select_probe_and_macos_core_without_macos_app(self):
        self.assertEqual(selected("probe/tests/pi_live_session.rs"), {"probe", "macos_core"})
        self.assertEqual(selected("scripts/test-pi-live.sh"), {"shell", "probe", "macos_core"})
        self.assertEqual(selected("probe/tests/pi_live_session.rs", "scripts/test-pi-live.sh",
                                  "CHANGELOG.md"), {"shell", "probe", "macos_core"})

    def test_pi_live_mixed_with_broad_inputs_restores_all_groups(self):
        for broad in ("probe/Cargo.toml", "scripts/new-helper.sh", "new-config.toml"):
            with self.subTest(broad=broad):
                self.assertEqual(selected("scripts/test-pi-live.sh", broad), set(CHANGES.JOBS))
        self.assertEqual(selected("probe/tests/pi_live_session_helper.rs"),
                         NATIVE_GROUPS)

    def test_platform_packaging(self):
        self.assertEqual(selected("linux/install.sh"),
                         {"shell", "linux", "linux_core", "linux_integration", "linux_package"})
        self.assertEqual(selected("windows/installer/AgentRelay.iss"),
                         {"shell", "windows", "windows_package"})

    def test_ordinary_rust_sources_keep_all_native_groups_without_packaging(self):
        for path in ("probe/src/lib.rs", "probe/src/probe/main.rs", "probe/src/bin/agent-relay-desktop.rs",
                     "probe/src/platform/windows.rs", "probe/src/linux_app/install/windows.rs",
                     "probe/src/relay/contract/mod.rs", "probe/tests/relay_core_binary.rs",
                     "probe/tests/linux_app_hosting.rs"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), NATIVE_GROUPS)

    def test_windows_build_resources_and_unknown_source_inputs_keep_packaging(self):
        for path in ("probe/build.rs", "probe/build_version.rs", "probe/Cargo.toml",
                     "probe/Cargo.lock", "probe/resources/linux/agent-relay-mark.svg",
                     "probe/resources/windows/agent-relay.ico", "assets/agent-relay-mark.svg",
                     "scripts/build-windows.sh", "scripts/check-probe-bridge.sh",
                     "probe/src/new-config.toml", "probe/tests/new-runner.toml",
                     "new-build.rs", "probe/new-build.rs", "probe/examples/new-runner.rs",
                     "probe/src-other/main.rs", "probe/tests-other/case.rs"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set(CHANGES.JOBS))

    def test_windows_packaging_input_restores_packaging_in_mixed_change(self):
        source = "probe/src/relay.rs"
        self.assertNotIn("windows_package", selected(source, "README.md"))
        self.assertEqual(selected(source, "windows/installer/AgentRelay.iss"), NATIVE_GROUPS | {"windows_package"})
        self.assertEqual(selected(source, "probe/Cargo.lock"), set(CHANGES.JOBS))
        self.assertEqual(selected(source, "unknown-config.json"), set(CHANGES.JOBS))

    def test_changelog_only_and_other_inert_paths_select_no_component_groups(self):
        self.assertEqual(selected("CHANGELOG.md"), set())
        self.assertEqual(selected("CHANGELOG.md", "README.md", "ipad/native/Sources/RelayClient.swift"),
                         set())

    def test_required_release_note_does_not_change_source_component_selection(self):
        for source in ("probe/src/relay.rs", "probe/src/linux_app/ui/shell.rs",
                       "probe/tests/linux_app_gtk.rs", "macos/Sources/RelayDesktop/AgentsView.swift",
                       CHANGES.GENERATED_CONTRACT, "shared/RelaySessionOverview/Package.swift",
                       "linux/install.sh", "windows/installer/AgentRelay.iss"):
            with self.subTest(source=source):
                self.assertEqual(selected(source, "CHANGELOG.md"), selected(source))

    def test_changelog_mixed_with_packaging_inputs_restores_windows_packaging(self):
        for path in ("probe/Cargo.toml", "probe/Cargo.lock", "probe/build.rs",
                     "probe/resources/linux/agent-relay-mark.svg", "scripts/build-windows.sh",
                     "windows/installer/AgentRelay.iss", "unknown-build-input"):
            with self.subTest(path=path):
                expected = set(CHANGES.JOBS)
                if path == "windows/installer/AgentRelay.iss":
                    expected = NATIVE_GROUPS | {"windows_package"}
                self.assertEqual(selected("CHANGELOG.md", "probe/src/relay.rs", path),
                                 expected)

    def test_package_and_integration_flags_have_required_native_prerequisites(self):
        paths = ("README.md", "macos/Package.swift", "linux/install.sh",
                 "windows/installer/AgentRelay.iss", "probe/src/lib.rs", "probe/Cargo.toml",
                 "probe/build.rs", "probe/resources/linux/agent-relay-mark.svg", "CHANGELOG.md",
                 "probe/src/linux_app/ui/shell.rs", "probe/tests/linux_app_gtk.rs", "unknown")
        for left in paths:
            for right in paths:
                with self.subTest(left=left, right=right):
                    jobs = selected(left, right)
                    self.assertTrue("windows_package" not in jobs or "windows" in jobs)
                    self.assertTrue("macos_package" not in jobs or "macos" in jobs)
                    self.assertTrue("linux_package" not in jobs or "linux_core" in jobs)
                    self.assertTrue("linux_integration" not in jobs or "linux_core" in jobs)

    def test_scripts_and_ci_configuration_keep_lint_and_all_builds(self):
        for path in ("scripts/build-probe.sh", "scripts/build-app.sh", "scripts/build-windows.sh",
                     "scripts/ci-changes.py", "scripts/test_ci_changes.py",
                     ".github/workflows/desktop-ci.yml", ".github/workflows/desktop-release.yml",
                     ".github/actions/setup/action.yml", ".gitattributes", ".gitignore"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set(CHANGES.JOBS))

    def test_unknown_files_and_new_documents_default_to_full(self):
        for path in ("new-build-config.toml", "new-source/file.rs", "docs/new-build-input.md",
                     "README.md.extra", "macos-other/test.swift", "shared/new-fixtures.json",
                     "rust-toolchain.toml", ".cargo/config.toml", "package-lock.json",
                     "CHANGELOG.md.extra", "docs/CHANGELOG.md"):
            with self.subTest(path=path):
                self.assertEqual(selected(path), set(CHANGES.JOBS))

    def test_paths_are_not_split_on_spaces_or_newlines(self):
        self.assertEqual(selected("macos/Sources/RelayDesktop/new file\nwith newline.swift"), {"macos"})
        self.assertEqual(selected("README.md\nprobe/src/lib.rs"), set(CHANGES.JOBS))
        self.assertEqual(selected("README.md", "windows/new file.txt", "macos/Sources/RelayDesktop/new.swift"),
                         {"shell", "windows", "windows_package", "macos"})

    def test_empty_or_malformed_path_list_defaults_to_full(self):
        for data in (b"", b"README.md", b"README.md\0\0", b"\0", b"../README.md\0",
                     b"/README.md\0", b"macos/../README.md\0", b"\xff\0"):
            with self.subTest(data=data):
                self.assertEqual(CHANGES.classify_paths(data), CHANGES.all_jobs())


class CommandTests(unittest.TestCase):
    def run_script(self, *args, cwd=None, data=b""):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd,
                              input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    def outputs(self, result):
        return dict(line.split("=", 1) for line in result.stdout.decode().splitlines())

    def test_stdout_and_github_output_are_boolean_and_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            result = self.run_script("--github-output", str(output), data=b"macos/Sources/RelayDesktop/new file.swift\0")
            self.assertEqual(output.read_bytes(), result.stdout)
            self.assertEqual(self.outputs(result), {
                "shell": "false", "probe": "false", "macos": "true",
                "macos_core": "false", "macos_package": "false", "linux": "false",
                "linux_core": "false", "linux_integration": "false", "linux_package": "false", "windows": "false",
                "windows_package": "false",
            })

    def test_explicit_fallback(self):
        self.assertEqual(self.outputs(self.run_script("--all")),
                         dict.fromkeys(CHANGES.JOBS, "true"))

    def test_changelog_cli_skips_routine_jobs_but_force_all_retains_release_validation(self):
        data = b"CHANGELOG.md\0"
        self.assertEqual(self.outputs(self.run_script(data=data)),
                         dict.fromkeys(CHANGES.JOBS, "false"))
        self.assertEqual(self.outputs(self.run_script("--all", data=data)),
                         dict.fromkeys(CHANGES.JOBS, "true"))

    def test_missing_or_unavailable_revisions_fall_back_without_blocking_ci(self):
        with tempfile.TemporaryDirectory() as directory:
            for args in (("--base", "missing", "--head", "missing"),
                         ("--base", ""), ("--head", "HEAD"),
                         ("--base=--help", "--head", "HEAD")):
                with self.subTest(args=args):
                    result = self.run_script(*args, cwd=directory)
                    self.assertEqual(self.outputs(result), dict.fromkeys(CHANGES.JOBS, "true"))
                    self.assertIn(b"running all CI jobs", result.stderr)

    def test_validated_same_tree_commit_skips_lanes_but_unknown_or_empty_input_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()

            git("init", "-q")
            git("config", "user.email", "ci@example.test")
            git("config", "user.name", "CI test")
            (root / "build.rs").write_text("build input\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            git("commit", "--allow-empty", "-qm", "same tree, new revision")
            self.assertNotEqual(base, git("rev-parse", "HEAD"))
            result = self.run_script("--base", base, "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result), dict.fromkeys(CHANGES.JOBS, "false"))
            self.assertEqual(result.stderr, b"")
            self.assertEqual(self.outputs(self.run_script(cwd=root)),
                             dict.fromkeys(CHANGES.JOBS, "true"))
            self.assertEqual(self.outputs(self.run_script("--base", "missing", "--head", "HEAD", cwd=root)),
                             dict.fromkeys(CHANGES.JOBS, "true"))
            self.assertEqual(self.outputs(self.run_script("--all", "--base", base, "--head", "HEAD", cwd=root)),
                             dict.fromkeys(CHANGES.JOBS, "true"))

    def test_git_diff_includes_both_rename_sides_and_deleted_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()

            git("init", "-q")
            git("config", "user.email", "ci@example.test")
            git("config", "user.name", "CI test")
            (root / "macos/Sources/RelayDesktop").mkdir(parents=True)
            (root / "macos/Sources/RelayDesktop/source with\nnewline.swift").write_text("source\n")
            (root / "README.md").write_text("documentation\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            # A source renamed into an excluded documentation path must still
            # test the platform that lost it. Force rename detection on in git
            # config to prove --no-renames protects the transport.
            git("config", "diff.renames", "true")
            git("mv", "macos/Sources/RelayDesktop/source with\nnewline.swift", "AGENTS.md")
            git("commit", "-qm", "rename source into docs")
            result = self.run_script("--base", base, "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result)["macos"], "true")
            self.assertEqual(self.outputs(result)["macos_core"], "false")
            self.assertEqual(self.outputs(result)["macos_package"], "false")
            self.assertEqual(self.outputs(result)["linux"], "false")
            # And in the other direction, the new path needs its platform.
            base = git("rev-parse", "HEAD")
            (root / "windows").mkdir()
            git("mv", "README.md", "windows/new name.txt")
            git("commit", "-qm", "rename docs into packaging")
            result = self.run_script("--base", base, "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result)["windows"], "true")
            self.assertEqual(self.outputs(result)["windows_package"], "true")
            base = git("rev-parse", "HEAD")
            git("rm", "windows/new name.txt")
            git("commit", "-qm", "delete packaging")
            result = self.run_script("--base", base, "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result)["windows"], "true")
            self.assertEqual(self.outputs(result)["windows_package"], "true")
            # Moving a resource into Swift source still needs packaging: the
            # removed resource path must survive git's rename detection.
            base = git("rev-parse", "HEAD")
            resource = "macos/Sources/RelayDesktop/Resources/capy.svg"
            (root / "macos/Sources/RelayDesktop/Resources").mkdir()
            git("mv", "AGENTS.md", resource)
            git("commit", "-qm", "move prose into a package resource")
            result = self.run_script("--base", base, "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result)["macos_package"], "true")
            self.assertEqual(self.outputs(result)["linux_core"], "false")
            base = git("rev-parse", "HEAD")
            git("mv", resource, "macos/Sources/RelayDesktop/Restored.swift")
            git("commit", "-qm", "move package resource into source")
            result = self.run_script("--base", base, "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result)["macos"], "true")
            self.assertEqual(self.outputs(result)["macos_package"], "true")
            # Git has validated an unchanged tree, so no component changed.
            result = self.run_script("--base", "HEAD", "--head", "HEAD", cwd=root)
            self.assertEqual(self.outputs(result), dict.fromkeys(CHANGES.JOBS, "false"))


if __name__ == "__main__":
    unittest.main()
