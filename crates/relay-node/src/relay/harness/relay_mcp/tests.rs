use super::*;

#[test]
fn only_send_is_exposed_and_arbitrary_commands_never_reach_transport() {
    let mut sent = Vec::new();
    let mut send = |value: &Value| {
        sent.push(value.clone());
        Ok(json!({"message_id":"42"}))
    };
    let list = dispatch(&json!({"id":1,"method":"tools/list"}), &mut send);
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(list["result"]["tools"][0]["name"], TOOL);
    for params in [
        json!({"name":"shell","arguments":{"command":"echo unsafe"}}),
        json!({"name":TOOL,"arguments":{"to":"alice","text":"hi","command":"echo unsafe"}}),
    ] {
        let answer = dispatch(
            &json!({"id":2,"method":"tools/call","params":params}),
            &mut send,
        );
        assert!(answer.get("error").is_some() || answer["result"]["isError"] == true);
    }
    let result = dispatch(
        &json!({"id":3,"method":"tools/call","params":{"name":TOOL,"arguments":{"to":"alice@laptop","text":"hello","reply_to":"42"}}}),
        &mut send,
    );
    assert!(result["result"].get("isError").is_none());
    assert_eq!(
        sent,
        [json!({"to":"alice@laptop","text":"hello","reply_to":"42"})]
    );
}

#[test]
fn message_schema_bounds_receiver_body_and_parent_without_extra_authority() {
    assert!(valid_arguments(&json!({"to":"@alice","text":"hi"})));
    for to in [
        "",
        "alice bob",
        "alice\n",
        "alice@@host",
        "alice@",
        "a/b",
        "$(id)",
    ] {
        assert!(!valid_arguments(&json!({"to":to,"text":"hi"})), "{to:?}");
    }
    for arguments in [
        json!({"to":"alice","text":" "}),
        json!({"to":"alice","text":"\0"}),
        json!({"to":"alice","text":"a".repeat(65_537)}),
        json!({"to":"alice","text":"hi","reply_to":"abc"}),
        json!({"to":"alice","text":"hi","reply_to":42}),
        json!({"to":"alice","text":"hi","reply_to":"9".repeat(33)}),
        json!({"to":"alice","text":"hi","socket":"/tmp/socket"}),
        json!({"to":false,"text":"hi"}),
    ] {
        assert!(!valid_arguments(&arguments));
    }
}

#[test]
fn failed_transport_never_becomes_a_successful_tool_result() {
    let result = dispatch(
        &json!({"id":1,"method":"tools/call","params":{"name":TOOL,"arguments":{"to":"alice","text":"nonce"}}}),
        &mut |_| anyhow::bail!("private backend details"),
    );
    assert_eq!(result["result"]["isError"], true);
    assert!(!result.to_string().contains("private backend details"));
}

#[test]
fn a_refused_send_shows_the_sockets_own_reason() {
    let body = br#"{"ok":false,"error":{"code":"ambiguous_recipient","message":"\"codex\" matches more than one agent: codex-a@m, codex-b@m. Send to one full address."}}"#;
    let result = dispatch(
        &json!({"id":1,"method":"tools/call","params":{"name":TOOL,"arguments":{"to":"codex","text":"hi"}}}),
        &mut |_| Err(Refused::from_body(body, 400).into()),
    );
    assert_eq!(result["result"]["isError"], true);
    assert_eq!(
        result["result"]["content"][0]["text"],
        "Agent Relay could not send this message: \"codex\" matches more than one agent: codex-a@m, codex-b@m. Send to one full address. No broader permission was granted."
    );
    assert_eq!(
        Refused::from_body(b"not json", 502).to_string(),
        "Agent Relay refused the send (HTTP 502)."
    );
}

#[test]
fn the_tool_teaches_the_messaging_etiquette() {
    let description = tool()["description"].as_str().unwrap().to_string();
    assert!(description.ends_with(crate::relay::hosted_mcp::ETIQUETTE));
}

#[test]
fn successful_send_requires_the_nested_authenticated_receipt() {
    let wire =
        json!({"ok":true,"data":{"from":"devin-worker","to":"alice@laptop","message_id":"123456"}});
    assert_eq!(
        receipt(&serde_json::to_vec(&wire).unwrap(), "alice@laptop").unwrap(),
        json!({"accepted":true,"from":"devin-worker","to":"alice@laptop","message_id":"123456"})
    );
    let display_name =
        json!({"ok":true,"data":{"from":"devin-worker","to":"alice","message_id":"123456"}});
    assert!(receipt(&serde_json::to_vec(&display_name).unwrap(), "@alice").is_ok());
}

#[test]
fn http_success_with_false_ok_missing_id_or_wrong_destination_is_not_accepted() {
    let valid =
        json!({"ok":true,"data":{"from":"devin-worker","to":"alice@laptop","message_id":"123456"}});
    for (key, value) in [
        ("ok", json!(false)),
        ("message_id", Value::Null),
        ("message_id", json!("")),
        ("message_id", json!(123)),
        ("from", json!("")),
        ("to", json!("different@laptop")),
    ] {
        let mut wire = valid.clone();
        if key == "ok" {
            wire[key] = value;
        } else {
            wire["data"][key] = value;
        }
        assert!(receipt(&serde_json::to_vec(&wire).unwrap(), "alice@laptop").is_err());
    }
    assert!(receipt(br#"{"ok":true,"message_id":"123456"}"#, "alice@laptop").is_err());
}

#[test]
fn binding_is_the_current_helper_with_no_caller_identity_or_credentials() {
    let production = definition(
        Path::new("/trusted/helper"),
        "fresh-alias",
        false,
        Harness::Devin,
    );
    assert_eq!(
        production,
        json!({"name":"fresh-alias","command":"/trusted/helper","args":["relay","devin-spawn-mcp"],"env":[]})
    );
    assert_eq!(
        definition(
            Path::new("/trusted/helper"),
            "fresh-alias",
            true,
            Harness::Devin
        )["args"],
        json!(["relay", "devin-spawn-mcp", "--dev"])
    );
}
