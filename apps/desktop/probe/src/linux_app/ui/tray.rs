//! The tray: the Mac's menu-bar panel as a StatusNotifierItem menu.
//!
//! [`menu`] decides what the menu holds from the window's [`State`]; a
//! [`Tray`] shows it. On Linux that is `ksni`, which serves the item over
//! D-Bus from the tokio runtime and sends the person's choices back as
//! [`TrayAction`]s; on Windows it is a notification-area icon
//! (`tray/windows.rs`); elsewhere (macOS builds that run the tests) nothing
//! is shown.

use super::app::App;
use super::state::{Page, Pane, State, View};
use crate::linux_app::models::{merge_local_sessions, MenuSummaryFilter, SessionUploadState};
use gtk4::prelude::*;
use std::collections::BTreeSet;

impl App {
    /// Shows the menu for the current state. Its counts follow the session
    /// list's hidden-session visibility, so a change to that refreshes it.
    pub(super) fn update_tray(&self) {
        let hidden = if self.show_hidden_sessions() {
            Default::default()
        } else {
            self.hidden_sessions()
        };
        let model = self.with_state(|state| menu(state, &hidden));
        self.inner.tray.show(model);
    }

    /// A choice from the tray's menu.
    pub fn tray_action(&self, action: TrayAction) {
        match action {
            TrayAction::ShowWindow => self.show_window(),
            TrayAction::Go(page) => self.go(page),
            TrayAction::Search(search) => {
                if let Some(shell) = self.shell() {
                    shell.pages.sessions.transcript.back.emit_clicked();
                }
                self.set_session_search(&search);
                self.go(Page::Sessions);
            }
            TrayAction::ShowProblems => self.show_status_problems(self.window()),
            TrayAction::Quit => self.quit(),
        }
    }
}

/// What a tray item does when chosen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayAction {
    ShowWindow,
    Go(Page),
    /// The session list, searched for this.
    Search(String),
    /// Diagnostics, where the problem is explained in full.
    ShowProblems,
    Quit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayEntry {
    /// A line that does nothing.
    Note(String),
    Item(String, TrayAction),
    Separator,
}

/// The menu and whether the item asks for attention.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrayModel {
    pub entries: Vec<TrayEntry>,
    pub attention: bool,
    /// Something stops messages or uploads: the mark is drawn in the
    /// warning orange, as on the Mac.
    pub problem: bool,
}

/// The warning orange the mark takes for a problem (the dark theme's, as
/// tray bars are dark).
pub const PROBLEM_RGB: [u8; 3] = [0xce, 0x91, 0x78];

/// ARGB32 pixels with every colour replaced by `rgb`, keeping each pixel's
/// alpha so the mark keeps its shape.
pub fn tinted(argb: &[u8], rgb: [u8; 3]) -> Vec<u8> {
    argb.chunks_exact(4)
        .flat_map(|pixel| [pixel[0], rgb[0], rgb[1], rgb[2]])
        .collect()
}

/// The menu for the window's state: an at-a-glance summary of this
/// computer's sessions receiving relay messages and local only, uploaded
/// and not, and a way into the app. `hidden` sessions are not counted,
/// as the session list does not show them. A tray item has no hover, so the
/// upload status is written beside Uploads.
pub fn menu(state: &State, hidden: &BTreeSet<String>) -> TrayModel {
    use TrayEntry::*;
    let mut entries = Vec::new();
    let connected = state.view == Some(View::Connected);
    let problem = connected && state.relay_problem().is_some();
    if connected {
        let mut rows = merge_local_sessions(&state.sessions, &state.local_sessions);
        rows.retain(|row| !hidden.contains(&row.key()));
        let count = |filter: MenuSummaryFilter| {
            let total = filter.count(&rows, |row| {
                row.upload
                    .as_ref()
                    .map(|session| SessionUploadState::of(session, state.status.as_ref()))
            });
            Item(
                format!("{}: {total}", filter.title()),
                TrayAction::Search(filter.search().into()),
            )
        };
        entries.push(Note("Messages".into()));
        // A tray item has no hover: this stands for the Mac's orange dot,
        // opening Diagnostics, where the problem is explained in full.
        if problem {
            entries.push(Item("⚠ Needs attention".into(), TrayAction::ShowProblems));
        }
        entries.push(count(MenuSummaryFilter::Receiving));
        entries.push(count(MenuSummaryFilter::LocalOnly));
        entries.push(Separator);
        entries.push(Note(format!("Uploads · {}", state.upload_status_text())));
        entries.push(count(MenuSummaryFilter::Uploaded));
        entries.push(count(MenuSummaryFilter::NotUploaded));
    } else {
        entries.push(Note(
            if state.snapshot.is_some() {
                "Not signed in"
            } else {
                "Checking…"
            }
            .into(),
        ));
    }
    entries.push(Separator);
    if connected {
        entries.push(Item(
            "All sessions".into(),
            TrayAction::Search(String::new()),
        ));
    } else {
        entries.push(Item("Open Agent Relay".into(), TrayAction::ShowWindow));
    }
    entries.push(Item(
        "Settings…".into(),
        TrayAction::Go(Page::Settings(Pane::General)),
    ));
    entries.push(Item("Quit Agent Relay".into(), TrayAction::Quit));
    TrayModel {
        attention: problem || (connected && state.is_paused()),
        problem,
        entries,
    }
}

/// Shows the tray's menu.
pub trait Tray {
    fn show(&self, model: TrayModel);
}

/// No tray: a desktop without one, or a test.
pub struct NoTray;

impl Tray for NoTray {
    fn show(&self, _model: TrayModel) {}
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{rgba, NotificationArea};

#[cfg(target_os = "linux")]
pub use sni::StatusNotifier;

#[cfg(target_os = "linux")]
mod sni {
    use super::{Tray, TrayAction, TrayEntry, TrayModel};
    use ksni::menu::StandardItem;
    use ksni::{MenuItem, TrayMethods};
    use tokio::sync::mpsc;

    struct Item {
        model: TrayModel,
        icon: Vec<ksni::Icon>,
        problem_icon: Vec<ksni::Icon>,
        actions: mpsc::UnboundedSender<TrayAction>,
    }

    impl ksni::Tray for Item {
        fn id(&self) -> String {
            "agent-relay".into()
        }

        fn title(&self) -> String {
            "Agent Relay".into()
        }

        fn icon_name(&self) -> String {
            "agent-relay".into()
        }

        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            if self.model.problem {
                self.problem_icon.clone()
            } else {
                self.icon.clone()
            }
        }

        fn status(&self) -> ksni::Status {
            if self.model.attention {
                ksni::Status::NeedsAttention
            } else {
                ksni::Status::Active
            }
        }

        fn activate(&mut self, _x: i32, _y: i32) {
            let _ = self.actions.send(TrayAction::ShowWindow);
        }

        fn menu(&self) -> Vec<MenuItem<Self>> {
            self.model
                .entries
                .iter()
                .map(|entry| match entry {
                    TrayEntry::Separator => MenuItem::Separator,
                    TrayEntry::Note(label) => StandardItem {
                        label: escaped(label),
                        enabled: false,
                        ..Default::default()
                    }
                    .into(),
                    TrayEntry::Item(label, action) => {
                        let action = action.clone();
                        StandardItem {
                            label: escaped(label),
                            activate: Box::new(move |item: &mut Item| {
                                let _ = item.actions.send(action.clone());
                            }),
                            ..Default::default()
                        }
                        .into()
                    }
                })
                .collect()
        }
    }

    /// Menu labels mark access keys with `_`; a title's own underscores
    /// are doubled to show as written.
    fn escaped(label: &str) -> String {
        label.replace('_', "__")
    }

    /// The item, served from `runtime`. A desktop without a
    /// StatusNotifierItem host shows nothing and the app runs on.
    pub struct StatusNotifier {
        models: mpsc::UnboundedSender<TrayModel>,
    }

    impl StatusNotifier {
        /// `icon` is the mark as ARGB32 pixmaps; chosen items arrive on
        /// `actions`.
        pub fn start(
            runtime: &tokio::runtime::Handle,
            icon: Vec<ksni::Icon>,
            actions: mpsc::UnboundedSender<TrayAction>,
        ) -> StatusNotifier {
            let (models, mut updates) = mpsc::unbounded_channel::<TrayModel>();
            runtime.spawn(async move {
                let problem_icon = icon
                    .iter()
                    .map(|icon| ksni::Icon {
                        width: icon.width,
                        height: icon.height,
                        data: super::tinted(&icon.data, super::PROBLEM_RGB),
                    })
                    .collect();
                let item = Item {
                    model: TrayModel::default(),
                    icon,
                    problem_icon,
                    actions,
                };
                let Ok(handle) = item.assume_sni_available(true).spawn().await else {
                    return;
                };
                while let Some(mut model) = updates.recv().await {
                    // Only the newest menu matters.
                    while let Ok(newer) = updates.try_recv() {
                        model = newer;
                    }
                    if handle.update(|item| item.model = model).await.is_none() {
                        return;
                    }
                }
                handle.shutdown().await;
            });
            StatusNotifier { models }
        }
    }

    impl Tray for StatusNotifier {
        fn show(&self, model: TrayModel) {
            let _ = self.models.send(model);
        }
    }

    /// `pixbuf` as the ARGB32 (network byte order) pixmap StatusNotifierItem
    /// takes.
    pub fn pixmap(pixbuf: &gtk4::gdk_pixbuf::Pixbuf) -> Option<ksni::Icon> {
        let pixbuf = pixbuf.add_alpha(false, 0, 0, 0).ok()?;
        let width = pixbuf.width();
        let height = pixbuf.height();
        let stride = pixbuf.rowstride() as usize;
        let bytes = pixbuf.read_pixel_bytes();
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height as usize {
            for column in 0..width as usize {
                let at = row * stride + column * 4;
                let pixel = bytes.get(at..at + 4)?;
                data.extend_from_slice(&[pixel[3], pixel[0], pixel[1], pixel[2]]);
            }
        }
        Some(ksni::Icon {
            width,
            height,
            data,
        })
    }
}

#[cfg(target_os = "linux")]
pub use sni::pixmap;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux_app::install::InstallKind;

    #[test]
    fn connected_the_menu_counts_what_each_search_shows() {
        use serde_json::json;
        let mut state = State::new(InstallKind::Source);
        state.view = Some(View::Connected);
        state.sessions = (0..7)
            .map(|i| {
                let uploaded = i < 3;
                serde_json::from_value(json!({
                    "source": "codex", "session_id": format!("s{i}"), "title": format!("Session {i}"),
                    "is_agent": false, "included": uploaded,
                    "status": if uploaded { "uploaded" } else { "not_shared" }
                }))
                .unwrap()
            })
            .collect();
        let session = |id: &str, on_relay: bool| {
            let registration = on_relay.then(
                || json!({"name": id, "address": format!("{id}@linux"), "added_by_session": false}),
            );
            serde_json::from_value(json!({
                "target": {"kind": "codex", "id": id}, "title": id, "live": true,
                "registration": registration, "suggested_name": id
            }))
            .unwrap()
        };
        state.local_sessions = vec![session("a", true), session("b", true), session("c", false)];
        let model = menu(&state, &BTreeSet::new());
        let items: Vec<_> = model
            .entries
            .iter()
            .filter_map(|entry| match entry {
                TrayEntry::Item(label, action) => Some((label.as_str(), action.clone())),
                _ => None,
            })
            .collect();
        let search = |query: &str| TrayAction::Search(query.into());
        assert_eq!(
            items,
            [
                ("Receiving messages: 2", search("is:active is:on-relay")),
                ("Local only: 1", search("is:active is:off-relay")),
                ("Uploaded: 3", search("upload:uploaded")),
                ("Not uploaded: 7", search("-upload:uploaded")),
                ("All sessions", search("")),
                ("Settings…", TrayAction::Go(Page::Settings(Pane::General))),
                ("Quit Agent Relay", TrayAction::Quit),
            ]
        );
        let hidden = BTreeSet::from(["codex:a".to_string()]);
        assert!(menu(&state, &hidden).entries.contains(&TrayEntry::Item(
            "Receiving messages: 1".into(),
            search("is:active is:on-relay")
        )));
        assert!(!model.entries.iter().any(|entry| matches!(entry,
            TrayEntry::Item(label, _) if label.contains("Pause") || label.contains("Resume"))));
    }

    #[test]
    fn a_problem_turns_the_mark_orange_and_links_to_diagnostics() {
        let mut state = State::new(InstallKind::Source);
        state.view = Some(View::Connected);
        assert!(!menu(&state, &BTreeSet::new()).problem);
        state.core_error = Some("Can't reach the relay".into());
        let model = menu(&state, &BTreeSet::new());
        assert!(model.problem && model.attention);
        assert!(model.entries.contains(&TrayEntry::Item(
            "⚠ Needs attention".into(),
            TrayAction::ShowProblems
        )));
        assert!(!model.entries.iter().any(|entry| matches!(entry,
            TrayEntry::Note(label) | TrayEntry::Item(label, _) if label.contains("Can't reach"))));
        assert_eq!(
            tinted(&[0x80, 1, 2, 3, 0, 9, 9, 9], PROBLEM_RGB),
            [0x80, 0xce, 0x91, 0x78, 0, 0xce, 0x91, 0x78]
        );
    }

    #[test]
    fn signed_out_the_menu_only_opens_the_app() {
        let state = State::new(InstallKind::Source);
        let model = menu(&state, &BTreeSet::new());
        assert_eq!(model.entries[0], TrayEntry::Note("Checking…".into()));
        assert!(model.entries.contains(&TrayEntry::Item(
            "Quit Agent Relay".into(),
            TrayAction::Quit
        )));
        assert!(!model.attention);
    }
}
