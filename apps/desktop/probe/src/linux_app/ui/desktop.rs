//! What the app asks of the desktop around it: opening links in the
//! browser, notifications, modal questions and quitting. [`System`] is the
//! real desktop (Windows' own in `desktop/windows.rs`); tests stand in their own
//! [`Desktop`].

use crate::relay::contract::connection::CoreNotification;
#[cfg(not(windows))]
use gtk::gio;
use gtk::prelude::*;
use gtk4 as gtk;
use std::future::Future;
use std::pin::Pin;

/// A question asked before something hard to undo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmation {
    pub title: String,
    pub detail: String,
    /// The confirming button.
    pub action: String,
    /// The action loses something: Cancel is the default.
    pub destructive: bool,
}

impl Confirmation {
    pub fn new(title: &str, detail: &str, action: &str) -> Confirmation {
        Confirmation {
            title: title.into(),
            detail: detail.into(),
            action: action.into(),
            destructive: false,
        }
    }

    pub fn destructive(mut self) -> Confirmation {
        self.destructive = true;
        self
    }
}

pub type Answer = Pin<Box<dyn Future<Output = bool>>>;

pub trait Desktop {
    /// Opens an `https`, `http` or `file` URI in the person's browser or
    /// file manager. Returns whether the native opening handoff was started.
    fn open_uri(&self, uri: &str) -> bool;
    fn has_uri_handler(&self, scheme: &str) -> bool;
    /// Starts an interactive CLI resume command in a terminal.
    fn open_terminal(&self, command: &str) -> Result<(), String>;
    /// Shows the core's notification; clicking it opens its link, else the
    /// window.
    fn notify(&self, notification: &CoreNotification);
    /// Asks `confirmation` over `parent`; true when confirmed.
    fn confirm(&self, parent: &gtk::Window, confirmation: Confirmation) -> Answer;
    /// Tells the person something that needs no answer.
    fn inform(&self, parent: &gtk::Window, title: &str, detail: &str);
    /// Ends the app.
    fn quit(&self);
}

#[cfg(windows)]
mod windows;

/// The desktop the app runs on.
pub struct System {
    pub application: gtk::Application,
    /// Notification clicks, which Windows reports off the main thread.
    #[cfg(windows)]
    activations: windows::Activations,
}

impl System {
    /// The desktop around `application`; on the main thread, after it
    /// started.
    pub fn new(application: &gtk::Application) -> System {
        System {
            application: application.clone(),
            #[cfg(windows)]
            activations: windows::activations(application),
        }
    }
}

impl Desktop for System {
    fn has_uri_handler(&self, scheme: &str) -> bool {
        self.platform_has_uri_handler(scheme)
    }
    fn open_terminal(&self, command: &str) -> Result<(), String> {
        self.platform_open_terminal(command)
    }

    fn open_uri(&self, uri: &str) -> bool {
        self.platform_open_uri(uri)
    }

    fn notify(&self, notification: &CoreNotification) {
        self.platform_notify(notification)
    }

    fn confirm(&self, parent: &gtk::Window, confirmation: Confirmation) -> Answer {
        let dialog = gtk::MessageDialog::builder()
            .transient_for(parent)
            .modal(true)
            .message_type(gtk::MessageType::Question)
            .buttons(gtk::ButtonsType::None)
            .text(&confirmation.title)
            .secondary_text(&confirmation.detail)
            .build();
        dialog.add_button("Cancel", gtk::ResponseType::Cancel);
        let confirm = dialog.add_button(&confirmation.action, gtk::ResponseType::Ok);
        confirm.add_css_class(if confirmation.destructive {
            "destructive"
        } else {
            "primary"
        });
        dialog.set_default_response(if confirmation.destructive {
            gtk::ResponseType::Cancel
        } else {
            gtk::ResponseType::Ok
        });
        let (answer, answered) = tokio::sync::oneshot::channel::<bool>();
        let answer = std::cell::Cell::new(Some(answer));
        dialog.connect_response(move |dialog, response| {
            if let Some(answer) = answer.take() {
                let _ = answer.send(response == gtk::ResponseType::Ok);
            }
            dialog.close();
        });
        dialog.present();
        Box::pin(async move { answered.await.unwrap_or(false) })
    }

    fn inform(&self, parent: &gtk::Window, title: &str, detail: &str) {
        let dialog = gtk::MessageDialog::builder()
            .transient_for(parent)
            .modal(true)
            .message_type(gtk::MessageType::Info)
            .buttons(gtk::ButtonsType::Ok)
            .text(title)
            .secondary_text(detail)
            .build();
        dialog.connect_response(|dialog, _| dialog.close());
        dialog.present();
    }

    fn quit(&self) {
        self.application.quit();
    }
}

#[cfg(not(windows))]
impl System {
    fn platform_has_uri_handler(&self, scheme: &str) -> bool {
        gio::AppInfo::default_for_uri_scheme(scheme).is_some()
    }

    fn platform_open_terminal(&self, command: &str) -> Result<(), String> {
        // Explicit argv conventions; never evaluate a terminal preference as shell code.
        for (terminal, separator) in [
            ("xdg-terminal-exec", "--"),
            ("x-terminal-emulator", "-e"),
            ("gnome-terminal", "--"),
            ("konsole", "-e"),
            ("xfce4-terminal", "-x"),
            ("xterm", "-e"),
        ] {
            match std::process::Command::new(terminal)
                .args([separator, "/bin/sh", "-lc", command])
                .stdin(std::process::Stdio::null())
                .spawn()
            {
                Ok(mut child) => {
                    std::thread::spawn(move || child.wait());
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err(
            "No supported terminal found. Copy the resume command and run it in your terminal."
                .into(),
        )
    }

    fn platform_open_uri(&self, uri: &str) -> bool {
        let opener = if cfg!(target_os = "linux") {
            "xdg-open"
        } else {
            "open"
        };
        // Reaped on its own thread: the browser outlives the opener.
        if let Ok(mut child) = std::process::Command::new(opener)
            .arg(uri)
            .stdin(std::process::Stdio::null())
            .spawn()
        {
            std::thread::spawn(move || child.wait());
            true
        } else {
            false
        }
    }

    fn platform_notify(&self, notification: &CoreNotification) {
        let title = if notification.title.is_empty() {
            "Agent Relay"
        } else {
            &notification.title
        };
        let shown = gio::Notification::new(title);
        if !notification.body.is_empty() {
            shown.set_body(Some(&notification.body));
        }
        match notification.link.as_deref().filter(|link| !link.is_empty()) {
            Some(link) => {
                shown.set_default_action_and_target_value("app.open-link", Some(&link.to_variant()))
            }
            None => shown.set_default_action("app.show"),
        }
        self.application.send_notification(None, &shown);
    }
}

#[cfg(windows)]
impl System {
    fn platform_has_uri_handler(&self, scheme: &str) -> bool {
        windows::has_uri_handler(scheme)
    }

    fn platform_open_terminal(&self, command: &str) -> Result<(), String> {
        windows::open_terminal(command)
    }

    fn platform_open_uri(&self, uri: &str) -> bool {
        windows::open_uri(uri)
    }

    fn platform_notify(&self, notification: &CoreNotification) {
        windows::notify(&self.activations, notification)
    }
}
