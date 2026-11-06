//! Verify already-approved hooks on exact loaded threads after a disk upgrade.

use super::*;
use std::path::Path;

struct HookSpec<'a> {
    home: &'a Path,
    command: &'a str,
    events: &'a [&'a str],
    optional: &'a [&'a str],
}

fn refused(message: &str) -> io::Error {
    io::Error::other(message)
}

/// No trust edits, thread starts, resumes or hook invocations are sent. A normal
/// empty-edit config refresh only reloads the user's existing approved state.
pub(crate) fn refresh_hook_trust(
    stream: &mut dyn ProxyStream,
    home: &Path,
    command: &str,
    events: &[&str],
    optional: &[&str],
    timeout: Duration,
) -> io::Result<()> {
    let spec = HookSpec {
        home,
        command,
        events,
        optional,
    };
    let deadline = Instant::now() + timeout;
    let mut client = Client::open_with_experimental(stream, deadline, true)?;
    let loaded = super::mcp_reload::loaded(&mut client, deadline)?;
    let (approved, version) = approved_config(&mut client, home, deadline)?;
    if verified(&mut client, &loaded, &spec, &approved, deadline)? {
        return Ok(());
    }
    let file = home.join("config.toml");
    let before = std::fs::read(&file)?;
    client.send(
        &json!({"method":"config/batchWrite","id":3001,"params":{
            "edits":[],"reloadUserConfig":true,"expectedVersion":version,
        }}),
        deadline,
    )?;
    let response = client.response(3001, deadline)?;
    let after = std::fs::read(&file)?;
    if before != after {
        return Err(refused(
            "Codex changed configuration bytes during an empty refresh",
        ));
    }
    if response.get("error").is_some_and(|v| !v.is_null()) || response["result"]["status"] != "ok" {
        return Err(refused("Codex did not accept the approved-state refresh"));
    }
    // Discover newly loaded chats too, so a concurrent new owner is not ignored.
    let after_loaded = super::mcp_reload::loaded(&mut client, deadline)?;
    if !loaded.is_subset(&after_loaded) {
        return Err(refused("Codex's loaded chats changed during hook refresh"));
    }
    if !verified(&mut client, &after_loaded, &spec, &approved, deadline)? {
        return Err(refused(
            "Codex still reports an unready Relay hook after refresh",
        ));
    }
    Ok(())
}

fn approved_config(
    client: &mut Client<'_>,
    home: &Path,
    deadline: Instant,
) -> io::Result<(Value, String)> {
    client.send(
        &json!({"method":"config/read","id":3000,"params":{"includeLayers":true}}),
        deadline,
    )?;
    let response = client.response(3000, deadline)?;
    if response.get("error").is_some_and(|v| !v.is_null()) {
        return Err(refused("Codex's approved configuration is unavailable"));
    }
    let expected = home.join("config.toml").canonicalize()?;
    let layer = response["result"]["layers"]
        .as_array()
        .and_then(|layers| {
            layers.iter().find(|layer| {
                layer["name"]["type"] == "user"
                    && layer["name"]["file"]
                        .as_str()
                        .and_then(|file| Path::new(file).canonicalize().ok())
                        .as_ref()
                        == Some(&expected)
            })
        })
        .ok_or_else(|| refused("Codex answered for a different hook home"))?;
    let version = layer["version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| refused("Codex did not provide an authoritative config version"))?
        .to_string();
    let state = layer["config"]["hooks"]["state"]
        .as_object()
        .ok_or_else(|| refused("Codex did not expose approved hook state"))?;
    if state
        .values()
        .any(|s| s["trusted_hash"].as_str().is_some_and(|h| h.contains('/')))
    {
        return Err(refused(
            "Codex's legacy hook approvals require review before a byte-preserving refresh",
        ));
    }
    Ok((Value::Object(state.clone()), version))
}

fn verified(
    client: &mut Client<'_>,
    loaded: &BTreeSet<String>,
    spec: &HookSpec<'_>,
    approved: &Value,
    deadline: Instant,
) -> io::Result<bool> {
    let mut ready = true;
    for (index, thread) in loaded.iter().enumerate() {
        let id = 4000 + index as i64;
        client.send(
            &json!({"method":"hooks/list","id":id,"params":{"threadId":thread}}),
            deadline,
        )?;
        let response = client.response(id, deadline)?;
        if response.get("error").is_some_and(|v| !v.is_null()) {
            return Err(refused("Codex's live hooks could not be inspected"));
        }
        let groups = response["result"]["data"]
            .as_array()
            .ok_or_else(|| refused("Codex did not report the loaded thread's hooks"))?;
        ready &= thread_ready(groups, spec, approved)?;
    }
    Ok(ready)
}

fn thread_ready(groups: &[Value], spec: &HookSpec<'_>, approved: &Value) -> io::Result<bool> {
    let source = spec.home.join("hooks.json").canonicalize()?;
    let mut ready = true;
    for event in spec.events {
        let hook = groups
            .iter()
            .filter_map(|g| g["hooks"].as_array())
            .flatten()
            .find(|h| {
                h["command"] == spec.command
                    && h["eventName"] == *event
                    && h["sourcePath"]
                        .as_str()
                        .and_then(|p| Path::new(p).canonicalize().ok())
                        .as_ref()
                        == Some(&source)
            });
        let Some(hook) = hook else {
            if spec.optional.contains(event) {
                continue;
            }
            return Err(refused(
                "A loaded Codex thread does not list Relay's required hook",
            ));
        };
        let key = hook["key"]
            .as_str()
            .ok_or_else(|| refused("Codex omitted the hook's approval key"))?;
        let hash = hook["currentHash"]
            .as_str()
            .filter(|h| !h.is_empty())
            .ok_or_else(|| refused("Codex omitted the hook's definition hash"))?;
        if approved[key]["trusted_hash"] != hash || approved[key]["enabled"] == false {
            return Err(refused(
                "The live Relay hook is not approved in the user's configuration",
            ));
        }
        ready &= hook["enabled"] == true
            && matches!(hook["trustStatus"].as_str(), Some("trusted" | "managed"));
    }
    Ok(ready)
}
