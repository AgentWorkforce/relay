//! The top-level screen selected from the latest core state.

use super::*;

/// The spawn-cap field's edit, kept across Settings redraws.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpawnCapEdit {
    /// Unsaved text.
    pub draft: Option<String>,
    /// A save is on its way: one at a time, as on macOS.
    pub saving: bool,
    /// The field had keyboard focus; a redraw gives it back.
    pub focused: bool,
}

impl Section {
    pub const ALL: [Section; 3] = [Section::Mine, Section::Team, Section::Settings];

    pub fn title(self) -> &'static str {
        match self {
            Section::Mine => "Sessions",
            Section::Team => "Team",
            Section::Settings => "Settings",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Section::Mine => "view-list-symbolic",
            Section::Team => "system-users-symbolic",
            Section::Settings => "emblem-system-symbolic",
        }
    }

    pub fn help(self) -> &'static str {
        match self {
            Section::Mine => "Sessions",
            Section::Team => "Your teammates' agents",
            Section::Settings => "Settings",
        }
    }

    /// The page the section opens on.
    pub fn home(self) -> Page {
        match self {
            Section::Mine => Page::Sessions,
            Section::Team => Page::Team,
            Section::Settings => Page::Settings(Pane::General),
        }
    }
}

impl State {
    /// Retire answers from the previous core while retaining the signed-in
    /// shell and its last useful snapshot until the replacement answers.
    pub fn connection_interrupted(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.reading_requests = false;
        self.refreshing_uploader = false;
        self.refreshing_sessions = false;
        self.uploader_stale = false;
        self.stale_sessions = false;
        self.refreshing_relay = false;
        self.busy = false;
        self.work_description = None;
        self.requesting.clear();
        self.stopping.clear();
        // Answers to these never arrive from the old core: what was asked
        // for falls back to the last confirmed state.
        self.sharing_mode_wanted.clear();
        self.paused_wanted.clear();
        self.retrying_uploads = false;
        self.compacting_journal = false;
        self.pending_settings.clear();
        self.settings = self.confirmed_settings.clone();
        self.releasing.clear();
        self.busy_uploads.clear();
        self.busy_targets.clear();
        self.loading_overviews.clear();
        for edit in self.session_titles.values_mut() {
            edit.interrupted();
        }
        self.title_write_revision = self.title_write_revision.wrapping_add(1);
        self.loading_title_overviews.clear();
        self.title_overview_reads.clear();
        self.title_overviews.clear();
        self.loading_goals.clear();
        self.overviews
            .retain(|_, overview| overview.status != OverviewStatus::Loading);
    }

    /// The screen to show now, and what it is drawn from.
    pub fn view_for(&self) -> (View, ViewKey) {
        if self.snapshot.is_none() {
            // Keep the signed-in shell and its last answers while the core
            // restarts. The connection indicator carries the live state.
            if self.view == Some(View::Connected) {
                return (View::Connected, ViewKey::None);
            }
            return (
                View::Loading,
                ViewKey::Loading {
                    error: self.core_error.clone(),
                },
            );
        }
        if self.signing_out {
            return (View::SigningOut, ViewKey::None);
        }
        if self.account_connected() {
            return (View::Connected, ViewKey::None);
        }
        let account = self.account();
        if account.phase.as_deref() == Some("selecting_workspace") {
            return (View::ChoosingWorkspace, ViewKey::None);
        }
        if State::signing_in(account.state) {
            return (View::SigningIn, ViewKey::None);
        }
        (
            View::SignIn,
            ViewKey::SignIn {
                state: account.state,
                error: self.sign_in_error.clone().or(account.error),
                action: account.action,
                connecting: self.pending_connect.is_some(),
                starting: self.starting_sign_in,
            },
        )
    }

    /// What was shown for the account that just left. Answers to its
    /// refreshes still in flight are dropped when they arrive.
    pub fn forget_account_view(&mut self) {
        self.connection_interrupted();
        self.status = None;
        self.sessions.clear();
        self.sessions_refreshed = None;
        self.upload_errors.clear();
        self.upload_selection_revision += 1;
        self.session_selection.clear();
        self.hiding_sessions.clear();
        self.upload_action_error = None;
        self.session_error = None;
        self.people.clear();
        self.roster.clear();
        self.people_error = None;
        self.roster_error = None;
        self.relay_load_error = None;
        self.local_sessions.clear();
        self.local_agents.clear();
        self.brokers.clear();
        self.wanted.clear();
        self.relay_errors.clear();
        self.held_sections.clear();
        self.expanded_sessions.clear();
        self.expanded_tools.clear();
        self.expanded_workers.clear();
        self.expanded_roster.clear();
        self.copied.clear();
        self.releasing.clear();
        self.released.clear();
        self.fleet_row_errors.clear();
        self.overviews.clear();
        self.session_titles.clear();
        self.goals.clear();
        self.overview_needs_sign_in = false;
        self.activity.clear();
        self.spawn_cap = Default::default();
        self.incoming = None;
        self.incoming_pending.clear();
        self.incoming_error = None;
        self.connect_requested = false;
        self.renew_requested = false;
        self.workspace_connect_error = None;
        self.page = Page::Agents;
        self.agent_scope = AgentScope::All;
        self.agents_machine.clear();
        self.team_machine.clear();
        self.team_pick = TeamPick::Everyone;
        self.page_error = None;
    }
}
