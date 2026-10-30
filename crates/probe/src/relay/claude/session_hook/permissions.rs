//! The Claude Code permission rules that come with the SessionStart hook.
//!
//! A relayed message reaches a Claude Code session as a pointer whose read
//! command (`<probe> relay read --socket <socket> <ref>`) prints the message
//! and its reply command (`<probe> relay send --socket <socket> --to …
//! --reply-to … --body '<reply>'`). In Claude Code's default ("manual")
//! permission mode each of those asked for approval. With the hook, Agent
//! Relay adds `permissions.allow` rules to the same user `settings.json` for
//! exactly the commands a relayed message hands the session, each only for
//! this probe on this core's own session socket:
//!
//! ```text
//! Bash(<probe> relay read --socket <socket> *)
//! Bash(<probe> relay send --socket <socket> *)
//! Bash(<probe> relay connect-send --socket <socket> *)
//! Bash(<probe> relay fetch-attachment --socket <socket> *)
//! Bash(<probe> relay agents --socket <socket>)
//! Bash(<probe> relay whoami --socket <socket>)
//! ```
//!
//! That is: read a message handed to this session, reply (a DM, a channel
//! thread or a Relay Connect room), fetch an attachment it was sent, and
//! list who it can message and who it is. These are the same self-limiting commands
//! Codex's sandbox rules allow (`session_cli`): each fixes its own method
//! and route and checks every other argument, so nothing after the `*`
//! reaches another route. Every other session route (`/register`,
//! `PATCH /settings`, `/integrations/subscribe`, …) is reached only through
//! `relay socket-request`, which no rule allows, so it still asks.
//!
//! Claude Code matches the text before a rule's `*` as written, after it
//! splits compound commands and strips a few wrappers (verified against
//! Claude Code 2.1.314): the probe and socket are written exactly as the
//! hints quote them (`outbound::shell_quote`), so a socket under
//! `Application Support` is the single-quoted form the hints hand out.
//! A double-quoted or backslash-escaped spelling, another socket, another
//! program, or anything chained after the command (`&&`, `;`, `|`, `$(…)`
//! outside single quotes) still asks. The socket answers only the calling
//! session's own requests, and `relay read --socket` refuses `--dev`.
//!
//! Which rules Agent Relay added is recorded in the core's data folder
//! ([`RECORD`]), so turning the hook off takes out only those: a rule the
//! person had already, even an identical one, is theirs and stays.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The record, in the core's data folder, of the rules Agent Relay added,
/// by settings file.
pub const RECORD: &str = "claude-permission-rules.json";

/// The probe and session socket the rules allow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionRules {
    /// The probe executable the reply hints and pointers name.
    pub probe: PathBuf,
    /// The relay-send (session) socket this core serves.
    pub socket: PathBuf,
}

impl PermissionRules {
    /// The rules, or none when a path cannot be written into one: not
    /// UTF-8, or holding `*` (a rule's wildcard) or a parenthesis (which
    /// ends it).
    pub fn rules(&self) -> Vec<String> {
        let quoted = |path: &Path| path.to_str().map(crate::relay::outbound::shell_quote);
        let (Some(probe), Some(socket)) = (quoted(&self.probe), quoted(&self.socket)) else {
            return Vec::new();
        };
        if [&probe, &socket]
            .iter()
            .any(|part| part.contains(['*', '(', ')']))
        {
            return Vec::new();
        }
        let command = |name: &str| format!("{probe} relay {name} --socket {socket}");
        vec![
            format!("Bash({} *)", command("read")),
            // A reply: a DM or a channel thread (`outbound::reply_hint`,
            // `channels::channel_reply_command`).
            format!("Bash({} *)", command("send")),
            // A reply in a Relay Connect room (`connect::connect_reply_line`).
            format!("Bash({} *)", command("connect-send")),
            // An attachment this session was sent (`outbound::fetch_hint`).
            format!("Bash({} *)", command("fetch-attachment")),
            // The `[agents: …]` line.
            format!("Bash({})", command("agents")),
            // The session's own name (`session_hook::joining`).
            format!("Bash({})", command("whoami")),
        ]
    }
}

/// Whether Claude Code would let `rule` run `command` with no prompt, as it
/// matches a single command (no compound): the text before a trailing `*`
/// as written, else the whole command. For tests of what the hints hand out.
#[cfg(test)]
pub fn covers(rule: &str, command: &str) -> bool {
    let Some(pattern) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
        return false;
    };
    match pattern.strip_suffix('*') {
        Some(prefix) => {
            command.starts_with(prefix)
                || prefix.strip_suffix(' ').is_some_and(|bare| command == bare)
        }
        None => command == pattern,
    }
}

/// The rules Agent Relay added, by settings file (the path as the hook
/// names it).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Added(pub BTreeMap<String, Vec<String>>);

impl Added {
    /// The record in `state_dir`; empty when there is none or it is
    /// unreadable.
    pub fn load(state_dir: &Path) -> Added {
        std::fs::read(state_dir.join(RECORD))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .map(Added)
            .unwrap_or_default()
    }

    /// Saves the record privately; no file once it is empty.
    pub fn save(&self, state_dir: &Path) -> Result<(), String> {
        let path = state_dir.join(RECORD);
        let failed = || "Agent Relay's record of its Claude permission rules cannot be saved.";
        let entries: BTreeMap<_, _> = self.0.iter().filter(|(_, r)| !r.is_empty()).collect();
        if entries.is_empty() {
            return match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(failed().into()),
                _ => Ok(()),
            };
        }
        let mut bytes = serde_json::to_vec_pretty(&entries).map_err(|_| failed().to_string())?;
        bytes.push(b'\n');
        crate::relay::claude_settings::write_keeping_file(&path, None, &bytes, "", 0o600)
            .map_err(|_| failed().into())
    }

    /// The rules added to `file`.
    pub fn of(&self, file: &Path) -> &[String] {
        self.0
            .get(&file.to_string_lossy().into_owned())
            .map_or(&[], Vec::as_slice)
    }

    pub fn set(&mut self, file: &Path, rules: Vec<String>) {
        self.0.insert(file.to_string_lossy().into_owned(), rules);
    }

    /// Every rule in both records, by file: what may be in a file while an
    /// edit is being written.
    pub fn union(&self, other: &Added) -> Added {
        let mut all = self.0.clone();
        for (file, rules) in &other.0 {
            let entry = all.entry(file.clone()).or_default();
            for rule in rules {
                if !entry.contains(rule) {
                    entry.push(rule.clone());
                }
            }
        }
        Added(all)
    }
}

/// Puts `rules` in `object`'s `permissions.allow`, and takes out the ones
/// Agent Relay added before that are no longer wanted (an app that moved, a
/// socket that changed). Returns the rules Agent Relay now owns in the file:
/// a rule already there that it did not add is the person's, and is
/// neither added again nor owned.
pub fn add(
    object: &mut Map<String, Value>,
    rules: &[String],
    added_before: &[String],
) -> Result<Vec<String>, &'static str> {
    let permissions = object
        .entry("permissions")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(permissions) = permissions.as_object_mut() else {
        return Err("has a permissions value that is not an object, so it was left unchanged");
    };
    let allow = permissions
        .entry("allow")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(allow) = allow.as_array_mut() else {
        return Err("has a permissions.allow value that is not a list, so it was left unchanged");
    };
    let stale: Vec<&String> = added_before
        .iter()
        .filter(|rule| !rules.contains(rule))
        .collect();
    allow.retain(|rule| !rule.as_str().is_some_and(|r| stale.iter().any(|s| *s == r)));
    let mut owned = Vec::new();
    for rule in rules {
        let present = allow.iter().any(|r| r.as_str() == Some(rule));
        if !present {
            allow.push(Value::String(rule.clone()));
            owned.push(rule.clone());
        } else if added_before.contains(rule) {
            owned.push(rule.clone());
        }
    }
    tidy(object);
    Ok(owned)
}

/// Takes the rules Agent Relay added out of `object`; an `allow` list or
/// `permissions` object that leaves empty goes too. Whether anything
/// changed.
pub fn take_out(object: &mut Map<String, Value>, added: &[String]) -> bool {
    let Some(allow) = object
        .get_mut("permissions")
        .and_then(Value::as_object_mut)
        .and_then(|permissions| permissions.get_mut("allow"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let before = allow.len();
    allow.retain(|rule| !rule.as_str().is_some_and(|r| added.iter().any(|a| a == r)));
    if allow.len() == before {
        return false;
    }
    tidy(object);
    true
}

/// Removes an empty `permissions.allow`, then an empty `permissions`.
fn tidy(object: &mut Map<String, Value>) {
    if let Some(permissions) = object.get_mut("permissions").and_then(Value::as_object_mut) {
        if permissions
            .get("allow")
            .is_some_and(|allow| allow.as_array().is_some_and(Vec::is_empty))
        {
            permissions.remove("allow");
        }
    }
    if object
        .get("permissions")
        .is_some_and(|permissions| permissions.as_object().is_some_and(Map::is_empty))
    {
        object.remove("permissions");
    }
}

/// `value` without what adding and taking out the hook and its rules make
/// or drop on their own: an empty `SessionStart` list, `hooks` object,
/// `permissions.allow` list or `permissions` object. Two files equal this
/// way differ in nothing the person set.
pub fn without_empty(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        if let Some(hooks) = object.get_mut("hooks").and_then(Value::as_object_mut) {
            if hooks
                .get("SessionStart")
                .is_some_and(|groups| groups.as_array().is_some_and(Vec::is_empty))
            {
                hooks.remove("SessionStart");
            }
        }
        if object
            .get("hooks")
            .is_some_and(|hooks| hooks.as_object().is_some_and(Map::is_empty))
        {
            object.remove("hooks");
        }
        tidy(object);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> PermissionRules {
        PermissionRules {
            probe: PathBuf::from("/tmp/r/bin/agent-relay-probe"),
            socket: PathBuf::from("/Users/me/Library/Application Support/x/run/relay.sock"),
        }
    }

    #[test]
    fn the_rules_name_only_this_probe_and_socket_as_the_hints_quote_them() {
        let all = rules().rules();
        let on = "--socket '/Users/me/Library/Application Support/x/run/relay.sock'";
        let probe = "/tmp/r/bin/agent-relay-probe";
        assert_eq!(
            all,
            vec![
                format!("Bash({probe} relay read {on} *)"),
                format!("Bash({probe} relay send {on} *)"),
                format!("Bash({probe} relay connect-send {on} *)"),
                format!("Bash({probe} relay fetch-attachment {on} *)"),
                format!("Bash({probe} relay agents {on})"),
                format!("Bash({probe} relay whoami {on})"),
            ]
        );
        // The text before the read's `*` is exactly how the pointer's read
        // begins.
        let socket = rules().socket;
        let read =
            crate::relay::message_pointer::socket_reader(Some(&rules().probe), &socket).unwrap();
        assert!(covers(&all[0], &format!("{read} 0123456789ab")));
    }

    // Review on #2021: a relayed message must not get any other session
    // route run without a prompt. Every allowed command fixes its own
    // route (`session_cli`); `socket-request` has no rule.
    #[test]
    fn no_other_session_route_is_allowed() {
        let all = rules().rules();
        let probe = "/tmp/r/bin/agent-relay-probe";
        let on = "--socket '/Users/me/Library/Application Support/x/run/relay.sock'";
        let allowed = |command: &str| all.iter().any(|rule| covers(rule, command));
        for command in [
            format!("{probe} relay send {on} --to a --reply-to m1 --body 'x'"),
            format!("{probe} relay send {on} --channel c --thread 1 --body 'x'"),
            format!("{probe} relay connect-send {on} --to host --body 'x'"),
            format!("{probe} relay fetch-attachment {on} f1"),
            format!("{probe} relay agents {on}"),
            format!("{probe} relay whoami {on}"),
            format!("{probe} relay read {on} 0123456789ab"),
        ] {
            assert!(allowed(&command), "{command}");
        }
        let request = format!("{probe} relay socket-request {on}");
        for (method, path) in [
            ("POST", "'/send?to=a'"),
            ("GET", "/agents"),
            ("POST", "/register"),
            ("DELETE", "/register"),
            ("PATCH", "/settings"),
            ("GET", "/settings"),
            ("POST", "/integrations/subscribe"),
            ("DELETE", "/integrations/subscribe"),
            ("POST", "/connect/leave"),
            ("DELETE", "/connect/join"),
            ("GET", "/whoami"),
            ("GET", "'/messages?ref=0123456789ab'"),
        ] {
            assert!(
                !allowed(&format!("{request} --method {method} --path {path}")),
                "{method} {path}"
            );
        }
        for command in [
            format!("{probe} relay settings {on} auto_join_general=true"),
            format!("{probe} relay subscribe {on} acme/api#1"),
            format!("{probe} relay agents {on} --body x"),
            // Another socket.
            format!("{probe} relay send --socket /tmp/other.sock --to a --body x"),
            format!("{probe} relay send {on}x --to a --body x"),
        ] {
            assert!(!allowed(&command), "{command}");
        }
    }

    #[test]
    fn a_path_that_cannot_be_written_into_a_rule_gives_no_rules() {
        for probe in ["/a*b/probe", "/a(b)/probe"] {
            let rules = PermissionRules {
                probe: PathBuf::from(probe),
                socket: PathBuf::from("/s/relay.sock"),
            };
            assert!(rules.rules().is_empty(), "{probe}");
        }
        // A quote is fine: it is quoted the way the hints quote it.
        let rules = PermissionRules {
            probe: PathBuf::from("/Apps/Bob's Relay/probe"),
            socket: PathBuf::from("/s/relay.sock"),
        };
        assert_eq!(rules.rules().len(), 6);
    }

    #[test]
    fn the_persons_own_rules_are_neither_owned_nor_taken_out() {
        let ours = rules().rules();
        let mut object = json!({
            "permissions": {"allow": ["Bash(npm test *)", ours[0].clone()], "deny": ["Bash(rm *)"]}
        })
        .as_object()
        .unwrap()
        .clone();
        let owned = add(&mut object, &ours, &[]).unwrap();
        assert_eq!(owned, ours[1..]);
        let mut expected = vec![json!("Bash(npm test *)")];
        expected.extend(ours.iter().map(|rule| json!(rule)));
        assert_eq!(object["permissions"]["allow"], Value::Array(expected));
        assert!(take_out(&mut object, &owned));
        assert_eq!(
            Value::Object(object),
            json!({"permissions": {"allow": ["Bash(npm test *)", ours[0]], "deny": ["Bash(rm *)"]}})
        );
    }

    #[test]
    fn stale_rules_agent_relay_added_are_replaced() {
        let old = vec!["Bash(/old/probe relay read --socket /s *)".to_string()];
        let ours = rules().rules();
        let mut object = json!({"permissions": {"allow": [old[0].clone(), "Bash(ls *)"]}})
            .as_object()
            .unwrap()
            .clone();
        let owned = add(&mut object, &ours, &old).unwrap();
        assert_eq!(owned, ours);
        let mut expected = vec![json!("Bash(ls *)")];
        expected.extend(ours.iter().map(|rule| json!(rule)));
        assert_eq!(object["permissions"]["allow"], Value::Array(expected));
        // Added again: nothing changes, and all stay owned.
        let again = add(&mut object, &ours, &owned).unwrap();
        assert_eq!(again, ours);
        assert_eq!(
            object["permissions"]["allow"].as_array().unwrap().len(),
            ours.len() + 1
        );
    }

    #[test]
    fn taking_out_the_only_rules_leaves_no_permissions() {
        let ours = rules().rules();
        let mut object = Map::new();
        let owned = add(&mut object, &ours, &[]).unwrap();
        assert!(take_out(&mut object, &owned));
        assert!(object.is_empty(), "{object:?}");
        assert!(!take_out(&mut object, &owned));
    }

    #[test]
    fn a_permissions_value_of_another_shape_is_refused() {
        let ours = rules().rules();
        for bad in [
            json!({"permissions": []}),
            json!({"permissions": {"allow": "x"}}),
        ] {
            let mut object = bad.as_object().unwrap().clone();
            assert!(add(&mut object, &ours, &[]).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_record_keeps_only_files_with_rules() {
        let dir = tempfile::tempdir().unwrap();
        let mut added = Added::default();
        added.set(Path::new("/h/.claude/settings.json"), rules().rules());
        added.set(Path::new("/h/.claude-work/settings.json"), Vec::new());
        added.save(dir.path()).unwrap();
        let loaded = Added::load(dir.path());
        assert_eq!(
            loaded.of(Path::new("/h/.claude/settings.json")),
            rules().rules()
        );
        assert!(loaded
            .of(Path::new("/h/.claude-work/settings.json"))
            .is_empty());
        Added::default().save(dir.path()).unwrap();
        assert!(!dir.path().join(RECORD).exists());
    }
}
