//! Settings › Relay: the Claude Code config folders whose sessions this
//! computer finds and uploads.

use super::app::App;
use super::settings_page::SettingRow;
use super::widgets::{
    self, button, hbox, notice, settings_divider, settings_row, settings_section, Tone,
};
use crate::linux_app::models::{
    claude_folder_detail, claude_folder_display_path, claude_folder_removable,
    claude_folders_adding, claude_folders_removing, CLAUDE_CLOUD_SESSIONS_DETAIL,
    CLAUDE_CLOUD_SESSIONS_TITLE, CLAUDE_FOLDERS_ADD, CLAUDE_FOLDERS_ADD_HELP,
    CLAUDE_FOLDERS_DETAIL, CLAUDE_FOLDERS_REMOVE, CLAUDE_FOLDERS_SHARE_HELP, CLAUDE_FOLDERS_TITLE,
};
use crate::relay::contract::agents::{ClaudeConfigDir, ClaudeConfigDirChange, SettingsChange};
use gtk::{gio, prelude::*};
use gtk4 as gtk;

impl App {
    /// Every Claude Code config folder whose sessions this computer finds
    /// and uploads, and why; folders added here can be removed here. `None`
    /// until the core reports them.
    pub(super) fn claude_folders_section(&self) -> Option<gtk::Box> {
        let (folders, cloud, error) = self.with_state(|state| {
            let settings = state.settings.as_ref();
            (
                settings.and_then(|settings| settings.claude_config_dirs.clone()),
                settings.and_then(|settings| settings.claude_cloud_sessions),
                state.claude_folders_error.clone(),
            )
        });
        let folders = folders?;
        let (section, group) = settings_section(CLAUDE_FOLDERS_TITLE, Some(CLAUDE_FOLDERS_DETAIL));
        let home = std::env::var("HOME").unwrap_or_default();
        for (index, folder) in folders.iter().enumerate() {
            if index > 0 {
                settings_divider(&group, 62);
            }
            let accessory = hbox(8, &[]);
            if claude_folder_removable(folder) {
                let without = claude_folders_removing(&folder.path, &folders);
                accessory.append(&button(
                    CLAUDE_FOLDERS_REMOVE,
                    &[],
                    self.on(move |app| app.set_claude_folders(without.clone())),
                ));
            }
            let switch = gtk::Switch::new();
            switch.set_active(folder.shared);
            switch.set_valign(gtk::Align::Center);
            switch.set_tooltip_text(Some(CLAUDE_FOLDERS_SHARE_HELP));
            widgets::name(&switch, CLAUDE_FOLDERS_SHARE_HELP);
            let weak = self.downgrade();
            let path = folder.path.clone();
            switch.connect_active_notify(move |switch| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    app.share_claude_folder(&path, switch.is_active());
                }
            });
            accessory.append(&switch);
            let (row, _) = settings_row(
                &claude_folder_display_path(&folder.path, &home),
                &claude_folder_detail(folder),
                "folder-symbolic",
                Some(accessory.upcast_ref()),
                &[],
            );
            row.set_tooltip_text(Some(&folder.path));
            group.append(&row);
        }
        if let Some(cloud) = cloud {
            settings_divider(&group, 62);
            let switch = gtk::Switch::new();
            switch.set_active(cloud);
            switch.set_valign(gtk::Align::Center);
            widgets::name(&switch, CLAUDE_CLOUD_SESSIONS_TITLE);
            let weak = self.downgrade();
            switch.connect_active_notify(move |switch| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    app.set_claude_cloud_sessions(switch.is_active());
                }
            });
            let (row, _) = settings_row(
                CLAUDE_CLOUD_SESSIONS_TITLE,
                CLAUDE_CLOUD_SESSIONS_DETAIL,
                "weather-overcast-symbolic",
                Some(switch.upcast_ref()),
                &[],
            );
            group.append(&row);
        }
        settings_divider(&group, 62);
        let footer = hbox(8, &[]);
        footer.set_margin_top(12);
        footer.set_margin_bottom(12);
        footer.set_margin_start(16);
        footer.set_margin_end(16);
        if let Some(error) = error {
            footer.append(&notice(&error, Tone::Error));
        }
        let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        spacer.set_hexpand(true);
        footer.append(&spacer);
        let add = button(
            CLAUDE_FOLDERS_ADD,
            &[],
            self.on(move |app| app.choose_claude_folder(folders.clone())),
        );
        add.set_tooltip_text(Some(CLAUDE_FOLDERS_ADD_HELP));
        footer.append(&add);
        group.append(&footer);
        Some(section)
    }

    /// Asks for a folder and adds it to the watched Claude Code folders.
    fn choose_claude_folder(&self, folders: Vec<ClaudeConfigDir>) {
        let chooser = gtk::FileChooserNative::new(
            Some(CLAUDE_FOLDERS_ADD.trim_end_matches('…')),
            Some(self.window()),
            gtk::FileChooserAction::SelectFolder,
            Some("Add"),
            Some("Cancel"),
        );
        if let Ok(home) = std::env::var("HOME") {
            let _ = chooser.set_current_folder(Some(&gio::File::for_path(home)));
        }
        // The chooser must outlive this call; its answer releases it.
        let held = std::rc::Rc::new(std::cell::RefCell::new(Some(chooser.clone())));
        let weak = self.downgrade();
        chooser.connect_response(move |chooser, response| {
            let path = (response == gtk::ResponseType::Accept)
                .then(|| chooser.file().and_then(|file| file.path()))
                .flatten();
            if let (Some(path), Some(app)) = (path, weak.upgrade()) {
                app.set_claude_folders(claude_folders_adding(&path.to_string_lossy(), &folders));
            }
            held.borrow_mut().take();
        });
        chooser.show();
    }

    /// Shares a watched Claude Code folder's sessions, or stops sharing them.
    pub fn share_claude_folder(&self, path: &str, shared: bool) {
        self.set_setting(
            SettingsChange {
                claude_config_dir: Some(ClaudeConfigDirChange {
                    path: path.to_string(),
                    shared: Some(shared),
                }),
                ..SettingsChange::default()
            },
            SettingRow::ClaudeFolders,
        );
    }

    pub fn set_claude_cloud_sessions(&self, on: bool) {
        self.set_setting(
            SettingsChange {
                claude_cloud_sessions: Some(on),
                ..SettingsChange::default()
            },
            SettingRow::ClaudeFolders,
        );
    }

    fn set_claude_folders(&self, added: Vec<String>) {
        self.set_setting(
            SettingsChange {
                claude_config_dirs: Some(added),
                ..SettingsChange::default()
            },
            SettingRow::ClaudeFolders,
        );
    }
}
