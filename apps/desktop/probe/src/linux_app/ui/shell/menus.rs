//! Popover menus attached to the shared shell.

use crate::linux_app::ui::app::App;
use crate::linux_app::ui::state::{Page, Pane};
use crate::linux_app::ui::widgets;
use gtk4 as gtk;

impl App {
    pub(super) fn relay_menu(&self, anchor: &gtk::Button) {
        let refresh = self.on(App::refresh_relay);
        let activity = self
            .with_state(|state| !state.activity.is_empty())
            .then(|| Box::new(self.on(App::show_activity)) as widgets::Callback);
        let settings = self.on(|app| app.go(Page::Settings(Pane::Relay)));
        widgets::popup_menu(
            anchor,
            vec![
                ("Refresh", Some(Box::new(refresh) as widgets::Callback)),
                ("-", None),
                ("Recent Messages…", activity),
                ("-", None),
                ("Relay Settings…", Some(Box::new(settings))),
            ],
        );
    }
}
