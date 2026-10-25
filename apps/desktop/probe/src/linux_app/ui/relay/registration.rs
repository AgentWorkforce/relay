//! Registering a session under a name and renaming an agent: the name
//! shows at once, and goes back if the core refuses.
use super::*;
use crate::relay::agents::Registered;

impl App {
    /// Shows the agent `name` renamed to `alias` at once, in the agents
    /// and in its session's registration; returns the alias it had, for
    /// `revert_rename`.
    pub(crate) fn show_rename(&self, name: &str, alias: &str) -> Option<String> {
        let previous = self.update_state(|state| {
            let mut previous = None;
            for agent in state
                .local_agents
                .iter_mut()
                .filter(|agent| agent.name == name)
            {
                previous = agent.alias.replace(alias.to_string());
            }
            for registration in state
                .local_sessions
                .iter_mut()
                .filter_map(|session| session.registration.as_mut())
                .filter(|registration| registration.name == name)
            {
                registration.alias = Some(alias.to_string());
            }
            previous
        });
        self.relay_changed();
        previous
    }

    /// The rename of `name` to `alias` was refused: wherever that alias is
    /// still shown, the one before it comes back.
    pub(crate) fn revert_rename(&self, name: &str, alias: &str, previous: Option<String>) {
        self.update_state(|state| {
            for agent in state
                .local_agents
                .iter_mut()
                .filter(|agent| agent.name == name && agent.alias.as_deref() == Some(alias))
            {
                agent.alias = previous.clone();
            }
            for registration in state
                .local_sessions
                .iter_mut()
                .filter_map(|session| session.registration.as_mut())
                .filter(|registration| {
                    registration.name == name && registration.alias.as_deref() == Some(alias)
                })
            {
                registration.alias = previous.clone();
            }
        });
        self.relay_changed();
    }

    /// Puts a session on the relay under `name`. The row reads as on the
    /// relay under that name at once, with a provisional registration (no
    /// address yet) until the core answers.
    pub fn register_session_with_name(&self, target: Target, name: String) {
        let name = name.trim().trim_matches('@').to_lowercase();
        if name.is_empty() {
            return;
        }
        if self.session_hidden(&target.upload_key().unwrap_or_else(|| target.key())) {
            return;
        }
        let key = target.key();
        if self.update_state(|state| !state.busy_targets.insert(key.clone())) {
            return;
        }
        let provisional = SessionRegistration {
            name: name.clone(),
            ..Default::default()
        };
        self.update_state(|state| {
            state.held_sections.entry(key.clone()).or_insert(false);
            state.relay_errors.remove(&key);
            if let Some(session) = state
                .local_sessions
                .iter_mut()
                .find(|session| session.target.key() == key && session.registration.is_none())
            {
                session.registration = Some(provisional.clone());
            }
        });
        self.relay_changed();
        let registered_target = target.clone();
        self.view_call::<method::AgentsRegister>(
            RegisterParams {
                target,
                name: Some(name),
                description: None,
            },
            move |app, result| match result {
                Ok(registered) => app.registered(key, registered_target, registered),
                Err(error) => app.registration_refused(&key, &provisional, error),
            },
        );
    }

    /// The core refused the registration: only the provisional
    /// registration goes back, and the row says why.
    fn registration_refused(&self, key: &str, provisional: &SessionRegistration, error: CoreError) {
        self.update_state(|state| {
            state.busy_targets.remove(key);
            state.wanted.remove(key);
            state.relay_errors.insert(key.to_string(), error.message);
            if let Some(session) = state
                .local_sessions
                .iter_mut()
                .find(|session| session.target.key() == key)
            {
                if session.registration.as_ref() == Some(provisional) {
                    session.registration = None;
                }
            }
        });
        self.relay_changed();
    }

    /// The core registered the session: its registration is kept even if
    /// the follow-up list fails, so a queued off request can still
    /// unregister this agent, and the target stays busy until its
    /// authoritative registration is read.
    fn registered(&self, key: String, target: Target, registered: Registered) {
        self.update_state(|state| {
            if let Some(session) = state
                .local_sessions
                .iter_mut()
                .find(|session| session.target.key() == key)
            {
                let previous = registered
                    .already_registered
                    .then(|| session.registration.clone())
                    .flatten()
                    .unwrap_or_default();
                session.registration = Some(SessionRegistration {
                    name: registered.name,
                    address: registered.address,
                    ..previous
                });
            }
        });
        let read = self.update_state(|state| {
            state.local_reads += 1;
            state.local_reads
        });
        let title_revision = self.with_state(|state| state.title_write_revision);
        self.view_call::<method::SessionsList>(NoParams {}, move |app, result| {
            match result {
                Ok(listed) => {
                    app.apply_local_after_title_write(read, title_revision, listed.sessions)
                }
                Err(error) => app.update_state(|state| {
                    state.relay_errors.insert(key.clone(), error.message);
                }),
            }
            // Honor an off/hide requested during the registration.
            if app.with_state(|state| state.wanted.contains_key(&key)) {
                app.drive(key, target);
            } else {
                app.update_state(|state| {
                    state.busy_targets.remove(&key);
                    state.settle();
                });
                app.relay_changed();
            }
            app.refresh_agents();
        });
    }
}
