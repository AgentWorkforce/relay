//! Software update actions shared by the About pane and background checks.
use super::app::App;
use super::desktop::Confirmation;
use super::state::UpdateState;
use super::widgets;
use crate::linux_app::install::{self, InstallKind};
use crate::linux_app::updates::{self, Release};
use crate::relay::contract::method;
use crate::relay::telemetry::{TelemetryFailure, TelemetryOperation, TelemetryOutcome};
use gtk::{gio, glib, prelude::*};
use gtk4 as gtk;
use std::path::PathBuf;

/// The releases page a build from source points at.
const RELEASES_PAGE: &str = "https://github.com/AgentWorkforce/relay-desktop-releases/releases";

/// What finishing an update left.
enum Updated {
    /// The new version's launcher, which replaces this process.
    Installed(PathBuf),
    /// The verified package, for the package manager.
    Downloaded(PathBuf),
}

impl App {
    // Updates.

    /// Looks for a newer release; unless `user` asked, only while automatic
    /// checks are on.
    pub fn check_updates(&self, user: bool) {
        if self.with_state(|state| state.update_state.busy()) {
            return;
        }
        if !user && !self.prefs().automatically_checks_for_updates() {
            return;
        }
        self.update_state(|state| state.update_state = UpdateState::Checking);
        self.render_settings();
        self.blocking(
            || -> Result<Release, updates::UpdateError> {
                let host = updates::Host::system()
                    .map_err(|error| updates::UpdateError::new(error.to_string()))?;
                updates::latest(updates::current_architecture()?, host.fetch)
            },
            |app, result| {
                app.update_state(|state| {
                    match result {
                        Ok(release) => {
                            state.update_state =
                                if updates::is_newer(&release.version, crate::VERSION) {
                                    UpdateState::Available
                                } else {
                                    UpdateState::UpToDate
                                };
                            state.update_release = Some(release);
                            state.update_message = None;
                        }
                        Err(error) => {
                            state.update_state = UpdateState::Unavailable;
                            state.update_release = None;
                            state.update_message = Some(error.to_string());
                        }
                    }
                    state.update_checked = Some(chrono::Local::now().format("%H:%M").to_string());
                });
                if app.with_state(|state| state.connected()) {
                    app.render_chrome();
                    app.render_settings();
                }
            },
        );
    }

    /// About's update button: checks, or installs the available release as
    /// this install updates.
    pub fn update_action(&self) {
        let (state, release, kind) = self.with_state(|state| {
            (
                state.update_state,
                state.update_release.clone(),
                state.install_kind,
            )
        });
        let (UpdateState::Available, Some(release)) = (state, release) else {
            self.check_updates(true);
            return;
        };
        match kind {
            InstallKind::Source => {
                let page = if release.page_url.is_empty() {
                    RELEASES_PAGE.to_string()
                } else {
                    release.page_url.clone()
                };
                self.inner.desktop.open_uri(&page);
            }
            InstallKind::Tarball => {
                let answer = self.confirm(Confirmation::new(
                    "Update Agent Relay now?",
                    &format!("Agent Relay will restart to install version {}. This interrupts active uploads; they resume when the app reopens.", release.version),
                    "Update",
                ));
                let weak = self.downgrade();
                glib::spawn_future_local(async move {
                    if let (true, Some(app)) = (answer.await, weak.upgrade()) {
                        app.install_update(release, kind);
                    }
                });
            }
            InstallKind::Deb => self.install_update(release, kind),
        }
    }

    fn install_update(&self, release: Release, kind: InstallKind) {
        self.record(
            TelemetryOperation::UpdateInstall,
            TelemetryOutcome::Started,
            None,
        );
        self.update_state(|state| state.update_state = UpdateState::Downloading);
        self.render_settings();
        self.blocking(
            move || -> Result<Updated, updates::UpdateError> {
                let host = updates::Host::system()
                    .map_err(|error| updates::UpdateError::new(error.to_string()))?;
                if kind == InstallKind::Tarball {
                    let exe = install::current_exe()
                        .map_err(|error| updates::UpdateError::new(error.to_string()))?;
                    let root = install::install_root(&exe, &host.home);
                    updates::install_per_user(&release, &root, &host).map(Updated::Installed)
                } else {
                    updates::download_deb(&release, None, &host).map(Updated::Downloaded)
                }
            },
            |app, result| app.update_finished(result),
        );
    }

    fn update_finished(&self, result: Result<Updated, updates::UpdateError>) {
        match result {
            Err(error) => {
                self.record(
                    TelemetryOperation::UpdateInstall,
                    TelemetryOutcome::Failed,
                    Some(TelemetryFailure::UpdateFailed),
                );
                self.update_state(|state| {
                    state.update_state = UpdateState::Failed;
                    state.update_message = Some(error.to_string());
                });
                self.render_settings();
            }
            Ok(Updated::Downloaded(path)) => {
                self.record(
                    TelemetryOperation::UpdateInstall,
                    TelemetryOutcome::RequiresAction,
                    None,
                );
                self.update_state(|state| {
                    state.update_state = UpdateState::Available;
                    state.update_message = None;
                });
                widgets::copy_to_clipboard(&format!(
                    "sudo apt-get install -y '{}'",
                    path.display()
                ));
                let folder = path.parent().map(PathBuf::from).unwrap_or_default();
                self.inner.desktop.inform(
                    self.window(),
                    "Update downloaded",
                    &format!("The verified package is in {}. Install it with your package manager; the command is on your clipboard.", folder.display()),
                );
                self.inner
                    .desktop
                    .open_uri(&gio::File::for_path(&folder).uri());
                self.render_settings();
            }
            Ok(Updated::Installed(launcher)) => {
                self.update_state(|state| state.update_state = UpdateState::Installing);
                self.render_settings();
                // The new version's launcher replaces this process and hosts
                // its own core, so a core this app hosts stops first. The
                // bridge keeps running, so the app stays usable when the
                // launcher cannot start.
                let bridge = self.bridge().clone();
                let event = crate::relay::telemetry::TelemetryEvent::new(
                    TelemetryOperation::UpdateInstall,
                    TelemetryOutcome::Succeeded,
                );
                // Bound the entire RPC (including connection/retries), while
                // allowing the core's two-second success flush before relaunch.
                let answer = self.inner.runtime.spawn(async move {
                    wait_for_update_telemetry(
                        bridge.call::<method::TelemetryRecord>(event),
                        std::time::Duration::from_secs(3),
                    )
                    .await;
                });
                let weak = self.downgrade();
                glib::spawn_future_local(async move {
                    let _ = answer.await;
                    if let Some(app) = weak.upgrade() {
                        app.relaunch_updated(launcher);
                    }
                });
            }
        }
    }

    fn relaunch_updated(&self, launcher: PathBuf) {
        let background: Vec<String> = std::env::args()
            .skip(1)
            .filter(|argument| argument == "--background")
            .collect();
        let Err(error) = self.relaunch_into(&launcher, &background) else {
            return;
        };
        self.update_state(|state| {
            state.update_state = UpdateState::Failed;
            state.update_message = Some(format!(
                "Agent Relay could not restart into the new version: {error}."
            ));
        });
        self.render_settings();
    }
}

/// The deadline covers connection/retries as well as the core's flush.
async fn wait_for_update_telemetry(
    recording: impl std::future::Future,
    deadline: std::time::Duration,
) {
    let _ = tokio::time::timeout(deadline, recording).await;
}

#[cfg(test)]
mod tests {
    use super::wait_for_update_telemetry;
    use std::time::Duration;

    #[tokio::test]
    async fn update_telemetry_deadline_allows_relaunch_when_rpc_never_replies() {
        tokio::time::timeout(Duration::from_secs(1), async {
            wait_for_update_telemetry(std::future::pending::<()>(), Duration::from_millis(10))
                .await;
        })
        .await
        .expect("update must continue after the telemetry deadline");
    }

    #[tokio::test]
    async fn update_telemetry_waits_for_success_flush_reply() {
        let completed = std::sync::atomic::AtomicBool::new(false);
        wait_for_update_telemetry(
            async {
                tokio::task::yield_now().await;
                completed.store(true, std::sync::atomic::Ordering::SeqCst);
            },
            Duration::from_secs(1),
        )
        .await;
        assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
    }
}
