//! Team: the workspace's teammates and the agents each has on the relay,
//! one card per person. The sidebar narrows it to one person; the machine
//! picker and search narrow the agents.

use super::app::App;
use super::state::{Page, TeamPick};
use super::widgets::{
    avatar, grouped, hbox, icon, section_header, text, vbox, Color, Dot, LabelStyle,
};
use crate::linux_app::models::{
    group_roster_by_machine, machine_matches, matches_roster, roster_host,
};
use crate::relay::people::RosterAgent;
use gtk::{glib, prelude::*};
use gtk4 as gtk;

impl App {
    /// Narrows Team to one machine; empty shows every one.
    pub fn set_team_machine(&self, machine: &str) {
        let changed = self.update_state(|state| {
            let changed = state.team_machine != machine;
            state.team_machine = machine.to_string();
            changed
        });
        if changed {
            glib::idle_add_local_once(self.on(|app| {
                if app.page() == Page::Team {
                    app.render_page();
                }
            }));
        }
    }

    pub fn render_team(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        // A pick whose row is gone falls back to everyone.
        let gone = self.update_state(|state| {
            let groups = state.roster_groups();
            let gone = match &state.team_pick {
                TeamPick::Everyone => false,
                TeamPick::Unowned => groups.other.is_empty(),
                TeamPick::Person(hash) => !state
                    .teammates()
                    .iter()
                    .any(|person| &person.identity_hash == hash),
            };
            if gone {
                state.team_pick = TeamPick::Everyone;
            }
            gone
        });
        if gone {
            self.render_sidebar();
            self.render_topbar();
        }
        shell.pages.team.redraw(|column| self.team_content(column));
    }

    fn team_content(&self, column: &gtk::Box) {
        column.append(&self.relay_banners());
        let (machines, query, pick, groups, mut people, errors) = self.with_state(|state| {
            let machines: Vec<String> = state
                .roster
                .iter()
                .filter_map(|agent| roster_host(agent).map(str::to_string))
                .collect();
            let people: Vec<_> = state.teammates().into_iter().cloned().collect();
            (
                machines,
                state.agent_search.clone(),
                state.team_pick.clone(),
                state.roster_groups(),
                people,
                [state.people_error.clone(), state.roster_error.clone()],
            )
        });
        let (picker, machine) = self.machine_picker(
            &machines,
            |state| &mut state.team_machine,
            App::set_team_machine,
        );
        column.append(&picker);
        let searching = !query.trim().is_empty();
        let narrowed = |found: &[RosterAgent]| -> Vec<RosterAgent> {
            found
                .iter()
                .filter(|agent| {
                    machine_matches(roster_host(agent), &machine) && matches_roster(agent, &query)
                })
                .cloned()
                .collect()
        };
        let no_teammates = people.is_empty();
        let shows_unowned =
            matches!(pick, TeamPick::Everyone | TeamPick::Unowned) && !groups.other.is_empty();
        people.retain(|person| match &pick {
            TeamPick::Everyone => true,
            TeamPick::Person(hash) => &person.identity_hash == hash,
            TeamPick::Unowned => false,
        });
        let count = |hash: &str| groups.teammates.get(hash).map_or(0, Vec::len);
        people.sort_by_cached_key(|person| {
            (
                std::cmp::Reverse(count(&person.identity_hash)),
                person.name.to_lowercase(),
            )
        });
        if no_teammates && !shows_unowned {
            let empty = vbox(10, &[]);
            empty.set_margin_top(48);
            empty.set_halign(gtk::Align::Center);
            let glyph = icon("system-users-symbolic", 30);
            glyph.add_css_class("secondary");
            empty.append(&glyph);
            empty.append(&text("No teammates yet", &["headline"]).centered());
            empty.append(
                &text(
                    "People who join your workspace appear here with the agents they put on the relay.",
                    &["secondary"],
                )
                .wrapped()
                .centered(),
            );
            column.append(&empty);
        }
        for person in &people {
            let name = if person.name.is_empty() {
                "Teammate"
            } else {
                &person.name
            };
            let agents = narrowed(
                groups
                    .teammates
                    .get(&person.identity_hash)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            );
            column.append(&self.person_card(
                name,
                person.avatar_url.as_deref(),
                &agents,
                searching,
            ));
        }
        if shows_unowned {
            column.append(&self.person_card(
                "Other live agents",
                None,
                &narrowed(&groups.other),
                searching,
            ));
        }
        for error in errors.into_iter().flatten() {
            column.append(&text(&error, &["warn", "caption"]).wrapped());
        }
    }

    fn person_card(
        &self,
        name: &str,
        avatar_url: Option<&str>,
        agents: &[RosterAgent],
        searching: bool,
    ) -> gtk::Box {
        let card = vbox(0, &["person-card"]);
        let header = hbox(10, &[]);
        crate::linux_app::ui::widgets::pad(&header, 12, None, None);
        header.append(&avatar(name, avatar_url, 30));
        let words = vbox(2, &[]);
        words.set_valign(gtk::Align::Center);
        words.set_hexpand(true);
        words.append(&text(name, &["row-title"]));
        let summary = if !agents.is_empty() {
            format!("{} on the relay", agents.len())
        } else if searching {
            "No matching agents".to_string()
        } else {
            "No agents on the relay".to_string()
        };
        words.append(&text(&summary, &["caption"]));
        header.append(&words);
        if !agents.is_empty() {
            let count = hbox(4, &["presence-count"]);
            count.append(&Dot::colored(6, Color::Green).widget);
            count.append(&text(&grouped(agents.len()), &["caption"]));
            count.set_valign(gtk::Align::Center);
            crate::linux_app::ui::widgets::name(&count, &format!("{} online", agents.len()));
            header.append(&count);
        }
        card.append(&header);
        if !agents.is_empty() {
            let line = gtk::Separator::new(gtk::Orientation::Horizontal);
            line.set_margin_start(12);
            line.set_margin_end(12);
            card.append(&line);
            let rows = vbox(0, &[]);
            crate::linux_app::ui::widgets::pad(&rows, 6, None, None);
            for group in group_roster_by_machine(agents) {
                rows.append(&section_header(
                    &group.name,
                    Some(&group.agents.len().to_string()),
                ));
                for agent in &group.agents {
                    rows.append(&self.roster_row(agent));
                }
            }
            card.append(&rows);
        }
        card
    }
}
