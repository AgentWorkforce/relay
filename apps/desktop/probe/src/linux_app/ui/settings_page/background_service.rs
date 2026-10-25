//! The background service rows and actions (the systemd user unit on Linux,
//! the logon task on Windows), and keeping agents connected
//! after the app quits.
use super::*;
use crate::linux_app::service::wording as service_wording;

impl App {
    pub(super) fn background_service_row(&self) -> gtk::Box {
        let (state, error) =
            self.with_state(|state| (state.service_state, state.service_error.clone()));
        let keeps_connected = self.prefs().keeps_agents_connected_after_quit();
        let mut extra: Vec<gtk::Widget> = Vec::new();
        let accessory: Option<gtk::Widget> = match state {
            None => {
                let spinner = gtk::Spinner::new();
                spinner.start();
                Some(spinner.upcast())
            }
            Some(service) if !service.installed => {
                extra.push(notice(
                    if keeps_connected {
                        service_wording::NOT_INSTALLED_KEEPS_CONNECTED
                    } else {
                        service_wording::NOT_INSTALLED
                    },
                    Tone::Warn,
                ));
                None
            }
            Some(service) if !service.enabled || !service.active => {
                extra.push(notice(
                    if keeps_connected {
                        "The service is off: your agents stay connected after Agent Relay quits, but connect only once it opens after you log in."
                    } else {
                        "The service is off: your agents go offline when Agent Relay quits."
                    },
                    Tone::Warn,
                ));
                Some(button("Turn On", &["primary"], self.on(App::enable_service)).upcast())
            }
            Some(_) => None,
        };
        if let Some(service) = state {
            extra.insert(0, text(service.label(), &["caption"]).upcast());
        }
        if let Some(error) = error {
            extra.push(notice(&error, Tone::Error));
        }
        settings_row(
            "Background service",
            "Keeps your agents connected and uploads running while Agent Relay is closed, and starts at login.",
            "system-run-symbolic",
            accessory.as_ref(),
            &extra,
        )
        .0
    }

    pub fn refresh_service(&self) {
        let service = self.inner.service.clone();
        self.blocking(
            move || service.state(),
            |app, state| {
                app.update_state(|current| current.service_state = Some(state));
                if app.page() == Page::Settings(Pane::General) {
                    app.render_settings();
                }
            },
        );
    }

    pub fn enable_service(&self) {
        let answer = self.confirm(Confirmation::new(
            "Run Agent Relay as a background service?",
            "The service keeps your agents connected and uploads running while the app is closed, and starts at login in place of the app's login entry. It applies the agent-led defaults: Claude Code direct delivery (crossSessionInbound set to accept), live sessions put on the relay automatically, and only the sessions you choose uploaded. You can change each of these afterwards in Settings.",
            "Turn On",
        ));
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            let (true, Some(app)) = (answer.await, weak.upgrade()) else {
                return;
            };
            app.update_state(|state| state.service_error = None);
            let bridge = app.bridge().clone();
            let service = app.inner.service.clone();
            // The service takes the core's socket: a core this app hosts
            // stops first.
            let enabled = app.inner.runtime.spawn(async move {
                bridge.release_hosted().await;
                tokio::task::spawn_blocking(move || service.enable())
                    .await
                    .unwrap_or_else(|_| Err(service_wording::ENABLE_FAILED.into()))
            });
            drop(app);
            let result = enabled
                .await
                .unwrap_or_else(|_| Err(service_wording::ENABLE_FAILED.into()));
            let Some(app) = weak.upgrade() else {
                return;
            };
            if result.is_ok() {
                // The service keeps agents connected after the app quits.
                let _ = app
                    .inner
                    .prefs
                    .borrow_mut()
                    .set_keeps_agents_connected_after_quit(true);
            }
            app.update_state(|state| state.service_error = result.err());
            app.bridge().restart();
            app.refresh_service();
        });
    }

    /// Turns keeping agents connected after quitting on or off. Off, the
    /// systemd unit, which would keep them connected, is turned off too,
    /// once the person agrees; the app then hosts the core itself.
    pub fn change_keep_connected(&self, enabled: bool) {
        if self.inner.updating.get() {
            return;
        }
        let service_state = self.with_state(|state| state.service_state);
        if !enabled && service_state.is_none() {
            // Not read yet: whether the unit must be turned off too is unknown.
            let service = self.inner.service.clone();
            self.blocking(
                move || service.state(),
                |app, state| {
                    app.update_state(|current| current.service_state = Some(state));
                    app.change_keep_connected(false);
                },
            );
            return;
        }
        let service_on = service_state
            .is_some_and(|service| service.installed && (service.enabled || service.active));
        if enabled || !service_on {
            let _ = self
                .inner
                .prefs
                .borrow_mut()
                .set_keeps_agents_connected_after_quit(enabled);
            self.render_settings();
            return;
        }
        let answer = self.confirm(Confirmation::new(
            "Turn off the background service?",
            "Agent Relay will no longer start at login, and quitting it will disconnect your agents and stop uploads until you open it again.",
            "Turn Off",
        ));
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            let Some(app) = weak.upgrade() else {
                return;
            };
            if !answer.await {
                app.render_settings();
                return;
            }
            app.update_state(|state| state.service_error = None);
            let service = app.inner.service.clone();
            let disabled = app.inner.runtime.spawn_blocking(move || service.disable());
            drop(app);
            let result = disabled
                .await
                .unwrap_or_else(|_| Err(service_wording::DISABLE_FAILED.into()));
            let Some(app) = weak.upgrade() else {
                return;
            };
            if result.is_ok() {
                let _ = app
                    .inner
                    .prefs
                    .borrow_mut()
                    .set_keeps_agents_connected_after_quit(false);
            }
            app.update_state(|state| state.service_error = result.err());
            // The unit's core has stopped: this app hosts one.
            app.bridge().restart();
            app.refresh_service();
            app.render_settings();
        });
    }
}
