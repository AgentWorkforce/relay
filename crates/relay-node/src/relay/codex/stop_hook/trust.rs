//! Trusting Agent Relay's Codex hook as Codex's own `/hooks` review does,
//! through a short-lived `codex app-server`.

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub(super) mod live;

/// How long Codex's app-server is given to list or trust hooks.
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(15);

/// Trusts the hook running `command` in `codex_home` for each event, as
/// Codex's own `/hooks` review does: `hooks/list` gives each entry's key and
/// current hash, and `config/value/write` records those in `hooks.state`.
/// `installed` is the Codex the core found (`CodexConfig::executable`).
///
/// The question hook ([`QUESTION_EVENT`]) is trusted after the others, on
/// its own: one Codex does not list, or does not take, stays untrusted,
/// which Codex skips, so its questions are asked in the dialog as before
/// and message delivery is never held up by it.
pub(super) fn with_app_server(
    codex_home: &Path,
    command: &str,
    installed: Option<&Path>,
) -> Result<(), String> {
    let executable =
        codex_for_hooks(installed).ok_or("No Codex to trust the hook with was found.")?;
    let mut session = AppServer::open(&executable, codex_home)?;
    let listed = session.request("hooks/list", json!({"cwds": [codex_home]}))?;
    let (untrusted, question) = untrusted(&listed, command)?;
    if !untrusted.is_empty() {
        session.request("config/value/write", trust_write(untrusted))?;
    }
    if let Some(question) = question {
        if let Err(error) = session.request("config/value/write", trust_write(question)) {
            crate::relay::diagnostics::write(format_args!(
                "relay: Codex's question hook was not trusted; its questions are asked as usual: \
{error}"
            ));
        }
    }
    Ok(())
}

/// The `config/value/write` that records `entries` in `hooks.state`.
fn trust_write(entries: Map<String, Value>) -> Value {
    json!({
        "keyPath": "hooks.state",
        "mergeStrategy": "upsert",
        "value": entries,
    })
}

/// The delivery hooks' entries to trust, and apart from them the question
/// hook's, each by key with the hash to trust.
type Untrusted = (Map<String, Value>, Option<Map<String, Value>>);

/// The entries of the hook running `command` that `listed` (a `hooks/list`
/// answer) shows untrusted, by key, each with the hash to trust: those the
/// hook needs to deliver messages, and apart from them the question hook's.
/// A required event Codex does not list is an error; an optional one, or
/// the question hook, is left out.
fn untrusted(listed: &Value, command: &str) -> Result<Untrusted, String> {
    let pending = |hook: &Value| -> Result<Option<(String, Value)>, String> {
        if hook["trustStatus"] == "trusted" {
            return Ok(None);
        }
        let (Some(key), Some(hash)) = (hook["key"].as_str(), hook["currentHash"].as_str()) else {
            return Err("Codex lists Agent Relay's hook without a key or hash.".into());
        };
        Ok(Some((key.to_string(), json!({"trusted_hash": hash}))))
    };
    let mut untrusted = Map::new();
    for event in EVENTS {
        let Some(hook) = listed_hooks(listed, command).find(|hook| hook["eventName"] == event)
        else {
            // A Codex without SessionStart hooks still runs the others.
            if OPTIONAL_EVENTS.contains(&event) {
                continue;
            }
            return Err("Codex does not list Agent Relay's hook.".into());
        };
        if let Some((key, value)) = pending(hook)? {
            untrusted.insert(key, value);
        }
    }
    let question = listed_hooks(listed, command)
        .find(|hook| hook["eventName"] == QUESTION_EVENT)
        .and_then(|hook| pending(hook).ok().flatten())
        .map(|(key, value)| Map::from_iter([(key, value)]));
    Ok((untrusted, question))
}

/// The hook events trusted for message delivery, as `hooks/list` names
/// them.
const EVENTS: [&str; 3] = ["stop", "postToolUse", "sessionStart"];

/// The question hook's event, as `hooks/list` names it: trusted on its own
/// (`with_app_server`), and not needed for message delivery.
const QUESTION_EVENT: &str = "preToolUse";

/// Events trusted when Codex lists them: the hook delivers messages without
/// them, so a Codex that does not run them still has it trusted.
const OPTIONAL_EVENTS: [&str; 1] = ["sessionStart"];

/// The hooks `hooks/list` lists that run `command`.
fn listed_hooks<'a>(listed: &'a Value, command: &'a str) -> impl Iterator<Item = &'a Value> {
    listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .filter(move |hook| hook["command"] == command)
}

/// Takes the hook running `command` out of a Codex home with `edit`, and
/// the trust [`with_app_server`] recorded for it out of Codex's
/// `config.toml`: the hook's keys are listed while it is still in
/// `hooks.json`, `edit` takes it out, then those keys leave `hooks.state`,
/// and `hooks.state` (or `[hooks]`) goes too once nothing else is in it.
/// Other entries, the person's own trust included, stay as they are.
///
/// The trust is tidied as well as it can be: with no Codex to ask, or one
/// that does not answer, `edit` still runs and its outcome is returned.
pub(super) fn untrust_with_app_server(
    codex_home: &Path,
    command: &str,
    installed: Option<&Path>,
    edit: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let session = codex_for_hooks(installed)
        .and_then(|executable| AppServer::open(&executable, codex_home).ok());
    let Some(mut session) = session else {
        return edit();
    };
    let keys: Vec<String> = session
        .request("hooks/list", json!({"cwds": [codex_home]}))
        .map(|listed| {
            listed_hooks(&listed, command)
                .filter(|hook| {
                    EVENTS
                        .iter()
                        .chain([&QUESTION_EVENT])
                        .any(|event| hook["eventName"] == *event)
                })
                .filter_map(|hook| hook["key"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    edit()?;
    if keys.is_empty() {
        return Ok(());
    }
    for key in &keys {
        let _ = session.clear(&format!("hooks.state.{}", Value::from(key.as_str())));
    }
    // What is left of the person's own `[hooks]` in `config.toml`.
    let Ok(read) = session.request("config/read", json!({"includeLayers": true})) else {
        return Ok(());
    };
    let user = read["layers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|layer| layer["name"]["type"] == "user");
    let Some(hooks) = user.and_then(|layer| layer["config"]["hooks"].as_object()) else {
        return Ok(());
    };
    let state_empty = hooks
        .get("state")
        .is_some_and(|state| state.as_object().is_some_and(Map::is_empty));
    if state_empty {
        let only_state = hooks.len() == 1;
        let _ = session.clear(if only_state { "hooks" } else { "hooks.state" });
    }
    Ok(())
}

/// The Codex whose app-server lists and trusts hooks: Conductor's newest
/// bundled Codex, which is the one that runs them, else the one the core
/// found, else one on `PATH`. The core's own `PATH` is the system's alone
/// when it runs in the background, so a Homebrew or npm Codex is found only
/// as `installed`.
fn codex_for_hooks(installed: Option<&Path>) -> Option<PathBuf> {
    choose_codex(&crate::platform::home_dir()?, installed, || which("codex"))
}

/// `codex_for_hooks` under `home`, with `on_path` the `PATH` lookup.
fn choose_codex(
    home: &Path,
    installed: Option<&Path>,
    on_path: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    let bundled = home.join("Library/Application Support/com.conductor.app/agent-binaries/codex");
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(&bundled)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version: Option<Vec<u64>> = name.split('.').map(|part| part.parse().ok()).collect();
            let binary = entry.path().join("codex");
            Some((version?, binary)).filter(|(_, binary)| binary.is_file())
        })
        .collect();
    versions.sort();
    versions
        .pop()
        .map(|(_, binary)| binary)
        .or_else(|| installed.map(Path::to_path_buf))
        .or_else(on_path)
}

#[cfg(unix)]
fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
    })
}

/// `name` on `PATH` with its `PATHEXT` extension (`codex.cmd`).
#[cfg(windows)]
fn which(name: &str) -> Option<PathBuf> {
    crate::platform::exe::find_on_path(name)
}

/// A short-lived `codex app-server` over stdio.
struct AppServer {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<String>,
    next_id: u64,
}

impl AppServer {
    fn start(executable: &Path, codex_home: &Path) -> Result<AppServer, String> {
        let mut command = Command::new(executable);
        // No console window flashes up for it on Windows.
        crate::platform::process::hide_window(&mut command);
        let mut child = command
            .arg("app-server")
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Codex's app-server could not start.".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex's app-server has no input.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex's app-server has no output.")?;
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        Ok(AppServer {
            child,
            stdin,
            lines,
            next_id: 1,
        })
    }

    /// A started app-server, initialized.
    fn open(executable: &Path, codex_home: &Path) -> Result<AppServer, String> {
        let mut session = AppServer::start(executable, codex_home)?;
        session.request(
            "initialize",
            json!({"clientInfo": {"name": "agent-relay", "version": env!("CARGO_PKG_VERSION")}}),
        )?;
        session.notify("initialized")?;
        Ok(session)
    }

    /// Removes the user `config.toml` value at `key_path`.
    fn clear(&mut self, key_path: &str) -> Result<Value, String> {
        self.request(
            "config/value/write",
            json!({"keyPath": key_path, "mergeStrategy": "replace", "value": null}),
        )
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .map_err(|_| "Codex's app-server stopped.".to_string())
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        self.send(&json!({"method": method}))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + APP_SERVER_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .map_err(|_| format!("Codex's app-server did not answer {method}."))?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message["id"] != json!(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!(
                    "Codex refused {method}: {}",
                    error["message"].as_str().unwrap_or("no reason given")
                ));
            }
            return Ok(message["result"].clone());
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `hooks/list` as Codex 0.154 answers it, with `command` as the hook's.
    fn listed(command: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/questions/codex-0.154-hooks-list.json"
        ))
        .unwrap();
        serde_json::from_str(&fixture["response"].to_string().replace("COMMAND", command)).unwrap()
    }

    /// An install that already trusts the delivery hooks keeps that trust:
    /// only the new question hook is trusted, on its own write, and a
    /// person's own hook never is.
    #[test]
    fn the_question_hook_is_trusted_apart_from_the_delivery_hooks() {
        let command = "probe codex-stop-hook";
        let (required, question) = untrusted(&listed(command), command).unwrap();
        assert!(required.is_empty(), "{required:?}");
        assert_eq!(
            question,
            Some(Map::from_iter([(
                "k-question".to_string(),
                json!({"trusted_hash": "h-question"})
            )]))
        );
        // A delivery hook that lost its trust is trusted with the required
        // write, never with the question hook's.
        let mut changed = listed(command);
        changed["data"][0]["hooks"][1]["trustStatus"] = json!("modified");
        let (required, question) = untrusted(&changed, command).unwrap();
        assert_eq!(required.keys().collect::<Vec<_>>(), ["k-post"]);
        assert!(question.is_some());
        // A Codex that does not list the question hook still trusts the
        // rest: its questions are asked in the dialog.
        let mut older = listed(command);
        older["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .retain(|hook| hook["eventName"] != "preToolUse" || hook["command"] != command);
        assert_eq!(untrusted(&older, command).unwrap().1, None);
        // A question hook already trusted needs nothing.
        let mut trusted = listed(command);
        trusted["data"][0]["hooks"][3]["trustStatus"] = json!("trusted");
        assert_eq!(untrusted(&trusted, command).unwrap(), (Map::new(), None));
        // A delivery hook Codex does not list is still an error.
        let mut missing = listed(command);
        missing["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        assert!(untrusted(&missing, command).is_err());
    }

    // The background core's PATH has no Homebrew or npm Codex: the one the
    // core found trusts the hook.
    #[test]
    fn the_core_s_codex_trusts_the_hook_when_conductor_bundles_none() {
        let home = tempfile::tempdir().unwrap();
        let installed = Path::new("/opt/homebrew/lib/codex");
        assert_eq!(
            choose_codex(home.path(), Some(installed), || None),
            Some(installed.to_path_buf())
        );
        assert_eq!(
            choose_codex(home.path(), Some(installed), || Some(
                "/usr/bin/codex".into()
            )),
            Some(installed.to_path_buf()),
            "ahead of PATH"
        );
        assert_eq!(
            choose_codex(home.path(), None, || Some("/usr/bin/codex".into())),
            Some(PathBuf::from("/usr/bin/codex"))
        );
    }

    // Against a real Codex (0.163 when written), in a throwaway Codex home:
    //   cargo test --lib real_codex_untrust -- --ignored
    #[test]
    #[ignore = "runs a real Codex app-server"]
    fn real_codex_untrust_puts_config_toml_back_byte_for_byte() {
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path();
        let command = "'/Apps/Agent Relay.app/probe' codex-stop-hook";
        let hook = json!([{"hooks": [{"type": "command", "command": command, "timeout": 10}]}]);
        let theirs = "{\"hooks\": {\"Stop\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"notify.sh\"}]}]}}";
        let with_ours = json!({"hooks": {
            "Stop": [{"hooks": [{"type": "command", "command": "notify.sh"}]}, hook[0]],
            "PostToolUse": hook,
            "SessionStart": hook,
        }});
        std::fs::write(codex_home.join("hooks.json"), with_ours.to_string()).unwrap();
        let config = "# mine\nmodel = \"gpt-5\"   # trailing\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n";
        std::fs::write(codex_home.join("config.toml"), config).unwrap();

        with_app_server(codex_home, command, None).unwrap();
        let trusted = std::fs::read_to_string(codex_home.join("config.toml")).unwrap();
        assert_eq!(trusted.matches("trusted_hash").count(), 3, "{trusted}");

        untrust_with_app_server(codex_home, command, None, &mut || {
            std::fs::write(codex_home.join("hooks.json"), theirs).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(codex_home.join("config.toml")).unwrap(),
            config
        );
    }

    // Conductor's bundled Codex runs its chats' hooks, so it comes first.
    #[test]
    fn conductor_s_newest_bundled_codex_comes_first() {
        let home = tempfile::tempdir().unwrap();
        let bundled = home
            .path()
            .join("Library/Application Support/com.conductor.app/agent-binaries/codex");
        for version in ["0.9.0", "0.10.1"] {
            std::fs::create_dir_all(bundled.join(version)).unwrap();
            std::fs::write(bundled.join(version).join("codex"), "").unwrap();
        }
        assert_eq!(
            choose_codex(
                home.path(),
                Some(Path::new("/opt/homebrew/lib/codex")),
                || None
            ),
            Some(bundled.join("0.10.1/codex"))
        );
    }
}
