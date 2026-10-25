//! The command line of this instance or of a launch after it, and moving
//! to another version's app: a later version launched while this one runs
//! (`linux_app::launch`), or the one an update installed.

use super::app::App;
use crate::linux_app::{launch, updates};
use gtk4::glib;
use std::io;
use std::path::Path;

impl App {
    /// The command line of this instance or one started after it:
    /// `--background` starts in the tray, and `agentrelay://` links open.
    /// A later version started while this one runs in the tray (from the
    /// Start menu or a link after an update that did not restart, a newer
    /// version unpacked beside this one, or a package upgrade over it)
    /// takes over: this instance relaunches into it with the launch's own
    /// arguments.
    pub fn command_line(&self, arguments: &[String]) {
        let newer =
            launch::newer_launch(arguments, crate::VERSION).filter(|launcher| launcher.is_file());
        if let Some(launcher) = newer {
            let own = launch::without_launch_arguments(arguments);
            if let Err(error) = self.relaunch_into(&launcher, &own) {
                eprintln!(
                    "Agent Relay could not start {}: {error}.",
                    launcher.display()
                );
            } else {
                return;
            }
        }
        let background = arguments.iter().any(|argument| argument == "--background");
        self.update_state(|state| state.background_requested = background);
        self.activate();
        for argument in arguments {
            if argument.starts_with("agentrelay://") || argument.starts_with("agentrelay-dev://") {
                let open = self.on({
                    let url = argument.clone();
                    move |app| app.open_link(&url)
                });
                glib::idle_add_local_once(open);
            }
        }
    }

    /// Starts `launcher`, another version's app, with `arguments`, and
    /// quits. The new version hosts its own core, so a core this app
    /// hosts stops first. Returns only when the launcher could not start,
    /// with the bridge back up, so this version stays usable.
    pub(super) fn relaunch_into(&self, launcher: &Path, arguments: &[String]) -> io::Result<()> {
        let bridge = self.bridge().clone();
        self.inner
            .runtime
            .block_on(async move { bridge.release_hosted().await });
        // Linux replaces this process; Windows starts the new version,
        // which waits for this one to quit.
        match updates::relaunch(launcher, arguments) {
            Ok(()) => {
                self.inner.desktop.quit();
                Ok(())
            }
            Err(error) => {
                self.bridge().restart();
                Err(error)
            }
        }
    }
}
