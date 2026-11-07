use super::*;
use crate::relay::links::DEFAULT_SITE_URL;
use std::collections::HashMap;

const LOCAL: &str = "http://127.0.0.1:8787";
/// A build made for its own site, and the Relaycast origin its sign-in
/// recorded.
const SITE: &str = "https://relay.corp.test";
const SITE_RELAYCAST: &str = "https://cast.relay.corp.test";

/// A home with the CLI's state directory and a project checkout.
struct Machine {
    _dir: tempfile::TempDir,
    relay: PathBuf,
    project: PathBuf,
    env: HashMap<String, String>,
}

impl Machine {
    fn new() -> Machine {
        let dir = tempfile::tempdir().unwrap();
        let relay = dir.path().join("relay-home");
        let project = dir.path().join("checkout");
        std::fs::create_dir_all(&relay).unwrap();
        std::fs::create_dir_all(project.join(PROJECT_DATA_DIR)).unwrap();
        Machine {
            _dir: dir,
            relay,
            project,
            env: HashMap::new(),
        }
    }

    fn env(mut self, name: &str, value: &str) -> Machine {
        self.env.insert(name.into(), value.into());
        self
    }

    fn in_project(self) -> Machine {
        let root = self.project.to_string_lossy().into_owned();
        self.env(PROJECT_ENV, &root)
    }

    fn store(self, active: &str, entries: &[(&str, &str)]) -> Machine {
        let workspaces: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|(name, key)| (name.to_string(), serde_json::json!({ "key": key })))
            .collect();
        self.write_relay(
            WORKSPACE_STORE_FILE,
            &serde_json::json!({ "active": active, "workspaces": workspaces }).to_string(),
        )
    }

    fn pin(self, pin: serde_json::Value) -> Machine {
        std::fs::write(
            self.project
                .join(PROJECT_DATA_DIR)
                .join(PROJECT_WORKSPACE_KEY_FILE),
            pin.to_string(),
        )
        .unwrap();
        self
    }

    fn bind(self, bindings: &[(&str, &str)]) -> Machine {
        let origins: serde_json::Map<String, serde_json::Value> = bindings
            .iter()
            .map(|(key, base_url)| {
                (
                    origin_binding::credential_fingerprint(key),
                    serde_json::Value::from(*base_url),
                )
            })
            .collect();
        self.write_relay(
            origin_binding::ORIGIN_BINDINGS_FILE,
            &serde_json::json!({ "version": 1, "origins": origins }).to_string(),
        )
    }

    fn write_relay(self, file: &str, contents: &str) -> Machine {
        std::fs::write(self.relay.join(file), contents).unwrap();
        self
    }

    /// Resolves as the default build does.
    fn resolve(&self) -> Result<Option<Workspace>, String> {
        self.resolve_at(DEFAULT_SITE_URL, None)
    }

    /// Resolves as a build for `site` does, whose sign-in recorded
    /// `site_relaycast`.
    fn resolve_at(
        &self,
        site: &str,
        site_relaycast: Option<&str>,
    ) -> Result<Option<Workspace>, String> {
        let env = self.env.clone();
        resolve_for_site(
            &move |key: &str| env.get(key).cloned(),
            &self.relay,
            site,
            site_relaycast,
        )
    }

    /// Resolves as [`SITE`]'s build does.
    fn resolve_in_site(&self) -> Result<Option<Workspace>, String> {
        self.resolve_at(SITE, Some(SITE_RELAYCAST))
    }

    fn found(&self) -> Workspace {
        self.resolve().unwrap().expect("a CLI workspace")
    }

    fn data_dir(&self) -> PathBuf {
        self.project.join(PROJECT_DATA_DIR)
    }
}

fn key_and_origin(workspace: &Workspace) -> (&str, &str) {
    (workspace.key.expose(), workspace.base_url.as_str())
}

// ---------------------------------------------------------------------------
// Precedence

#[test]
fn nothing_selected_is_none() {
    assert_eq!(Machine::new().resolve().unwrap(), None);
    assert_eq!(Machine::new().in_project().resolve().unwrap(), None);
    // Blank values select nothing.
    let machine = Machine::new()
        .env("RELAY_WORKSPACE_KEY", "   ")
        .store(" ", &[(" ", "rk_live_blank0000")]);
    assert_eq!(machine.resolve().unwrap(), None);
}

#[test]
fn environment_keys_rank_in_the_cli_order() {
    let all = Machine::new()
        .in_project()
        .env("RELAY_WORKSPACE_KEY", "rk_live_env_first")
        .env("AGENT_RELAY_WORKSPACE_KEY", "rk_live_env_second")
        .env("RELAY_API_KEY", "rk_live_env_third0")
        .pin(serde_json::json!({ "workspaceKey": "rk_live_project00" }))
        .store("local", &[("local", "rk_live_store0000")]);
    let found = all.found();
    assert_eq!(found.key.expose(), "rk_live_env_first");
    assert_eq!(
        found.source,
        WorkspaceSource::CliEnv("RELAY_WORKSPACE_KEY".into())
    );

    let found = Machine::new()
        .env("RELAY_WORKSPACE_KEY", "  ")
        .env("AGENT_RELAY_WORKSPACE_KEY", " rk_live_env_second ")
        .env("RELAY_API_KEY", "rk_live_env_third0")
        .found();
    assert_eq!(found.key.expose(), "rk_live_env_second");
    assert_eq!(
        found.source,
        WorkspaceSource::CliEnv("AGENT_RELAY_WORKSPACE_KEY".into())
    );

    let found = Machine::new()
        .env("RELAY_API_KEY", "rk_live_env_third0")
        .store("local", &[("local", "rk_live_store0000")])
        .found();
    assert_eq!(found.key.expose(), "rk_live_env_third0");
}

#[test]
fn the_project_pin_outranks_the_machine_store() {
    let machine = Machine::new()
        .in_project()
        .pin(serde_json::json!({ "workspaceKey": " rk_live_project00 " }))
        .store("local", &[("local", "rk_live_store0000")]);
    let found = machine.found();
    assert_eq!(found.key.expose(), "rk_live_project00");
    assert_eq!(
        found.source,
        WorkspaceSource::CliProject(machine.data_dir().join(PROJECT_WORKSPACE_KEY_FILE))
    );
}

#[test]
fn the_project_pin_is_read_only_for_an_explicit_project() {
    // Without AGENT_RELAY_PROJECT the daemon has no project: the machine's
    // active workspace applies.
    let found = Machine::new()
        .pin(serde_json::json!({ "workspaceKey": "rk_live_project00" }))
        .store("local", &[("local", "rk_live_store0000")])
        .found();
    assert_eq!(found.key.expose(), "rk_live_store0000");
}

#[test]
fn a_malformed_or_keyless_pin_falls_through_to_the_store() {
    for pin in [
        "not json",
        "{}",
        r#"{"workspaceKey":"  "}"#,
        r#"{"workspaceKey":7}"#,
    ] {
        let machine = Machine::new()
            .in_project()
            .store("local", &[("local", "rk_live_store0000")]);
        std::fs::write(machine.data_dir().join(PROJECT_WORKSPACE_KEY_FILE), pin).unwrap();
        assert_eq!(machine.found().key.expose(), "rk_live_store0000", "{pin}");
    }
}

#[test]
fn the_store_uses_its_active_entry() {
    let machine = Machine::new().store(
        "local",
        &[
            ("hosted", "rk_live_hosted000"),
            ("local", "rk_live_local0000"),
        ],
    );
    let found = machine.found();
    assert_eq!(found.key.expose(), "rk_live_local0000");
    assert_eq!(
        found.source,
        WorkspaceSource::CliStore {
            file: machine.relay.join(WORKSPACE_STORE_FILE),
            name: "local".into(),
        }
    );
    assert!(found.source.describe().contains("(active: \"local\")"));
    // No active entry, or one with no saved key, selects nothing.
    let machine = Machine::new().write_relay(
        WORKSPACE_STORE_FILE,
        r#"{"workspaces":{"local":{"key":"rk_live_local0000"}}}"#,
    );
    assert_eq!(machine.resolve().unwrap(), None);
    let machine = Machine::new().store("gone", &[("local", "rk_live_local0000")]);
    assert_eq!(machine.resolve().unwrap(), None);
}

#[test]
fn an_unreadable_store_fails_closed() {
    let machine = Machine::new().write_relay(WORKSPACE_STORE_FILE, "{ not json");
    let error = machine.resolve().unwrap_err();
    assert!(error.contains(WORKSPACE_STORE_FILE), "{error}");
    let machine = Machine::new();
    std::fs::create_dir(machine.relay.join(WORKSPACE_STORE_FILE)).unwrap();
    assert!(machine.resolve().is_err());
}

#[test]
fn a_store_the_cli_would_throw_on_fails_closed() {
    // packages/cloud/src/workspace-store.ts readWorkspaceStore reads
    // `parsed.previous` (a TypeError on `null`), and
    // resolveActiveWorkspaceSelection `?.trim()`s `active` and the entry's
    // `key` (a TypeError on any other non-string).
    for contents in [
        "null",
        r#"{"active":7,"workspaces":{"7":{"key":"rk_live_local0000"}}}"#,
        r#"{"active":true,"workspaces":{}}"#,
        r#"{"active":"local","workspaces":{"local":{"key":7}}}"#,
        r#"{"active":"local","workspaces":{"local":{"key":{"value":"rk_live_local0000"}}}}"#,
    ] {
        let machine = Machine::new().write_relay(WORKSPACE_STORE_FILE, contents);
        let error = machine.resolve().unwrap_err();
        assert!(error.contains(WORKSPACE_STORE_FILE), "{contents}: {error}");
        assert!(!error.contains("rk_live"), "{contents}: {error}");
    }
}

#[test]
fn a_store_the_cli_reads_as_empty_selects_nothing() {
    // `parsed.workspaces ?? {}`: a null or missing map is empty in the CLI,
    // and an entry that is not an object has no `key`.
    for contents in [
        r#"{"active":"local","workspaces":null}"#,
        r#"{"active":"local"}"#,
        r#"{"active":null,"workspaces":{"local":{"key":"rk_live_local0000"}}}"#,
        r#"{"active":"local","workspaces":{"local":null}}"#,
        r#"{"active":"local","workspaces":{"local":"rk_live_local0000"}}"#,
        r#"{"active":"local","workspaces":{"local":{"key":null}}}"#,
        r#"{"active":"local","workspaces":"local"}"#,
        "[]",
        "7",
        r#""rk_live_local0000""#,
    ] {
        let machine = Machine::new().write_relay(WORKSPACE_STORE_FILE, contents);
        assert_eq!(machine.resolve(), Ok(None), "{contents}");
    }
}

#[test]
fn a_rotated_store_key_is_picked_up_on_the_next_resolve() {
    let machine = Machine::new()
        .store("local", &[("local", "rk_live_before000")])
        .bind(&[("rk_live_before000", LOCAL)]);
    assert_eq!(machine.found().key.expose(), "rk_live_before000");
    let machine = machine
        .store("local", &[("local", "rk_live_after0000")])
        .bind(&[("rk_live_before000", LOCAL), ("rk_live_after0000", LOCAL)]);
    let found = machine.found();
    assert_eq!(key_and_origin(&found), ("rk_live_after0000", LOCAL));
}

#[test]
fn only_workspace_keys_are_used() {
    let error = Machine::new()
        .env("RELAY_API_KEY", "at_live_agent_token")
        .resolve()
        .unwrap_err();
    assert!(error.contains("$RELAY_API_KEY"), "{error}");
    assert!(!error.contains("at_live"), "{error}");
}

// ---------------------------------------------------------------------------
// Origins

#[test]
fn an_unbound_credential_goes_to_the_hosted_default() {
    let found = Machine::new()
        .store("hosted", &[("hosted", "rk_live_hosted000")])
        .bind(&[("rk_live_other0000", "https://relay.corp.test")])
        .found();
    assert_eq!(found.base_url, DEFAULT_BASE_URL);
}

#[test]
fn a_site_build_refuses_an_unbound_credential() {
    let machine = Machine::new()
        .store("hosted", &[("hosted", "rk_live_hosted000")])
        .bind(&[("rk_live_other0000", "https://relay.corp.test")]);
    // The default build sends it to the hosted default, as before.
    assert_eq!(machine.found().base_url, DEFAULT_BASE_URL);
    let error = machine.resolve_in_site().unwrap_err();
    assert!(
        error.contains(origin_binding::ORIGIN_BINDINGS_FILE),
        "{error}"
    );
    assert!(error.contains(SITE), "{error}");
    assert!(error.contains(BASE_URL_ENV), "{error}");
    assert!(error.contains(WORKSPACE_STORE_FILE), "{error}");
    assert!(!error.contains(DEFAULT_BASE_URL), "{error}");
    assert!(!error.contains("rk_live"), "{error}");
    // With no bindings file at all, too, and even when the site's sign-in
    // named a Relaycast origin: that is the account's, not this key's.
    let machine = Machine::new().env("RELAY_WORKSPACE_KEY", "rk_live_hosted000");
    assert_eq!(machine.found().base_url, DEFAULT_BASE_URL);
    assert!(machine.resolve_in_site().is_err());
    assert!(machine.resolve_at(SITE, None).is_err());
}

#[test]
fn a_site_build_never_presumes_armadillo_for_an_unseen_armadillo_key() {
    for key in ["ar_ws_0123456789abcdef", "ar_ag_0123456789abcdef"] {
        let machine = Machine::new().env("RELAY_WORKSPACE_KEY", key);
        if key.starts_with("ar_ws_") {
            // The default build presumes armadillo, as before.
            assert_eq!(machine.found().base_url, ARMADILLO_ORIGIN);
        } else {
            // An agent token is not a workspace key in either build.
            assert!(machine.resolve().is_err());
        }
        let error = machine.resolve_in_site().unwrap_err();
        assert!(!error.contains(ARMADILLO_ORIGIN), "{error}");
        if key.starts_with("ar_ws_") {
            assert!(
                error.contains(origin_binding::ORIGIN_BINDINGS_FILE),
                "{error}"
            );
            assert!(error.contains(SITE), "{error}");
        }
    }
}

#[test]
fn a_site_build_uses_a_recorded_server_or_relay_base_url() {
    let found = Machine::new()
        .store("local", &[("local", "rk_live_local0000")])
        .bind(&[("rk_live_local0000", LOCAL)])
        .resolve_in_site()
        .unwrap()
        .unwrap();
    assert_eq!(key_and_origin(&found), ("rk_live_local0000", LOCAL));
    let found = Machine::new()
        .env("RELAY_WORKSPACE_KEY", "ar_ws_0123456789abcdef")
        .bind(&[("ar_ws_0123456789abcdef", SITE_RELAYCAST)])
        .resolve_in_site()
        .unwrap()
        .unwrap();
    assert_eq!(found.base_url, SITE_RELAYCAST);
    let found = Machine::new()
        .store("hosted", &[("hosted", "rk_live_hosted000")])
        .env(BASE_URL_ENV, "https://relay.corp.test/relaycast/")
        .resolve_in_site()
        .unwrap()
        .unwrap();
    assert_eq!(found.base_url, "https://relay.corp.test/relaycast");
    // A malformed RELAY_BASE_URL still never falls back, in either build.
    let error = Machine::new()
        .store("hosted", &[("hosted", "rk_live_hosted000")])
        .env(BASE_URL_ENV, "not a url")
        .resolve_in_site()
        .unwrap_err();
    assert!(error.contains(BASE_URL_ENV), "{error}");
}

#[test]
fn a_bound_credential_goes_only_to_its_server() {
    // relay init's local server: http on loopback with a port.
    let found = Machine::new()
        .store("local", &[("local", "rk_live_local0000")])
        .bind(&[("rk_live_local0000", LOCAL)])
        .found();
    assert_eq!(key_and_origin(&found), ("rk_live_local0000", LOCAL));
    // A self-hosted server behind a path prefix and a port.
    let found = Machine::new()
        .env("RELAY_WORKSPACE_KEY", "rk_live_selfhost0")
        .bind(&[(
            "rk_live_selfhost0",
            "https://relay.corp.test:8443/relaycast",
        )])
        .found();
    assert_eq!(found.base_url, "https://relay.corp.test:8443/relaycast");
}

#[test]
fn the_shared_fixture_binding_resolves_its_server() {
    #[derive(serde::Deserialize)]
    struct Vector {
        credential: String,
        normalized_base_url: String,
        binding_file: serde_json::Value,
    }
    let vector: Vector = serde_json::from_str(include_str!(
        "../../../../../../packages/contracts/fixtures/relaycast-origin-binding.json"
    ))
    .unwrap();
    // The fixture's credential is not rk_-shaped beyond its prefix check, so
    // pass it through the environment as an operator would.
    let found = Machine::new()
        .env("RELAY_WORKSPACE_KEY", &vector.credential)
        .write_relay(
            origin_binding::ORIGIN_BINDINGS_FILE,
            &vector.binding_file.to_string(),
        )
        .found();
    assert_eq!(found.key.expose(), vector.credential.trim());
    assert_eq!(found.base_url, vector.normalized_base_url);
}

#[test]
fn relay_base_url_is_the_explicit_destination() {
    let found = Machine::new()
        .store("local", &[("local", "rk_live_local0000")])
        .bind(&[("rk_live_local0000", LOCAL)])
        .env(BASE_URL_ENV, "http://localhost:8799/")
        .found();
    assert_eq!(found.base_url, "http://localhost:8799");
    // Blank is unset: the binding applies.
    let found = Machine::new()
        .store("local", &[("local", "rk_live_local0000")])
        .bind(&[("rk_live_local0000", LOCAL)])
        .env(BASE_URL_ENV, "  ")
        .found();
    assert_eq!(found.base_url, LOCAL);
}

#[test]
fn a_malformed_relay_base_url_never_falls_back() {
    for bad in [
        "not a url",
        "ftp://relay.corp.test",
        "https://u:p@relay.corp.test",
    ] {
        let error = Machine::new()
            .store("local", &[("local", "rk_live_local0000")])
            .bind(&[("rk_live_local0000", LOCAL)])
            .env(BASE_URL_ENV, bad)
            .resolve()
            .unwrap_err();
        assert!(error.contains(BASE_URL_ENV), "{bad}: {error}");
    }
}

#[test]
fn a_malformed_bindings_file_fails_closed_even_with_an_explicit_url() {
    for machine in [
        Machine::new().store("local", &[("local", "rk_live_local0000")]),
        Machine::new()
            .store("local", &[("local", "rk_live_local0000")])
            .env(BASE_URL_ENV, LOCAL),
    ] {
        let machine = machine.write_relay(origin_binding::ORIGIN_BINDINGS_FILE, "{]");
        let error = machine.resolve().unwrap_err();
        assert!(error.contains("relaycast-origins.json"), "{error}");
    }
    // With nothing selected there is no credential to protect.
    let machine = Machine::new().write_relay(origin_binding::ORIGIN_BINDINGS_FILE, "{]");
    assert_eq!(machine.resolve().unwrap(), None);
}

// ---------------------------------------------------------------------------
// Persisted project routes

#[test]
fn a_canonical_route_uses_its_gateway() {
    let found = Machine::new()
        .in_project()
        .pin(serde_json::json!({
            "workspaceKey": "rk_live_project00",
            "relaycastRoute": "canonical",
            "relaycastBaseUrl": "https://cast.agentrelay.com/",
        }))
        .env(BASE_URL_ENV, "https://relay.corp.test")
        .found();
    // The persisted route outranks RELAY_BASE_URL, as in the CLI.
    assert_eq!(
        key_and_origin(&found),
        ("rk_live_project00", DEFAULT_BASE_URL)
    );

    let found = Machine::new()
        .in_project()
        .pin(serde_json::json!({
            "workspaceKey": "rk_live_project00",
            "relaycastRoute": "canonical",
            "relaycastBaseUrl": DEV_RELAYCAST_ORIGIN,
            "relaycastCloudApiUrl": DEV_CLOUD_API_URL,
        }))
        .found();
    assert_eq!(found.base_url, DEV_RELAYCAST_ORIGIN);
}

#[test]
fn an_isolated_route_uses_its_matching_route_credential() {
    let machine = Machine::new().in_project();
    let reference = credential_ref(
        &machine.data_dir(),
        "ws_1",
        "agent37-isolated",
        AGENT37_RELAYCAST_ORIGIN,
    );
    let credentials = |api_key: &str, workspace_id: &str| {
        serde_json::json!({ "credentials": { reference.clone(): {
            "workspaceId": workspace_id,
            "route": "agent37-isolated",
            "baseUrl": AGENT37_RELAYCAST_ORIGIN,
            "apiKey": api_key,
        }}})
        .to_string()
    };
    let pin = serde_json::json!({
        "workspaceKey": "rk_live_project00",
        "workspaceId": "ws_1",
        "relaycastRoute": "agent37-isolated",
        "relaycastBaseUrl": AGENT37_RELAYCAST_ORIGIN,
        "relaycastApiKeyRef": reference,
    });
    let machine = machine.pin(pin.clone()).write_relay(
        RELAYCAST_CREDENTIALS_FILE,
        &credentials("rk_live_route0000", "ws_1"),
    );
    let found = machine.found();
    assert_eq!(
        key_and_origin(&found),
        ("rk_live_route0000", AGENT37_RELAYCAST_ORIGIN)
    );

    // A stored credential recorded for another workspace is not this pin's,
    // and an isolated route without its credential is refused.
    let machine = machine.write_relay(
        RELAYCAST_CREDENTIALS_FILE,
        &credentials("rk_live_route0000", "ws_other"),
    );
    let error = machine.resolve().unwrap_err();
    assert!(error.contains("isolated"), "{error}");

    // A tampered reference is never followed.
    let mut tampered = pin;
    tampered["relaycastApiKeyRef"] = serde_json::Value::from("0".repeat(64));
    let machine = machine.pin(tampered).write_relay(
        RELAYCAST_CREDENTIALS_FILE,
        &credentials("rk_live_route0000", "ws_1"),
    );
    assert!(machine.resolve().is_err());
}

#[test]
fn an_environment_key_inherits_only_its_own_project_route() {
    let pin = serde_json::json!({
        "workspaceKey": "rk_live_project00",
        "relaycastRoute": "canonical",
        "relaycastBaseUrl": DEV_RELAYCAST_ORIGIN,
        "relaycastCloudApiUrl": DEV_CLOUD_API_URL,
    });
    let same = Machine::new()
        .in_project()
        .pin(pin.clone())
        .env("RELAY_WORKSPACE_KEY", "rk_live_project00")
        .found();
    assert_eq!(same.base_url, DEV_RELAYCAST_ORIGIN);
    let other = Machine::new()
        .in_project()
        .pin(pin)
        .env("RELAY_WORKSPACE_KEY", "rk_live_other0000")
        .found();
    assert_eq!(other.base_url, DEFAULT_BASE_URL);
}

#[test]
fn untrusted_or_incomplete_routes_are_refused() {
    for pin in [
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastRoute": "canonical" }),
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastBaseUrl": DEFAULT_BASE_URL }),
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastRoute": "mystery", "relaycastBaseUrl": DEFAULT_BASE_URL }),
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastRoute": "canonical", "relaycastBaseUrl": "https://relay.corp.test" }),
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastRoute": "canonical", "relaycastBaseUrl": "https://cast.agentrelay.com:8443" }),
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastRoute": "canonical", "relaycastBaseUrl": "https://cast.agentrelay.com/v1" }),
        // The dev gateway needs the dev Cloud.
        serde_json::json!({ "workspaceKey": "rk_live_project00", "relaycastRoute": "canonical", "relaycastBaseUrl": DEV_RELAYCAST_ORIGIN }),
    ] {
        let machine = Machine::new().in_project().pin(pin.clone());
        assert!(machine.resolve().is_err(), "{pin}");
    }
}

#[test]
fn a_site_build_trusts_only_routes_to_its_own_relaycast() {
    let pin = |route: &str, base_url: &str| {
        serde_json::json!({
            "workspaceKey": "rk_live_project00",
            "relaycastRoute": route,
            "relaycastBaseUrl": base_url,
        })
    };
    // The hosted gateways count only in the default build.
    for (route, base_url) in [
        ("canonical", CANONICAL_RELAYCAST_ORIGIN),
        ("canonical", ARMADILLO_ORIGIN),
    ] {
        let machine = Machine::new().in_project().pin(pin(route, base_url));
        assert_eq!(machine.found().base_url, base_url);
        let error = machine.resolve_in_site().unwrap_err();
        assert!(error.contains("not trusted"), "{error}");
        assert!(error.contains(SITE), "{error}");
        assert!(error.contains(SITE_RELAYCAST), "{error}");
    }
    let dev = Machine::new().in_project().pin(serde_json::json!({
        "workspaceKey": "rk_live_project00",
        "relaycastRoute": "canonical",
        "relaycastBaseUrl": DEV_RELAYCAST_ORIGIN,
        "relaycastCloudApiUrl": DEV_CLOUD_API_URL,
    }));
    assert_eq!(dev.found().base_url, DEV_RELAYCAST_ORIGIN);
    assert!(dev.resolve_in_site().is_err());
    // The site's own Relaycast origin is the one that counts there.
    let own = Machine::new()
        .in_project()
        .pin(pin("canonical", &format!("{SITE_RELAYCAST}/")));
    assert!(own.resolve().is_err());
    assert_eq!(
        key_and_origin(&own.resolve_in_site().unwrap().unwrap()),
        ("rk_live_project00", SITE_RELAYCAST)
    );
    // With no origin from the site's sign-in, no route is trusted.
    let error = own.resolve_at(SITE, None).unwrap_err();
    assert!(error.contains("named none"), "{error}");
    // An isolated route needs its route credential in a site build too.
    let isolated = Machine::new()
        .in_project()
        .pin(pin("agent37-isolated", SITE_RELAYCAST));
    let error = isolated.resolve_in_site().unwrap_err();
    assert!(error.contains("isolated"), "{error}");
}

#[test]
fn a_site_build_trusts_its_own_loopback_relaycast_with_a_port() {
    let pin = |base_url: &str| {
        serde_json::json!({
            "workspaceKey": "rk_live_project00",
            "relaycastRoute": "canonical",
            "relaycastBaseUrl": base_url,
        })
    };
    // A loopback site origin with a port, as its sign-in accepted it, counts
    // with or without a trailing slash, and is returned as the bare origin.
    for (site_relaycast, base_url) in [
        (LOCAL, LOCAL.to_string()),
        (LOCAL, format!("{LOCAL}/")),
        (
            "https://localhost:8443",
            "https://localhost:8443".to_string(),
        ),
        (
            "https://localhost:8443",
            "https://LOCALHOST:8443/".to_string(),
        ),
    ] {
        let machine = Machine::new().in_project().pin(pin(&base_url));
        let found = machine
            .resolve_at(SITE, Some(site_relaycast))
            .unwrap_or_else(|error| panic!("{base_url}: {error}"))
            .expect("a CLI workspace");
        assert_eq!(
            key_and_origin(&found),
            ("rk_live_project00", site_relaycast),
            "{base_url}"
        );
    }
    // Any other origin, or the site's own with more than an origin, is
    // still refused with the site's reason.
    for base_url in [
        CANONICAL_RELAYCAST_ORIGIN,
        "http://cast.relay.corp.test:8787",
        "http://127.0.0.1:8788",
        "https://127.0.0.1:8787",
        "http://localhost:8787",
        "http://127.0.0.1:8787/v1",
        "http://127.0.0.1:8787/?a=b",
        "http://user@127.0.0.1:8787",
        "http://127.0.0.1:8787#x",
    ] {
        let machine = Machine::new().in_project().pin(pin(base_url));
        let error = machine.resolve_at(SITE, Some(LOCAL)).unwrap_err();
        assert!(error.contains("not trusted"), "{base_url}: {error}");
        assert!(error.contains(SITE), "{base_url}: {error}");
        assert!(error.contains(LOCAL), "{base_url}: {error}");
    }
    // A non-loopback http site origin never counts, even when it matches.
    let plain = Machine::new()
        .in_project()
        .pin(pin("http://cast.relay.corp.test"));
    let error = plain
        .resolve_at(SITE, Some("http://cast.relay.corp.test"))
        .unwrap_err();
    assert!(error.contains("not trusted"), "{error}");
}

#[test]
fn the_default_build_still_refuses_loopback_or_ported_routes() {
    for base_url in [
        LOCAL,
        "http://localhost",
        "https://localhost:8443",
        "https://cast.agentrelay.com:8443",
        "http://cast.agentrelay.com",
    ] {
        let machine = Machine::new().in_project().pin(serde_json::json!({
            "workspaceKey": "rk_live_project00",
            "relaycastRoute": "canonical",
            "relaycastBaseUrl": base_url,
        }));
        let error = machine.resolve().unwrap_err();
        assert_eq!(
            error, "The persisted Relaycast workspace route is not trusted.",
            "{base_url}"
        );
    }
}

#[test]
fn a_bound_credential_is_never_sent_to_a_persisted_route() {
    let error = Machine::new()
        .in_project()
        .pin(serde_json::json!({
            "workspaceKey": "rk_live_project00",
            "relaycastRoute": "canonical",
            "relaycastBaseUrl": DEFAULT_BASE_URL,
        }))
        .bind(&[("rk_live_project00", "https://relay.corp.test")])
        .resolve()
        .unwrap_err();
    assert!(error.contains("https://relay.corp.test"), "{error}");
    assert!(!error.contains("rk_live"), "{error}");
}

// ---------------------------------------------------------------------------
// Read-only

#[test]
fn resolving_never_writes_the_cli_state() {
    let machine = Machine::new()
        .in_project()
        .pin(serde_json::json!({ "workspaceKey": "rk_live_project00" }))
        .store("local", &[("local", "rk_live_store0000")])
        .env(BASE_URL_ENV, "https://relay.corp.test");
    let snapshot = |dir: &Path| {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (entry.file_name(), std::fs::read(entry.path()).ok())
            })
            .collect();
        entries.sort();
        entries
    };
    let (relay, project) = (snapshot(&machine.relay), snapshot(&machine.data_dir()));
    // The CLI would bind the key to RELAY_BASE_URL here; the probe only reads.
    assert_eq!(machine.found().base_url, "https://relay.corp.test");
    assert_eq!(snapshot(&machine.relay), relay);
    assert_eq!(snapshot(&machine.data_dir()), project);
}

#[test]
fn verbatim_windows_paths_print_as_node_prints_them() {
    for (canonicalized, node) in [
        (r"\\?\C:\Users\dev\checkout", r"C:\Users\dev\checkout"),
        (r"\\?\C:\", r"C:\"),
        (r"\\?\d:", r"d:"),
        (r"\\?\UNC\server\share\checkout", r"\\server\share\checkout"),
        // Already plain, or a verbatim form with no plain spelling.
        (r"C:\Users\dev", r"C:\Users\dev"),
        (r"\\server\share", r"\\server\share"),
        (
            r"\\?\Volume{0b1c2d3e-0000-0000-0000-000000000000}\x",
            r"\\?\Volume{0b1c2d3e-0000-0000-0000-000000000000}\x",
        ),
    ] {
        assert_eq!(
            without_verbatim_prefix(canonicalized),
            node,
            "{canonicalized}"
        );
    }
}

#[cfg(windows)]
#[test]
fn the_credential_reference_matches_the_cli_on_windows() {
    // relaycastCredentialRef(dataDir, "ws_1", "agent37-isolated",
    // "https://agent37-cast.agentrelay.com/") on Windows: only `C:\` exists,
    // which realpathSync.native prints as `C:\`; the missing tail is kept
    // and the whole path lowercased. That is the SHA-256 of
    // "c:\nonexistent-relay-probe-test\checkout\.agentworkforce\relay\0ws_1\0agent37-isolated\0https://agent37-cast.agentrelay.com".
    let expected = "ec05ee466537a841736141b4fe2e820c17a13c17f0d3072ceb248f5eeefb8342";
    for spelling in [
        r"C:\nonexistent-relay-probe-test\checkout\.agentworkforce\relay",
        r"c:\NonExistent-Relay-Probe-Test\Checkout\.AgentWorkforce\Relay",
    ] {
        let reference = credential_ref(
            Path::new(spelling),
            "ws_1",
            "agent37-isolated",
            "https://agent37-cast.agentrelay.com/",
        );
        assert_eq!(reference, expected, "{spelling}");
    }

    // An existing directory canonicalizes to `\\?\C:\…` in Rust; the CLI
    // hashes the plain, lowercased path, and any casing alias of it.
    let machine = Machine::new().in_project();
    let data_dir = machine.data_dir();
    let canonical = canonical_data_dir(&data_dir);
    assert!(!canonical.starts_with(r"\\?\"), "{canonical}");
    assert!(is_drive_path(&canonical), "{canonical}");
    assert_eq!(canonical, canonical.to_lowercase());
    let alias = PathBuf::from(data_dir.to_string_lossy().to_uppercase());
    assert_eq!(canonical_data_dir(&alias), canonical);
    let digest = Sha256::digest(
        format!("{canonical}\0ws_1\0agent37-isolated\0{AGENT37_RELAYCAST_ORIGIN}").as_bytes(),
    );
    let expected: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    for dir in [&data_dir, &alias] {
        assert_eq!(
            credential_ref(dir, "ws_1", "agent37-isolated", AGENT37_RELAYCAST_ORIGIN),
            expected
        );
    }
}

#[cfg(unix)]
#[test]
fn the_credential_reference_matches_the_cli() {
    // packages/cloud/src/workspace-store.ts relaycastCredentialRef(dataDir,
    // "ws_1", "agent37-isolated", "https://agent37-cast.agentrelay.com/") for
    // a data dir that does not exist (so the path is kept as given).
    let reference = credential_ref(
        Path::new("/nonexistent-relay-probe-test/checkout/.agentworkforce/relay"),
        "ws_1",
        "agent37-isolated",
        "https://agent37-cast.agentrelay.com/",
    );
    assert_eq!(
        reference,
        "5efe173d0f0bf1522a9926ff2f455c7f72744ad6d3e6673091b23590e13b0510"
    );
}
