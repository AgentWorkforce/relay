//! The tray on Windows: a notification-area icon (`tray-icon`, which wraps
//! `Shell_NotifyIcon`) with the shared [`menu`](super::menu) as its context
//! menu.
//!
//! `tray-icon` keeps a hidden window on the thread that creates it and
//! needs that thread's message loop. GTK's Windows backend runs one on the
//! main thread, dispatching every message there, so the icon is made on
//! the main thread once the application started. Clicks arrive in the
//! window procedure, on the main thread too; they are sent on as
//! [`TrayAction`]s over the same channel the app drains for every tray.

use super::{Tray, TrayAction, TrayEntry, TrayModel, PROBLEM_RGB};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;
use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

/// The mark as RGBA pixels: width, height, data.
pub type Mark = (u32, u32, Vec<u8>);

/// `pixbuf` as straight RGBA rows without padding, as `tray-icon` takes.
pub fn rgba(pixbuf: &gtk4::gdk_pixbuf::Pixbuf) -> Option<Mark> {
    let pixbuf = pixbuf.add_alpha(false, 0, 0, 0).ok()?;
    let width = pixbuf.width();
    let height = pixbuf.height();
    let stride = pixbuf.rowstride() as usize;
    let bytes = pixbuf.read_pixel_bytes();
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for row in 0..height as usize {
        let at = row * stride;
        data.extend_from_slice(bytes.get(at..at + width as usize * 4)?);
    }
    Some((width as u32, height as u32, data))
}

/// RGBA pixels with every colour replaced by `rgb`, keeping each pixel's
/// alpha so the mark keeps its shape.
pub fn tinted_rgba(rgba: &[u8], rgb: [u8; 3]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|pixel| [rgb[0], rgb[1], rgb[2], pixel[3]])
        .collect()
}

/// A label as a Windows menu shows it written: `&` marks an access key, so
/// a title's own is doubled.
fn escaped(label: &str) -> String {
    label.replace('&', "&&")
}

/// The notification-area icon. Without a notification area (Explorer not
/// running) nothing is shown and the app runs on.
pub struct NotificationArea {
    icon: Option<TrayIcon>,
    normal: Option<Icon>,
    problem: Option<Icon>,
    shown: RefCell<Option<TrayModel>>,
    /// What each item of the menu shown does, read where it is chosen.
    chosen: Arc<Mutex<HashMap<MenuId, TrayAction>>>,
}

impl NotificationArea {
    /// Shows the icon; chosen items and clicks on the icon arrive on
    /// `actions`. On the main thread, after the application started.
    pub fn start(mark: Option<Mark>, actions: UnboundedSender<TrayAction>) -> NotificationArea {
        let chosen: Arc<Mutex<HashMap<MenuId, TrayAction>>> = Arc::default();
        let items = chosen.clone();
        let picked = actions.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let action = items
                .lock()
                .ok()
                .and_then(|items| items.get(&event.id).cloned());
            if let Some(action) = action {
                let _ = picked.send(action);
            }
        }));
        // A left click opens the window, as on the Mac; the right button
        // opens the menu.
        TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = actions.send(TrayAction::ShowWindow);
            }
        }));
        let icon = |pixels: Vec<u8>, (width, height): (u32, u32)| {
            Icon::from_rgba(pixels, width, height).ok()
        };
        let normal = mark
            .as_ref()
            .and_then(|(width, height, data)| icon(data.clone(), (*width, *height)));
        let problem = mark.as_ref().and_then(|(width, height, data)| {
            icon(tinted_rgba(data, PROBLEM_RGB), (*width, *height))
        });
        let mut builder = TrayIconBuilder::new()
            .with_tooltip("Agent Relay")
            .with_menu_on_left_click(false);
        if let Some(normal) = normal.clone() {
            builder = builder.with_icon(normal);
        }
        NotificationArea {
            icon: builder.build().ok(),
            normal,
            problem,
            shown: RefCell::new(None),
            chosen,
        }
    }
}

impl Tray for NotificationArea {
    fn show(&self, model: TrayModel) {
        if self.shown.borrow().as_ref() == Some(&model) {
            return;
        }
        let Some(icon) = &self.icon else {
            return;
        };
        let menu = Menu::new();
        let mut chosen = HashMap::new();
        for entry in &model.entries {
            let _ = match entry {
                TrayEntry::Separator => menu.append(&PredefinedMenuItem::separator()),
                TrayEntry::Note(label) => menu.append(&MenuItem::new(escaped(label), false, None)),
                TrayEntry::Item(label, action) => {
                    let item = MenuItem::new(escaped(label), true, None);
                    chosen.insert(item.id().clone(), action.clone());
                    menu.append(&item)
                }
            };
        }
        if let Ok(mut items) = self.chosen.lock() {
            *items = chosen;
        }
        icon.set_menu(Some(Box::new(menu)));
        let was_problem = self.shown.borrow().as_ref().map(|shown| shown.problem);
        if was_problem != Some(model.problem) {
            let mark = if model.problem {
                self.problem.clone()
            } else {
                self.normal.clone()
            };
            let _ = icon.set_icon(mark);
        }
        *self.shown.borrow_mut() = Some(model);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_problem_mark_keeps_its_shape_in_orange() {
        assert_eq!(
            tinted_rgba(&[1, 2, 3, 0x80, 9, 9, 9, 0], PROBLEM_RGB),
            [0xce, 0x91, 0x78, 0x80, 0xce, 0x91, 0x78, 0]
        );
        assert_eq!(escaped("R&D: 2"), "R&&D: 2");
    }
}
