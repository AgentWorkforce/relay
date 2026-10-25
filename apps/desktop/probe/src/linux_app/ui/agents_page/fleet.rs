//! Fleet workers: their rows, menu and release.
use super::*;

/// A worker's state, its node and what waits for it.
fn fleet_subtitle(broker: &BrokerListing, worker: &WorkerRow) -> gtk::Label {
    let state = match worker.last_activity_ms {
        Some(when) if worker.state == WorkerState::Idle => agent_line(
            None,
            None,
            "",
            "idle",
            Some(when),
            super::super::now_ms(),
            &chrono::Local,
        ),
        _ => worker_state_label(worker.state).to_string(),
    };
    let mut parts = vec![state, format!("on {}", broker.name)];
    if let Some(pending) = worker.pending_messages.filter(|pending| *pending > 0) {
        parts.push(format!("{pending} pending"));
    }
    text(&parts.join(" · "), &["row-subtitle"]).ellipsized()
}

impl App {
    // Fleet workers: their fleet name is already the address anyone in the
    // workspace can message, so a click copies it.

    pub(super) fn fleet_row(&self, broker: &BrokerListing, worker: &WorkerRow) -> gtk::Widget {
        let identifier = worker_key(broker, worker);
        let name = worker.name.clone();
        let (expanded, error, copied, releasing, released) = self.with_state(|state| {
            (
                state.expanded_workers.contains(&identifier),
                state.fleet_row_errors.get(&identifier).cloned(),
                state.copied.contains(&identifier),
                state.releasing.contains(&identifier),
                state.released.contains(&identifier),
            )
        });
        let outer = vbox(4, &[]);
        let content = hbox(10, &[]);
        content.set_margin_start(8);
        content.set_margin_end(6);
        let dot = Dot::new(10);
        let (color, filled) = worker_dot(worker.state);
        dot.set(color, filled);
        let badge = with_dot(&agent_badge(&worker.provider, 28), &dot);
        badge.set_valign(gtk::Align::Center);
        content.append(&badge);
        let words = vbox(2, &[]);
        words.set_valign(gtk::Align::Center);
        words.set_hexpand(true);
        words.append(&text(&format!("@{name}"), &["row-title"]).ellipsized());
        let subtitle = if let Some(error) = &error {
            text(error, &["row-subtitle", "warn"]).ellipsized()
        } else if released {
            // Released as asked, until the fleet is listed again.
            text("Released", &["row-subtitle"])
        } else if copied {
            text(&format!("Copied @{name}"), &["row-subtitle", "ok"])
        } else {
            fleet_subtitle(broker, worker)
        };
        words.append(&subtitle);
        content.append(&words);
        if releasing {
            let spinner = gtk::Spinner::new();
            spinner.start();
            content.append(&spinner);
        } else if released {
            // Nothing is left to do with a released worker.
        } else {
            let more = icon_button(
                "view-more-symbolic",
                &format!("Actions for @{name}"),
                &["icon"],
                || {},
            );
            more.set_valign(gtk::Align::Center);
            let weak = self.downgrade();
            let (menu_broker, menu_worker) = (broker.clone(), worker.clone());
            more.connect_clicked(move |more| {
                if let Some(app) = weak.upgrade() {
                    menu(more, None, app.fleet_menu(&menu_broker, &menu_worker));
                }
            });
            content.append(&more);
        }
        let toggle = identifier.clone();
        content.append(&chevron(
            expanded,
            "worker details",
            self.on(move |app| app.toggle_worker(&toggle)),
        ));
        let row = hover_row(&content, 50);
        row.set_tooltip_text(Some(&format!("Copy @{name}")));
        let weak = self.downgrade();
        let anchor = row.downgrade();
        let (press_broker, press_worker) = (broker.clone(), worker.clone());
        let pressed = identifier.clone();
        on_press(&row, move |button, x, y| {
            let (Some(app), Some(anchor)) = (weak.upgrade(), anchor.upgrade()) else {
                return;
            };
            match button {
                3 => menu(
                    &anchor,
                    Some((x, y)),
                    app.fleet_menu(&press_broker, &press_worker),
                ),
                1 => app.copy_name(&pressed, &press_worker.name),
                _ => {}
            }
        });
        outer.append(&row);
        if expanded {
            let mut facts: Vec<(&str, gtk::Widget)> = vec![
                ("Status", fact(worker_state_label(worker.state))),
                (
                    "Last activity",
                    fact(&match worker.last_activity_ms {
                        Some(when) => {
                            crate::linux_app::models::clock_ms(Some(when), &chrono::Local)
                        }
                        None => "Unavailable".into(),
                    }),
                ),
                ("Node", fact(&broker.name)),
                (
                    "Harness",
                    fact(if worker.provider_label.is_empty() {
                        &worker.provider
                    } else {
                        &worker.provider_label
                    }),
                ),
            ];
            if let Some(model) = &worker.model {
                facts.push(("Model", fact(model)));
            }
            if let Some(session) = &worker.session_id {
                facts.push(("Session", fact(session)));
            }
            if !worker.channels.is_empty() {
                facts.push(("Channels", fact(&worker.channels.join(", "))));
            }
            let details = vbox(6, &[]);
            details.set_margin_start(38);
            details.set_margin_end(8);
            details.set_margin_bottom(8);
            details.append(&fact_grid(facts));
            if let Some(session) = &worker.session_id {
                let published = self.with_state(|state| {
                    state
                        .roster
                        .iter()
                        .find(|agent| agent.session_id.as_ref() == Some(session))
                        .map(|agent| agent.description.clone())
                        .unwrap_or_default()
                });
                details.append(&self.overview_card(session, &published));
            }
            let command = fleet_attach_command(&name, &broker.node_id);
            let attach = button("Copy terminal attach command", &[], move || {
                widgets::copy_to_clipboard(&command)
            });
            attach.set_halign(gtk::Align::Start);
            details.append(&attach);
            outer.append(&details);
        }
        outer.upcast()
    }

    pub fn toggle_worker(&self, identifier: &str) {
        self.update_state(|state| {
            if !state.expanded_workers.remove(identifier) {
                state.expanded_workers.insert(identifier.to_string());
            }
        });
        self.render_page();
    }

    /// A worker's menu: copy its name, and release it when the fleet named
    /// its generation.
    pub fn fleet_menu(&self, broker: &BrokerListing, worker: &WorkerRow) -> MenuItems {
        let name = format!("@{}", worker.name);
        let release = worker.generation.is_some().then(|| {
            let (broker, worker) = (broker.clone(), worker.clone());
            Box::new(self.on(move |app| app.confirm_release(&broker, &worker))) as Callback
        });
        vec![
            (
                format!("Copy {name}"),
                Some(Box::new(move || widgets::copy_to_clipboard(&name)) as Callback),
            ),
            ("-".into(), None),
            ("Release…".into(), release),
        ]
    }

    fn confirm_release(&self, broker: &BrokerListing, worker: &WorkerRow) {
        let answer = self.confirm(
            Confirmation::new(
                &format!("Release @{}?", worker.name),
                "The broker stops the worker's provider process. Its Agent Relay name is released back to the fleet; this cannot be undone.",
                "Release",
            )
            .destructive(),
        );
        let weak = self.downgrade();
        let (broker, worker) = (broker.clone(), worker.clone());
        glib::spawn_future_local(async move {
            if answer.await {
                if let Some(app) = weak.upgrade() {
                    app.release(&broker, &worker);
                }
            }
        });
    }

    /// Releases a fleet worker, checked against the generation the fleet
    /// listed.
    pub fn release(&self, broker: &BrokerListing, worker: &WorkerRow) {
        let identifier = worker_key(broker, worker);
        let Some(generation) = worker.generation.clone() else {
            return;
        };
        let start = self.update_state(|state| {
            if !state.releasing.insert(identifier.clone()) {
                return false;
            }
            // The row reads as released at once; a refusal puts it back.
            state.released.insert(identifier.clone());
            state.fleet_row_errors.remove(&identifier);
            true
        });
        if !start {
            return;
        }
        self.render_page();
        self.view_call::<method::FleetRelease>(
            ReleaseParams {
                node_id: broker.node_id.clone(),
                name: worker.name.clone(),
                generation,
            },
            move |app, result| {
                app.update_state(|state| {
                    state.releasing.remove(&identifier);
                    if let Err(error) = result {
                        state.released.remove(&identifier);
                        state.fleet_row_errors.insert(identifier, error.message);
                    }
                });
                app.render_page();
                app.refresh_fleet();
            },
        );
    }
}
