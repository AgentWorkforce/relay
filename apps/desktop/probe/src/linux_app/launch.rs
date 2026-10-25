//! What a launch tells the instance already running. The app runs once per
//! account: a second launch hands its command line to the first and exits
//! (`ui::run`). A launch adds its own version and executable, so a later
//! version started by hand (the Start menu, a link) while an older one sits
//! in the tray takes over from it, instead of being handed to it.

use crate::linux_app::updates::is_newer;
use std::path::{Path, PathBuf};

const LAUNCHED_VERSION: &str = "--launched-version=";
const LAUNCHED_EXE: &str = "--launched-exe=";

/// The arguments a launch of `version`, at `exe`, adds to its command line.
pub fn launch_arguments(version: &str, exe: &Path) -> Vec<String> {
    vec![
        format!("{LAUNCHED_VERSION}{version}"),
        format!("{LAUNCHED_EXE}{}", exe.display()),
    ]
}

/// The executable of a later version than the one running
/// (`running_version`), when `arguments` are a launch of one; the running
/// instance relaunches into it. The version alone decides: a package
/// upgrade replaces the executable at its own path while the old app runs
/// on, unlinked, so the path is neither compared nor looked up. A launch of
/// this same version, of an older one, or without the arguments (an
/// updater's, a test's) is handled as before.
pub fn newer_launch(arguments: &[String], running_version: &str) -> Option<PathBuf> {
    let value = |prefix: &str| {
        arguments
            .iter()
            .find_map(|argument| argument.strip_prefix(prefix))
    };
    let version = value(LAUNCHED_VERSION)?;
    let exe = PathBuf::from(value(LAUNCHED_EXE)?);
    is_newer(version, running_version).then_some(exe)
}

/// `arguments` without the launch's own version and executable.
pub fn without_launch_arguments(arguments: &[String]) -> Vec<String> {
    arguments
        .iter()
        .filter(|argument| {
            !argument.starts_with(LAUNCHED_VERSION) && !argument.starts_with(LAUNCHED_EXE)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_of_a_later_version_is_taken_over() {
        // A per-user install: the new version beside the old one.
        let newer = Path::new("/home/a/.local/lib/agent-relay/2026.10.10/bin/agent-relay-desktop");
        let mut launch = vec!["--background".to_owned()];
        launch.extend(launch_arguments("2026.10.10", newer));
        assert_eq!(newer_launch(&launch, "2026.10.9").as_deref(), Some(newer));
        assert_eq!(without_launch_arguments(&launch), ["--background"]);
        // A package upgrade: the new version at the old one's own path,
        // which the running app, unlinked, may no longer resolve.
        let replaced = Path::new("/usr/bin/agent-relay-desktop");
        let upgrade = launch_arguments("2026.10.10", replaced);
        assert_eq!(
            newer_launch(&upgrade, "2026.10.9").as_deref(),
            Some(replaced)
        );
    }

    #[test]
    fn other_launches_are_handed_over_as_before() {
        let newer = Path::new("/usr/bin/agent-relay-desktop");
        // The same version again, from wherever: a second window.
        let same = launch_arguments("2026.10.9", newer);
        assert_eq!(newer_launch(&same, "2026.10.9"), None);
        // An older version, a development build, and a launch without the
        // arguments.
        let older = launch_arguments("2026.10.8", newer);
        assert_eq!(newer_launch(&older, "2026.10.9"), None);
        let dev = launch_arguments("0.0.0-dev", newer);
        assert_eq!(newer_launch(&dev, "2026.10.9"), None);
        let plain = ["--background".to_owned()];
        assert_eq!(newer_launch(&plain, "2026.10.9"), None);
        assert_eq!(without_launch_arguments(&plain), plain);
    }
}
