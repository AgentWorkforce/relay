//! Agent names in words: one name per session. A rename replaces it; the
//! earlier name only forwards messages already sent to it.

use crate::relay::contract::agents::{LocalAgent, Renamed, SessionRegistration};

/// The name an agent is shown by: the name it was renamed to, else the
/// name it was registered with.
pub fn agent_display_name<'a>(name: &'a str, alias: Option<&'a str>) -> &'a str {
    alias.unwrap_or(name)
}

/// What a renamed agent's name means, on hover. `None` for one never
/// renamed.
pub fn alias_detail(name: &str, alias: Option<&str>) -> Option<String> {
    alias.map(|alias| {
        format!("Renamed from @{name}. Only @{alias} is shown and replies come from it; messages still sent to @{name} arrive here.")
    })
}

/// The note beneath an agent's rename field.
pub fn rename_note(name: &str, alias: Option<&str>) -> String {
    match alias {
        Some(alias) => format!(
            "Renamed from @{name}, which only forwards messages sent to it. Renaming again replaces @{alias}, which keeps forwarding for 24 hours."
        ),
        None => format!(
            "Renaming replaces this name: only the new one is shown, and replies come from it. Messages already sent to @{name} still arrive."
        ),
    }
}

/// What a rename did, from the agent's name, the alias it had and the name
/// asked for.
pub fn renamed_message(name: &str, previous_alias: Option<&str>, requested: &str) -> String {
    let now = if requested == name { "Back to" } else { "Now" };
    match previous_alias {
        None if requested == name => format!("Back to @{name}."),
        None => format!("Now @{requested}. Messages already sent to @{name} still arrive."),
        Some(previous) => {
            format!("{now} @{requested}. Messages sent to @{previous} still arrive for 24 hours.")
        }
    }
}

/// An agent's name and, once renamed, its alias: what rename surfaces show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentName {
    pub name: String,
    pub alias: Option<String>,
}

impl AgentName {
    pub fn of(agent: &LocalAgent) -> AgentName {
        AgentName {
            name: agent.name.clone(),
            alias: agent.alias.clone(),
        }
    }

    pub fn shown(&self) -> &str {
        agent_display_name(&self.name, self.alias.as_deref())
    }

    pub fn note(&self) -> String {
        rename_note(&self.name, self.alias.as_deref())
    }

    /// What renaming to `requested` did.
    pub fn renamed(&self, requested: &str) -> String {
        renamed_message(&self.name, self.alias.as_deref(), requested)
    }
}

impl Renamed {
    /// What the rename of the agent `original` did, worded from this answer:
    /// the alias it actually released.
    pub fn outcome(&self, original: &str) -> String {
        renamed_message(original, self.released.as_deref(), &self.name)
    }
}

impl LocalAgent {
    /// The name the agent is shown by: its alias once renamed.
    pub fn display_name(&self) -> &str {
        agent_display_name(&self.name, self.alias.as_deref())
    }
}

impl SessionRegistration {
    /// The name the agent is shown by: its alias once renamed.
    pub fn display_name(&self) -> &str {
        agent_display_name(&self.name, self.alias.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_renamed_agent_is_shown_by_its_alias_and_explains_its_name() {
        assert_eq!(agent_display_name("codex-api", None), "codex-api");
        assert_eq!(
            agent_display_name("codex-api", Some("reviewer")),
            "reviewer"
        );
        assert_eq!(alias_detail("codex-api", None), None);
        assert_eq!(
            alias_detail("codex-api", Some("reviewer")).unwrap(),
            "Renamed from @codex-api. Only @reviewer is shown and replies come from it; messages still sent to @codex-api arrive here."
        );
        assert_eq!(
            rename_note("codex-api", None),
            "Renaming replaces this name: only the new one is shown, and replies come from it. Messages already sent to @codex-api still arrive."
        );
        assert_eq!(
            rename_note("codex-api", Some("reviewer")),
            "Renamed from @codex-api, which only forwards messages sent to it. Renaming again replaces @reviewer, which keeps forwarding for 24 hours."
        );
        assert_eq!(
            renamed_message("codex-api", None, "reviewer"),
            "Now @reviewer. Messages already sent to @codex-api still arrive."
        );
        assert_eq!(
            renamed_message("codex-api", Some("reviewer"), "lead"),
            "Now @lead. Messages sent to @reviewer still arrive for 24 hours."
        );
        assert_eq!(
            renamed_message("codex-api", Some("reviewer"), "codex-api"),
            "Back to @codex-api. Messages sent to @reviewer still arrive for 24 hours."
        );
    }
}
