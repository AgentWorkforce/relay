# GitHub Actions runners

Linux CI and release builds use Blacksmith through repository Actions variables.
Read-only jobs use
`CI_LINUX_*`; release publishing and changelog promotion use
`DEPLOY_LINUX_RUNNER`. macOS (including TestFlight) and Windows retain their
GitHub-hosted runners.

| Repository variable | Blacksmith value | Fallback when unset |
| --- | --- | --- |
| `CI_LINUX_RUNNER` | `blacksmith-4vcpu-ubuntu-2404` | `ubuntu-latest` |
| `CI_LINUX_ARM64_RUNNER` | `blacksmith-4vcpu-ubuntu-2404-arm` | `ubuntu-24.04-arm` |
| `CI_LINUX_2204_RUNNER` | `blacksmith-4vcpu-ubuntu-2204` | `ubuntu-22.04` |
| `CI_LINUX_2204_ARM64_RUNNER` | `blacksmith-4vcpu-ubuntu-2204-arm` | `ubuntu-22.04-arm` |
| `DEPLOY_LINUX_RUNNER` | `blacksmith-4vcpu-ubuntu-2404` | `ubuntu-latest` |

Keep GTK app builds on Ubuntu 22.04: its GTK 4.6 is the supported minimum.
Each architecture builds and tests natively. Standalone probe CI uses Ubuntu
24.04 with Zig targeting glibc 2.34. Do not point an ARM variable at an x64
runner or use the general Ubuntu 24.04 variable for GTK builds.

The [Blacksmith GitHub App](https://docs.blacksmith.sh/introduction/quickstart)
must have access to this repository. Configure the variables under repository
Settings → Secrets and variables → Actions → Variables, or with `gh variable
set NAME --body VALUE`. Values use the
[published Blacksmith runner labels](https://docs.blacksmith.sh/blacksmith-runners/overview).
Delete a variable to send its jobs back to the GitHub-hosted fallback on the
next run. These fallbacks apply when a variable is empty, not when a configured
runner is unavailable.

Existing Rust cache actions work on Blacksmith without replacement.

## Parallel CI lanes and required checks

For both same-repository pull requests and pushes to `main`, CI first selects
changed components, then checks representative native architectures: macOS
arm64, Linux x64 and Windows x64. macOS packaging, Swift tests and core
integration tests run independently. Linux independently selects GTK/library
and real-core integration/startup steps within its native test job, alongside
the Zig core build and packaging. Windows also
runs native tests independently of packaging. Swift source/test changes select
Swift checks without Rust/npm core or release packaging work. Ordinary Rust
source/test changes retain native tests and core integration while deferring
release packaging on all platforms. Reviewed build inputs select the relevant
package lanes; unknown inputs conservatively select everything. Fork pull
requests retain the workflow's existing skip policy.

The existing `macOS arm64`, `macOS x64`, `Linux arm64`, `Linux x64`,
`Windows arm64` and `Windows x64` check names are retained as compatibility
completion gates over the selected architecture matrix. Their names preserve
existing branch protection; they do not imply that a deferred architecture
was tested in that run. Job summaries list the actual architectures covered.
Each gate requires successful change detection and successful completion of
every applicable platform lane. A failed, cancelled or unexpectedly skipped
applicable lane fails the gate. An intentionally excluded component passes its
lightweight gate after successful detection and validation of the skipped
native dependencies. Gate runners remain active to preserve the expanded
architecture check names used by branch protection; missing/invalid flags,
failed detection and unexpected dependency results fail validation.
`Shell scripts` and `Probe` retain their names.
Both `Linux probe glibc 2.34 (arm64)` and `Linux probe glibc 2.34 (x64)` are
also preserved as inexpensive compatibility gates over the selected Linux
core builds in both representative and full-matrix modes. The actual producer
jobs are named `Linux core (arch)`. Their
gate summaries identify which architectures were checked and which are
deferred; producer failure or an unexpected skip fails both gates.

Changelog/prose-only diffs skip all tests and builds; only change detection and
lightweight compatibility status jobs run. CI uses [job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)
to skip build/test jobs rather than the entire workflow, while retaining the
compatibility runners so expanded required-check names still report.

Release automatically runs reusable CI tests for every platform and both arm64
and x64 before release packaging begins. This prerequisite runs the complete
test matrix regardless of changed-path selection; the release's own build jobs
then package both architectures. It omits duplicate unsigned CI packages. There
is no nightly workflow. The tradeoff is deliberate: macOS x64, Linux arm64 and
Windows arm64 regressions can pass routine PR/main checks and be caught by the
required prerelease tests. The existing completion gate names remain usable by
branch protection under this representative-architecture policy. Release-only
linking, app bundle/runtime collection and installer issues introduced by
ordinary source edits may likewise be caught during release packaging. Every
release still packages both architectures after its full test prerequisite
succeeds.

Each `Linux core (arch)` job uses Zig to build the core once, validates
the glibc floor and uploads that binary. The matching Linux package job and
selected integration steps download the same core artifact, so packaging and real-core
tests exercise the validated binary without compiling it again. A GTK-only
test change skips the core download, real app build, real-core tests and startup
smoke test. The artifact
carries a checksum and source, target and version metadata. Prerelease CI
builds it with the release's resolved version; the Linux release package job
reuses that validated artifact too. Core artifacts are retained for seven
days. `probe-version` also flows to the Linux unsigned CI packages so the
package version matches its downloaded core.

Reusable CI accepts `full-matrix` (both architectures), `force-all` (every
component), `skip-packages` (omit unsigned CI packaging) and `probe-version`
(the version embedded in the core, default `0.0.0`). Release supplies all four
to request full tests without duplicate packages. A manual CI run can request
the full matrix with unsigned packaging enabled when diagnosing an
architecture-specific issue.

Swift build caches separate architecture and package/test lane, and include
Swift, Xcode, SDK and manifest identities. Windows caches separate downloaded
Cargo sources from compiled dependencies; compiled cache keys include
architecture, toolchain, dependency manifests and debug/release profile, stay
stable across ordinary source commits, and exclude Cargo incremental state.
Dependency-focused caching avoids storing a new copy of large app/test binaries
for each source revision: workspace products are pruned before the first save,
and the key includes profile settings rather than the source SHA. Windows tests
disable dev/test debug symbols to limit linker work and cache size while
retaining debug assertions and overflow checks. Release builds use the same
Windows cache setup with their own release profile; test settings do not
change release builds.

Windows platform, wording/state, GTK and hosting tests use targeted
`cargo test --no-default-features --features gtk` commands with `--lib` or
`--test`. The default `production-binaries` feature gates the app, core and
contract-codegen executables, so these tests avoid Cargo's automatic linking
of unrelated production binaries. The fake core remains available for the
integration harness. When packaging is skipped, a separate
`cargo check --features gtk --bins` keeps all Windows app/core/codegen entry
points checked with default features enabled without linking their executables.
Linux's GTK/library-only mode also opts out of default production binaries.
When Linux integration is selected, it shares one default-feature debug build
with GTK checks in the same native test job. Ordinary production builds,
real-core integration and release packaging retain default features.
`scripts/test_cargo_target_selection.py` guards that target selection.

macOS and Linux Rust caches also separate package and test lanes. Linux's
GTK/library and real-core steps share the `tests` cache and setup, avoiding
duplicate GTK builds when both are selected. Parallel package/test jobs save
their own dependency builds. A new lane can seed itself from the
previous shared cache, using the complete historical key with read-only saves.
A marker restored with the lane cache prevents an older shared seed from
replacing a newer lane cache, including a partial lockfile match. Package
lanes prune restored debug profiles; macOS core tests and Linux native tests
prune release profiles. Cache markers live under the runner temporary directory,
outside the repository.
New Windows and Swift scopes start cold; restores are an optimization and
every selected lane still executes its builds and checks.

## CI change selection

`scripts/ci-changes.py` independently selects shell checks, Probe tests, Swift
tests (`macos`), macOS Rust/npm tests (`macos_core`), macOS packages
(`macos_package`), Linux GTK/library tests (`linux`), the Zig core build
(`linux_core`), real-core integration/startup (`linux_integration`), Linux
packages (`linux_package`), Windows native tests (`windows`) and Windows
packages (`windows_package`). It uses only Python's standard library and emits
boolean `key=value` lines suitable for `$GITHUB_OUTPUT`:

```sh
python3 scripts/ci-changes.py --base "$BASE" --head "$HEAD" >> "$GITHUB_OUTPUT"
python3 scripts/test_ci_changes.py
```

The comparison uses `git diff --name-only --no-renames -z`: deleted paths and
both sides of a rename participate, and spaces or newlines in a filename stay
intact. Callers using stdin must supply that same NUL-delimited format. A
successful `--base`/`--head` Git comparison with no changed paths selects no
lanes, including distinct commits with identical trees. Empty/malformed stdin
or unavailable history selects every job, since an empty upstream transport
cannot prove that nothing changed. `--all` always selects every group. No
changed-path service or third-party filter action is required.

Pull request selection compares the event base with the tested merge commit,
covering the whole PR diff rather than only the latest commit. A doc-only
follow-up on a PR that also changes code still selects the lanes required by
that code.

| Changed input | Selected job groups |
| --- | --- |
| `CHANGELOG.md`, reviewed documentation allowlist, documentation PNG screenshots, or `ipad/` only | None |
| Swift source/tests in known macOS or shared package target directories | Swift checks only |
| Exact Swift package manifests, macOS plist/entitlements, or macOS app resources | Swift checks and macOS packaging |
| Generated `macos/Sources/RelayDesktopCore/CoreContract.swift` | Probe regeneration validation and Swift checks |
| Linux packaging under `linux/` | Shell, Linux GTK/library tests, core, integration and packaging |
| Windows packaging under `windows/` | Shell, Windows native tests and Windows packaging |
| `probe/tests/linux_app_gtk.rs` or Rust modules under `probe/tests/linux_app_gtk/` | Linux GTK/library and Windows native tests; no core build or integration |
| Rust modules under `probe/src/linux_app/ui/` | Linux GTK/library tests, core, integration and Windows native tests |
| `probe/tests/pi_live_session.rs` | Probe and macOS core tests |
| `scripts/test-pi-live.sh` | Shell, Probe and macOS core tests |
| Other Rust modules under `probe/src/` or Rust tests under `probe/tests/` | All native test/core groups, without packaging |
| Cargo/build inputs, resources, scripts, CI configuration, shared fixtures, assets, global configuration, or unknown paths | All |

The reviewed prose allowlist lives in the script as explicit paths; `.md`
alone never exempts a file. It includes the reviewed top-level `docs/*.md`
files, probe and integration READMEs, Windows icon READMEs and the DMG artwork
prompt. New documents remain unknown until reviewed. `docs/relay-core.md` is
excluded from that allowlist because contract tests read it, and keeps every
component selected. Routine `CHANGELOG.md` edits add no tests or builds; in a
mixed change, the remaining paths determine all selected lanes. `probe/build.rs`
still reads the release heading and derives development version metadata from it, so
changelog-only edits defer validation of that input until the next selected
build or release. Release forces every component and packages the actual
resolved version, even when only the changelog changed. Shared GTK bridge,
host and model source retains all native test/core groups because those
modules also build without GTK on macOS. Changes to this selector
or its tests run the shell job and every build group. Extend the allowlist only
after checking consumers and adding a regression test.

The audited GTK harness and its Rust modules select Linux GTK/library and
Windows native tests without the Zig core or real-core integration steps. Rust
UI modules under `probe/src/linux_app/ui/` are guarded by the GTK feature and
also select the Linux core and integration lanes, without scheduling Probe or
macOS jobs. Shared bridge/host/models remain broader native inputs.
The audited Pi live-session test and runner script select Probe and macOS core
tests, with shell checks added for the script. These exceptions apply before
the broader source/script defaults. Other test helpers retain their existing
coverage, and combining an exception with core, build or unknown inputs takes
the union rather than suppressing those inputs.

`macos`, `macos_core` and `macos_package` control Swift tests, Rust/npm tests
and release packaging independently. Swift tests compile the macOS app entry
point through the package's test-target dependency. The Swift lane also runs
`swift test --package-path shared/RelaySessionOverview` so the shared package's
own test target executes, rather than only building its library as a dependency.
Known source/test targets select Swift checks alone; exact package manifests,
plist/entitlements and the app's existing resource scope also select packaging.
Unreviewed future package targets/build paths default to all groups.
The macOS completion gate accepts Pi-only changes with app lanes skipped and
core tests required. The generated
Swift contract is an output of the Rust generator rather than a Rust/npm input,
so changing only that file runs Probe's consistency check and Swift validation. A matching Rust
registry change selects native core tests, including macOS core tests. Unknown paths,
shared core/dependency/toolchain inputs and every fallback also select
`macos_core`, so a mixed Swift/core change cannot hide core regressions.

`linux` selects GTK/library steps without requiring a core artifact;
`linux_core` controls the Zig build; `linux_integration` requires that build and
selects the real-core and app-startup steps in the same native test job.
`linux_package` also requires the core artifact. The completion gate validates
the selected work independently. `windows` and `windows_package` separately
control native tests and the release build, portable zip and installer smoke
checks. Ordinary Rust source changes skip all three package flags, while Cargo
build files, resource/build inputs and unknown paths retain packaging coverage.
Mixed changes take the union of their selections. The minimal prerequisites
are `macos_package` → `macos`, `linux_integration`/`linux_package` → `linux_core`,
and `windows_package` → `windows`. Reviewed docs and validated unchanged Git
trees select no lanes; unavailable history, empty/malformed stdin and explicit
`--all` select every group.
Release forces every component, skips duplicate unsigned CI packages during
prerelease tests, and then builds the actual release packages as before.
