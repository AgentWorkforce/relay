//! The Agent Relay tools row under OpenClaw's: Connect adds Agent Relay's
//! hosted MCP to `openclaw.json` and opens its consent page in the browser,
//! the way sign-in opens its approval page; while that page is open the row
//! reads the status again every two seconds, until it is connected or the
//! Settings page goes away.
use super::*;
use crate::linux_app::models::{
    openclaw_tools_polls, OpenClawToolsAction, OpenClawToolsRow, OPENCLAW_TOOLS_POLL_EVERY,
    OPENCLAW_TOOLS_TITLE,
};
use crate::relay::contract::openclaw::{OpenClawToolsState, OpenClawToolsStatus};

impl App {
    fn openclaw_on(&self) -> bool {
        self.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.openclaw_gateway)
                == Some(true)
        })
    }

    /// The row, read from the core the first time it shows.
    pub(super) fn openclaw_tools_row(&self) -> gtk::Box {
        let view = self.with_state(|state| state.openclaw.tools.clone());
        let Some(status) = view.status.as_ref() else {
            self.load_openclaw_tools();
            return settings_row(
                OPENCLAW_TOOLS_TITLE,
                "",
                "applications-engineering-symbolic",
                None,
                &[],
            )
            .0;
        };
        let row = OpenClawToolsRow::new(status);
        let accessory = row.action.map(|action| {
            let classes: &[&str] = match action {
                OpenClawToolsAction::Connect => &["primary"],
                OpenClawToolsAction::OpenAgain => &[],
            };
            let widget = button(
                action.label(),
                classes,
                self.on(App::connect_openclaw_tools),
            );
            widget.set_sensitive(!view.connecting);
            widget
        });
        let mut errors: Vec<&String> = view.error.iter().chain(row.error.iter()).collect();
        errors.dedup();
        let extra: Vec<gtk::Widget> = errors
            .into_iter()
            .filter(|error| **error != row.detail)
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            OPENCLAW_TOOLS_TITLE,
            &row.detail,
            if status.state == OpenClawToolsState::Connected {
                "emblem-ok-symbolic"
            } else {
                "applications-engineering-symbolic"
            },
            accessory.as_ref().map(|widget| widget.upcast_ref()),
            &extra,
        )
        .0
    }

    /// Reads `openclaw.relay_tools.status` while OpenClaw is on.
    pub(crate) fn load_openclaw_tools(&self) {
        if !self.openclaw_on() {
            return;
        }
        // A read asked before the latest Connect is older than its answer.
        let asked = self.with_state(|state| state.openclaw.tools.connects);
        self.once::<method::OpenclawRelayToolsStatus>(
            "openclaw_tools",
            NoParams {},
            App::load_openclaw_tools,
            move |app, result| {
                let status = result.unwrap_or_else(|error| OpenClawToolsStatus {
                    state: OpenClawToolsState::Unavailable,
                    detail: Some(error.message),
                });
                app.show_openclaw_tools(|view| {
                    if view.connects == asked {
                        view.status = Some(status);
                    }
                });
            },
        );
    }

    /// Changes the row's state, and redraws Messages when it changed.
    fn show_openclaw_tools(
        &self,
        change: impl FnOnce(&mut crate::linux_app::models::OpenClawToolsView),
    ) {
        let changed = self.update_state(|state| {
            let before = state.openclaw.tools.clone();
            change(&mut state.openclaw.tools);
            state.openclaw.tools != before
        });
        self.poll_openclaw_tools();
        if changed && self.page() == Page::Settings(Pane::Relay) {
            self.render_settings();
        }
    }

    /// Reads the status again soon while the browser is open; once Settings
    /// is left, it is read again when the row next shows.
    fn poll_openclaw_tools(&self) {
        let start = self.update_state(|state| {
            let view = &mut state.openclaw.tools;
            let start = openclaw_tools_polls(view.status.as_ref()) && !view.polling;
            view.polling |= start;
            start
        });
        if !start {
            return;
        }
        let weak = self.downgrade();
        glib::timeout_add_local_once(OPENCLAW_TOOLS_POLL_EVERY, move || {
            let Some(app) = weak.upgrade() else {
                return;
            };
            let shown = app.page() == Page::Settings(Pane::Relay);
            app.update_state(|state| {
                state.openclaw.tools.polling = false;
                if !shown {
                    state.openclaw.tools.status = None;
                }
            });
            if shown {
                app.load_openclaw_tools();
            }
        });
    }

    /// Connect, or Open Again: the core answers with the consent page,
    /// which opens in the browser.
    fn connect_openclaw_tools(&self) {
        if self.with_state(|state| state.openclaw.tools.connecting) {
            return;
        }
        self.show_openclaw_tools(|view| {
            view.connecting = true;
            view.connects += 1;
            view.error = None;
        });
        self.call::<method::OpenclawRelayToolsConnect>(NoParams {}, |app, result| {
            let result = result.map(|connect| {
                if let Some(url) = connect
                    .authorization_url
                    .filter(|url| super::super::super::app::web_link(url))
                {
                    app.inner.desktop.open_uri(&url);
                }
                connect.state
            });
            let failed = result.is_err();
            app.show_openclaw_tools(|view| {
                view.connecting = false;
                match result {
                    Ok(state) => {
                        view.status = Some(OpenClawToolsStatus {
                            state,
                            detail: None,
                        })
                    }
                    // The row keeps its button, with why under it, as on
                    // the Mac.
                    Err(error) => view.error = Some(error.message),
                }
            });
            // Read again: the core may now say why it is unavailable.
            if failed {
                app.load_openclaw_tools();
            }
        });
    }
}
