//! What the window shows before the core confirms a change: the settings
//! with pending changes written over them, and the upload stage action
//! asked for. A failure that only said the core could not be reached stops
//! being true once the core answers: it clears without anyone dismissing it,
//! and a retry or compact the core never received is sent then, as on the
//! Mac (`AppModel.coreAnswered`).
use super::*;
use crate::linux_app::bridge::CoreError;
use crate::linux_app::models::StageAction;

impl State {
    /// The stage action the person asked for, until the uploader answers.
    pub fn pending_stage_action(&self) -> Option<StageAction> {
        self.pending_upload_action
    }

    // Settings as shown while changes are on their way.

    /// Records a change to show at once; returns its token.
    pub fn begin_setting(&mut self, change: SettingsChange) -> u64 {
        self.settings_write_token = self.settings_write_token.wrapping_add(1);
        self.pending_settings
            .push((self.settings_write_token, change));
        self.show_settings();
        self.settings_write_token
    }

    /// The change `token` was answered. The latest one's answer becomes the
    /// confirmed values; an older answer may predate a newer write still on
    /// its way, so only its own change joins them.
    pub fn finish_setting(&mut self, token: u64, confirmed: Option<SettingsValues>) {
        let change = self
            .pending_settings
            .iter()
            .find(|(pending, _)| *pending == token)
            .map(|(_, change)| change.clone());
        self.pending_settings
            .retain(|(pending, _)| *pending != token);
        match (confirmed, change) {
            (Some(confirmed), _) if token == self.settings_write_token => {
                self.confirmed_settings = Some(confirmed);
            }
            (Some(_), Some(change)) => {
                self.confirmed_settings = self
                    .confirmed_settings
                    .as_ref()
                    .map(|values| apply_settings_change(values, &change));
            }
            _ => {}
        }
        self.show_settings();
    }

    /// Starting at login as asked for, else as the system reports it.
    pub fn login_item_shown(&self) -> Option<bool> {
        match (self.login_item, self.login_item_wanted.wanted()) {
            (_, Some(wanted)) => Some(*wanted),
            (confirmed, None) => confirmed,
        }
    }

    /// The `incoming.status` read `read` answered.
    pub fn incoming_read(&mut self, read: u64, status: IncomingStatus) {
        self.incoming_pending.read(read, status);
        self.sync_incoming();
    }

    /// Shows the Incoming status under the changes on their way.
    pub fn sync_incoming(&mut self) {
        self.incoming = self.incoming_pending.shown();
    }

    /// The `claude_delivery.status` read `read` answered.
    pub fn claude_delivery_read(&mut self, read: u64, status: ClaudeDeliveryStatus) {
        self.claude_delivery_pending.read(read, status);
        self.sync_claude_delivery();
    }

    /// Shows the Claude delivery status under the changes on their way.
    pub fn sync_claude_delivery(&mut self) {
        self.claude_delivery = self.claude_delivery_pending.shown();
    }

    /// `settings.get` answered.
    pub fn settings_read(&mut self, values: SettingsValues) {
        self.confirmed_settings = Some(values);
        self.show_settings();
    }

    /// Whether a change to the setting `field` (its snake_case key) is on
    /// its way.
    pub fn setting_pending(&self, field: &str) -> bool {
        self.pending_settings.iter().any(|(_, change)| {
            crate::linux_app::models::settings_change_fields(change)
                .iter()
                .any(|key| key == field)
        })
    }

    fn show_settings(&mut self) {
        self.settings = self.confirmed_settings.as_ref().map(|confirmed| {
            self.pending_settings
                .iter()
                .fold(confirmed.clone(), |values, (_, change)| {
                    apply_settings_change(&values, change)
                })
        });
    }
}

impl State {
    /// The upload policy as asked for, until the uploader answers.
    pub fn sharing_mode(&self) -> Option<SharingMode> {
        self.status
            .as_ref()
            .map(|status| self.sharing_mode_wanted.shown(status.sharing_mode))
    }

    /// Forgets a wanted state the relay has reached.
    pub fn settle(&mut self) {
        let reached: Vec<String> = self
            .wanted
            .iter()
            .filter(|(key, on)| {
                !self.busy_targets.contains(*key)
                    && self
                        .local_sessions
                        .iter()
                        .find(|session| &session.target.key() == *key)
                        .is_none_or(|session| session.registration.is_some() == **on)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in reached {
            self.wanted.remove(&key);
        }
    }
}

#[cfg(test)]
mod pending_tests {
    use super::*;
    use crate::relay::contract::agents::SettingsChange;
    use serde_json::json;

    fn values(allow: bool) -> SettingsValues {
        serde_json::from_value(json!({"allow_self_registration": allow, "auto_activate": true}))
            .unwrap()
    }

    #[test]
    fn a_settings_change_shows_at_once_and_only_the_latest_answer_confirms() {
        let mut state = State::new(InstallKind::Source);
        state.settings_read(values(true));
        let first = state.begin_setting(SettingsChange {
            allow_self_registration: Some(false),
            ..Default::default()
        });
        assert!(state.setting_pending("allow_self_registration"));
        assert!(!state.setting_pending("auto_activate"));
        assert!(!state.settings.as_ref().unwrap().allow_self_registration);
        let second = state.begin_setting(SettingsChange {
            allow_self_registration: Some(true),
            ..Default::default()
        });
        // The first answer arrives late, carrying values from before the
        // second write: only its own change joins the confirmed values,
        // and the second still shows over them.
        state.finish_setting(first, Some(values(false)));
        assert!(state.settings.as_ref().unwrap().allow_self_registration);
        assert!(
            !state
                .confirmed_settings
                .as_ref()
                .unwrap()
                .allow_self_registration
        );
        state.finish_setting(second, Some(values(true)));
        assert!(state.pending_settings.is_empty());
        assert!(state.settings.as_ref().unwrap().allow_self_registration);
        // A first change the core took is kept when a newer one is refused.
        let kept = state.begin_setting(SettingsChange {
            auto_activate: Some(false),
            ..Default::default()
        });
        let refused = state.begin_setting(SettingsChange {
            allow_self_registration: Some(false),
            ..Default::default()
        });
        state.finish_setting(refused, None);
        state.finish_setting(kept, Some(values(true)));
        assert!(state.pending_settings.is_empty());
        assert!(!state.settings.as_ref().unwrap().auto_activate);
        assert!(state.settings.as_ref().unwrap().allow_self_registration);
        // A refusal takes its change off, and the switch falls back.
        let third = state.begin_setting(SettingsChange {
            allow_self_registration: Some(false),
            ..Default::default()
        });
        state.finish_setting(third, None);
        assert!(state.settings.as_ref().unwrap().allow_self_registration);
        assert!(!state.setting_pending("allow_self_registration"));
    }

    #[test]
    fn a_provisional_registration_reads_as_on_its_way_on() {
        let mut state = State::new(InstallKind::Source);
        let mut session: LocalSession = serde_json::from_value(json!({
            "target": {"kind": "codex", "id": "one"}, "title": "Fix login", "project": null,
            "directory": null, "live": true, "updated_at_ms": null, "registration": null,
            "suggested_name": "codex-fix-login"
        }))
        .unwrap();
        let key = session.target.key();
        state.busy_targets.insert(key.clone());
        // Busy with no registration yet: turning on.
        assert!(state.presence_of(&session).is_changing());
        session.registration = Some(crate::relay::contract::agents::SessionRegistration {
            name: "fix-login".into(),
            ..Default::default()
        });
        // Provisionally registered while busy: on, never leaving.
        let presence = state.presence_of(&session);
        assert!(presence.is_on());
        assert!(!presence.is_changing());
        state.busy_targets.clear();
        // A paused pause-wanted shows at once over the status.
        assert!(!state.is_paused());
        state.paused_wanted.begin(true);
        assert!(state.is_paused());
        state.connection_interrupted();
        assert!(!state.is_paused());
    }
}

impl State {
    /// Record how an upload stage action ended. One the core never received
    /// is sent again once it answers, at most once per click: `automatic`
    /// marks that second send. Both actions are idempotent.
    pub(crate) fn upload_action_finished(
        &mut self,
        action: StageAction,
        error: Option<CoreError>,
        automatic: bool,
    ) {
        self.unsent_upload_action = error
            .as_ref()
            .filter(|error| error.never_sent())
            .map(|_| (action, !automatic));
        self.upload_action_error = error.map(|error| error.message);
    }

    /// The core answered a call. Failures that only said it could not be
    /// reached clear; failures from calls that reached it keep their message
    /// until the next action. Returns the stage action to send again now.
    pub(crate) fn core_answered(&mut self) -> Option<StageAction> {
        if self
            .upload_action_error
            .as_deref()
            .is_some_and(CoreError::never_sent_message)
        {
            self.upload_action_error = None;
        }
        self.upload_errors
            .retain(|_, error| !CoreError::never_sent_message(error));
        // Another change is under way: the next answer sends it instead.
        if self.busy || self.pending_upload_action.is_some() {
            return None;
        }
        let (action, replay) = self.unsent_upload_action.take()?;
        replay.then_some(action)
    }
}

#[cfg(test)]
mod unsent_tests {
    use super::*;
    use crate::linux_app::bridge::Failure;
    use crate::linux_app::install::InstallKind;

    fn reconnecting() -> CoreError {
        CoreError {
            failure: Failure::Unavailable,
            message:
                "Agent Relay is reconnecting to its background service. Try again in a moment."
                    .into(),
            retryable: true,
        }
    }

    #[test]
    fn a_retry_that_never_reached_the_core_clears_and_is_sent_once_it_answers() {
        let mut state = State::new(InstallKind::Source);
        for error in [CoreError::unavailable(), reconnecting()] {
            assert!(error.never_sent());
            state.upload_action_finished(StageAction::Retry, Some(error), false);
            assert!(state.upload_action_error.is_some());
            state
                .upload_errors
                .insert("codex:a".into(), CoreError::unavailable().message);
            assert_eq!(state.core_answered(), Some(StageAction::Retry));
            assert_eq!(state.upload_action_error, None);
            assert!(state.upload_errors.is_empty());
            // Sent once: the next answer sends nothing more.
            assert_eq!(state.core_answered(), None);
        }

        // The automatic send failing the same way clears, but is not sent a
        // third time.
        state.upload_action_finished(StageAction::Compact, Some(reconnecting()), true);
        assert_eq!(state.core_answered(), None);
        assert_eq!(state.upload_action_error, None);
    }

    #[test]
    fn a_failure_from_the_core_keeps_its_message_and_is_not_sent_again() {
        let mut state = State::new(InstallKind::Source);
        for error in [
            CoreError::interrupted(),
            CoreError {
                failure: Failure::Unavailable,
                message: "The background service took too long to respond. Try again.".into(),
                retryable: true,
            },
            CoreError {
                failure: Failure::Core(crate::relay::protocol::ErrorKind::Internal),
                message: "The upload service refused the batch.".into(),
                retryable: false,
            },
        ] {
            assert!(!error.never_sent(), "{}", error.message);
            let message = error.message.clone();
            state.upload_action_finished(StageAction::Retry, Some(error), false);
            state
                .upload_errors
                .insert("codex:a".into(), message.clone());
            assert_eq!(state.core_answered(), None);
            assert_eq!(state.upload_action_error.as_deref(), Some(message.as_str()));
            assert_eq!(state.upload_errors.len(), 1);
        }
        // A success clears nothing to send.
        state.upload_action_finished(StageAction::Retry, None, false);
        assert_eq!(state.core_answered(), None);
    }

    #[test]
    fn an_unsent_action_waits_while_another_change_runs() {
        let mut state = State::new(InstallKind::Source);
        state.upload_action_finished(StageAction::Retry, Some(CoreError::unavailable()), false);
        state.busy = true;
        assert_eq!(state.core_answered(), None);
        assert_eq!(state.upload_action_error, None);
        state.busy = false;
        assert_eq!(state.core_answered(), Some(StageAction::Retry));
    }
}
