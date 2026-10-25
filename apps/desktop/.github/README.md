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
