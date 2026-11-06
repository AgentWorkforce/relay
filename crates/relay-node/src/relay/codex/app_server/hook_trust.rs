//! Verify already-approved hooks on exact loaded threads after a disk upgrade.

use super::*;
use std::path::Path;

/// The current owned hook definitions whose loaded state must match approval.
struct HookSpec<'a> {
    home: &'a Path,
    command: &'a str,
    events: &'a [&'a str],
    optional: &'a [&'a str],
}

/// Keep diagnostics useful without exposing raw provider replies.
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
    approved_definition(&mut client, &spec, &approved, deadline)?;
    if stable_verified(&mut client, &loaded, &spec, &approved, deadline)? {
        return Ok(());
    }
    // Only an actual refresh could migrate unrelated legacy approvals.
    if approved.as_object().is_some_and(|state| {
        state
            .values()
            .any(|s| s["trusted_hash"].as_str().is_some_and(|h| h.contains('/')))
    }) {
        return Err(refused(
            "Codex's legacy hook approvals require review before a byte-preserving refresh",
        ));
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
    if !stable_verified(&mut client, &after_loaded, &spec, &approved, deadline)? {
        return Err(refused(
            "Codex still reports an unready Relay hook after refresh",
        ));
    }
    Ok(())
}

/// Read versioned user-layer approval only from the expected Codex home.
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
    Ok((Value::Object(state.clone()), version))
}

/// Prove the intended current definition is approved independently of a loaded
/// thread's old command, hash or missing cached definition.
fn approved_definition(
    client: &mut Client<'_>,
    spec: &HookSpec<'_>,
    approved: &Value,
    deadline: Instant,
) -> io::Result<()> {
    client.send(
        &json!({"method":"hooks/list","id":3002,"params":{"cwds":[spec.home]}}),
        deadline,
    )?;
    let response = client.response(3002, deadline)?;
    if !thread_ready(listed_hooks(&response)?, spec, approved)? {
        return Err(refused(
            "Relay's current hook definition is not approved and enabled on disk",
        ));
    }
    Ok(())
}

/// Decode successful metadata; provider errors never become approval evidence.
fn listed_hooks(response: &Value) -> io::Result<&[Value]> {
    if response.get("error").is_some_and(|v| !v.is_null()) {
        return Err(refused("Codex's hook definitions could not be inspected"));
    }
    response["result"]["data"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| refused("Codex did not report its hook definitions"))
}

/// A chat arriving during verification requires a new attempt, not readiness.
fn stable_verified(
    client: &mut Client<'_>,
    loaded: &BTreeSet<String>,
    spec: &HookSpec<'_>,
    approved: &Value,
    deadline: Instant,
) -> io::Result<bool> {
    let ready = verified(client, loaded, spec, approved, deadline)?;
    if super::mcp_reload::loaded(client, deadline)? != *loaded {
        return Err(refused(
            "Codex's loaded chats changed during hook verification",
        ));
    }
    Ok(ready)
}

/// Inspect each exact loaded thread on this same owner connection.
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
        ready &= thread_ready(listed_hooks(&response)?, spec, approved)?;
    }
    Ok(ready)
}

/// Missing or stale definitions are unready; malformed metadata is an error.
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
            ready = false;
            continue;
        };
        let key = hook["key"]
            .as_str()
            .ok_or_else(|| refused("Codex omitted the hook's approval key"))?;
        let hash = hook["currentHash"]
            .as_str()
            .filter(|h| !h.is_empty())
            .ok_or_else(|| refused("Codex omitted the hook's definition hash"))?;
        if approved[key]["trusted_hash"] != hash || approved[key]["enabled"] == false {
            ready = false;
            continue;
        }
        ready &= hook["enabled"] == true
            && matches!(hook["trustStatus"].as_str(), Some("trusted" | "managed"));
    }
    Ok(ready)
}
