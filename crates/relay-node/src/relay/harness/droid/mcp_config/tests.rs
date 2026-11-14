use super::*;
use std::path::PathBuf;

fn helper() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\AgentRelay\agent-relay-desktop-probe.exe")
    } else {
        PathBuf::from("/opt/agent-relay-desktop-probe")
    }
}
fn legacy() -> Value {
    json!({"type":"stdio","command":"npx","args":["-y","agent-relay","mcp"],"env":{"RELAY_AGENT_TOKEN":"synthetic-credential-never-log","RELAY_AGENT_TYPE":"droid"}})
}
fn owned(source: &str, name: &str, value: &Value) -> OwnedEntryRecord {
    OwnedEntryRecord {
        source_id: source.into(),
        name: name.into(),
        entry_sha256: entry_digest(value).unwrap(),
    }
}
fn make_plan(doc: &Value, records: &[OwnedEntryRecord]) -> MigrationPlan {
    plan(
        "user-config",
        LocalConfig::Readable(doc),
        records,
        &helper(),
        false,
    )
    .unwrap()
}

#[test]
fn owned_legacy_migrates_without_credentials_and_unrelated_settings_survive() {
    let entry = legacy();
    let unrelated = json!({"command":"other-tool","args":["serve"],"env":{"OTHER_SECRET":"synthetic-unrelated-value"}});
    let doc = json!({"mcpServers":{"agent-relay":entry,"unrelated":unrelated},"persistentPermissions":{"unrelated":{"allowed":true}},"other":{"keep":true}});
    let snapshot = doc.clone();
    let result = make_plan(&doc, &[owned("user-config", SERVER_NAME, &entry)]);
    assert!(result.changed());
    assert_eq!(result.migrated_entries, 1);
    assert_eq!(
        result.document()["mcpServers"][SERVER_NAME],
        definition(&helper(), false).unwrap()
    );
    assert_eq!(result.document()["mcpServers"]["unrelated"], unrelated);
    assert_eq!(
        result.document()["persistentPermissions"],
        doc["persistentPermissions"]
    );
    assert_eq!(result.document()["other"], doc["other"]);
    assert_eq!(
        doc, snapshot,
        "a pure plan must not mutate its caller's document"
    );
    assert!(!result.document()["mcpServers"][SERVER_NAME]
        .to_string()
        .contains("synthetic-credential-never-log"));
    assert!(!format!("{result:?}").contains("synthetic-unrelated-value"));
    let record = result.owned_entry.as_ref().unwrap();
    assert_eq!(
        record.entry_sha256,
        entry_digest(&result.document()["mcpServers"][SERVER_NAME]).unwrap()
    );
}

#[test]
fn exact_command_or_untrusted_marker_does_not_establish_ownership() {
    for entry in [
        legacy(),
        json!({"agentRelayManagedBy":"agent-relay-desktop","command":"npx","args":["-y","agent-relay","mcp"]}),
    ] {
        let doc = json!({"mcpServers":{"agent-relay":entry}});
        let result = make_plan(&doc, &[]);
        assert_eq!(result.document(), &doc);
        assert!(result
            .blockers
            .iter()
            .any(|b| matches!(b, Blocker::UnprovenRelayEntry { .. })));
        assert!(result.blockers.contains(&Blocker::CanonicalNameOccupied));
        assert!(result.owned_entry.is_none());
    }
}

#[test]
fn stale_proof_wrong_source_or_wrong_name_preserve_the_existing_entry() {
    let entry = legacy();
    let doc = json!({"mcpServers":{"agent-relay":entry}});
    let mut stale = owned("user-config", SERVER_NAME, &entry);
    stale.entry_sha256 = "not-the-installed-digest".into();
    for proof in [
        stale,
        owned("different-source", SERVER_NAME, &entry),
        owned("user-config", "different-alias", &entry),
    ] {
        let result = make_plan(&doc, &[proof]);
        assert_eq!(result.document(), &doc);
        assert!(!result.changed());
        assert!(result
            .blockers
            .iter()
            .any(|b| matches!(b, Blocker::UnprovenRelayEntry { .. })));
    }
}

#[test]
fn changed_environment_invalidates_previously_saved_ownership() {
    let installed = legacy();
    let record = owned("user-config", SERVER_NAME, &installed);
    let mut changed = installed;
    changed["env"]["RELAY_AGENT_TOKEN"] = json!("different-synthetic-value");
    let doc = json!({"mcpServers":{"agent-relay":changed}});
    assert_eq!(make_plan(&doc, &[record]).document(), &doc);
}

#[test]
fn trusted_digest_still_requires_the_recognized_contract() {
    for entry in [
        json!({"command":"sh","args":["-c","npx -y agent-relay mcp"]}),
        json!({"command":"npx","args":["-y","agent-relay","mcp"],"env":{"HOME":"synthetic-other-home"}}),
        json!({"command":"npx","args":["-y","agent-relay","mcp"],"extra":"unsupported-custom-setting"}),
    ] {
        let doc = json!({"mcpServers":{"agent-relay":entry}});
        let result = make_plan(&doc, &[owned("user-config", SERVER_NAME, &entry)]);
        assert_eq!(result.document(), &doc);
        assert!(result
            .blockers
            .iter()
            .any(|b| matches!(b, Blocker::UnrecognizedOwnedEntry { .. })));
    }
}

#[test]
fn proven_aliases_converge_but_unproven_alias_is_preserved_and_blocks_preflight() {
    let entry = legacy();
    let unknown = json!({"command":"npx","args":["-y","agent-relay","mcp"]});
    let doc = json!({"mcpServers":{"old-owned-name":entry,"other-relay-alias":unknown}});
    let result = make_plan(&doc, &[owned("user-config", "old-owned-name", &entry)]);
    assert!(result.document()["mcpServers"]
        .get("old-owned-name")
        .is_none());
    assert_eq!(
        result.document()["mcpServers"]["other-relay-alias"],
        unknown
    );
    assert_eq!(
        result.document()["mcpServers"][SERVER_NAME],
        definition(&helper(), false).unwrap()
    );
    assert!(result
        .blockers
        .iter()
        .any(|b| matches!(b, Blocker::UnprovenRelayEntry { .. })));
}

#[test]
fn a_foreign_canonical_name_blocks_all_alias_removal() {
    let entry = legacy();
    let doc =
        json!({"mcpServers":{"old-owned-name":entry,"agent-relay":{"command":"custom","args":[]}}});
    let result = make_plan(&doc, &[owned("user-config", "old-owned-name", &entry)]);
    assert_eq!(result.document(), &doc);
    assert!(result.blockers.contains(&Blocker::CanonicalNameOccupied));
}

#[test]
fn disabled_entries_remain_disabled_and_mixed_state_is_not_guessed() {
    let mut disabled = legacy();
    disabled["disabled"] = json!(true);
    let doc = json!({"mcpServers":{"agent-relay":disabled}});
    let result = make_plan(&doc, &[owned("user-config", SERVER_NAME, &disabled)]);
    assert_eq!(
        result.document()["mcpServers"][SERVER_NAME]["disabled"],
        true
    );
    let active = legacy();
    let mixed = json!({"mcpServers":{"agent-relay":disabled,"other-owned":active}});
    let result = make_plan(
        &mixed,
        &[
            owned("user-config", SERVER_NAME, &disabled),
            owned("user-config", "other-owned", &active),
        ],
    );
    assert_eq!(result.document(), &mixed);
    assert!(result.blockers.contains(&Blocker::ConflictingEnabledState));
}

#[test]
fn absent_config_can_plan_an_inert_helper_but_unknown_effective_sources_still_block() {
    let result = plan("user-config", LocalConfig::Missing, &[], &helper(), true).unwrap();
    assert!(result.changed());
    assert_eq!(
        result.document()["mcpServers"][SERVER_NAME]["args"],
        json!(["droid-spawn-mcp", "--dev"])
    );
    assert!(result.document()["mcpServers"][SERVER_NAME]
        .get("env")
        .is_none());
    assert_eq!(
        result.blockers,
        vec![
            Blocker::OrganizationSourcesUnverified,
            Blocker::EffectiveReloadUnverified
        ]
    );
    let stable = plan(
        "user-config",
        LocalConfig::Readable(result.document()),
        &[result.owned_entry.clone().unwrap()],
        &helper(),
        true,
    )
    .unwrap();
    assert!(!stable.changed());
    assert_eq!(stable.blockers, result.blockers);
}

#[test]
fn unreadable_invalid_or_oversized_sources_never_become_missing_configs() {
    assert_eq!(
        plan(
            "user-config",
            LocalConfig::Unavailable,
            &[],
            &helper(),
            false
        )
        .unwrap_err(),
        ConfigError::UnavailableSource
    );
    for doc in [
        json!([]),
        json!({"mcpServers":null}),
        json!({"mcpServers":[]}),
    ] {
        assert_eq!(
            plan(
                "user-config",
                LocalConfig::Readable(&doc),
                &[],
                &helper(),
                false
            )
            .unwrap_err(),
            ConfigError::InvalidDocument
        );
    }
    assert_eq!(
        plan("", LocalConfig::Missing, &[], &helper(), false).unwrap_err(),
        ConfigError::InvalidSourceId
    );
    assert_eq!(
        definition(Path::new("relative-helper"), false).unwrap_err(),
        ConfigError::InvalidHelper
    );
    assert_eq!(
        entry_digest(&json!("x".repeat(MAX_BYTES + 1))).unwrap_err(),
        ConfigError::TooLarge
    );
    let mut deep = json!(null);
    for _ in 0..40 {
        deep = json!([deep]);
    }
    assert_eq!(entry_digest(&deep).unwrap_err(), ConfigError::TooLarge);
}

#[test]
fn canonical_digest_ignores_object_order_but_binds_values_and_array_order() {
    let a: Value = serde_json::from_str(r#"{"env":{"B":"b","A":"a"},"args":["x","y"]}"#).unwrap();
    let b: Value = serde_json::from_str(r#"{"args":["x","y"],"env":{"A":"a","B":"b"}}"#).unwrap();
    assert_eq!(entry_digest(&a).unwrap(), entry_digest(&b).unwrap());
    let mut changed = b;
    changed["args"] = json!(["y", "x"]);
    assert_ne!(entry_digest(&a).unwrap(), entry_digest(&changed).unwrap());
}
