use super::*;

fn call() -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"owned-session","update":{
        "sessionUpdate":"tool_call","toolCallId":"call-one","rawInput":{"to":"alice@laptop","text":"controlled-nonce","reply_to":"42"},
        "_meta":{"cognition.ai/toolName":"mcp__private-alias__send_relay_message","cognition.ai/inferenceToolName":"mcp__private-alias__send_relay_message","cognition.ai/eventType":"mcp_tool_call"}}}})
}
fn permission() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":"owned-session","toolCall":{"toolCallId":"call-one"},"options":[{"optionId":"single","kind":"allow_once"},{"optionId":"broad","kind":"allow_always"}]}})
}
fn denied(update: Value, request: Value) {
    let mut gate = Gate::new("owned-session", "private-alias");
    gate.observe(&update);
    assert_eq!(gate.outcome(&request), json!({"outcome":"cancelled"}));
}

#[test]
fn exact_correlated_cli_tool_gets_only_one_single_use_approval() {
    let mut gate = Gate::new("owned-session", "private-alias");
    gate.observe(&call());
    assert_eq!(
        gate.outcome(&permission()),
        json!({"outcome":"selected","optionId":"single"})
    );
    assert_eq!(gate.outcome(&permission()), json!({"outcome":"cancelled"}));
    gate.clear();
    gate.observe(&call());
    assert_eq!(gate.outcome(&permission()), json!({"outcome":"cancelled"}));
}

#[test]
fn changed_tool_shell_inference_meta_and_raw_commands_fail_closed() {
    for path in [
        vec!["_meta", "cognition.ai/toolName"],
        vec!["_meta", "cognition.ai/inferenceToolName"],
        vec!["_meta", "cognition.ai/eventType"],
    ] {
        let mut update = call();
        update["params"]["update"][path[0]][path[1]] = json!("shell-or-shadow-alias");
        denied(update, permission());
    }
    for (key, value) in [
        ("kind", json!("execute")),
        ("kind", json!({"fake":"other"})),
        (
            "rawInput",
            json!({"to":"alice","text":"hi","command":"curl unsafe"}),
        ),
        ("rawInput", json!({"command":"send_relay_message"})),
        ("rawInput", json!({"to":"alice\n","text":"hi"})),
    ] {
        let mut update = call();
        update["params"]["update"][key] = value;
        denied(update, permission());
    }
}

#[test]
fn missing_correlations_inline_spoofs_and_changed_session_are_denied() {
    denied(json!({}), permission());
    let mut other_session = call();
    other_session["params"]["sessionId"] = json!("other-session");
    denied(other_session, permission());
    let mut other_request = permission();
    other_request["params"]["sessionId"] = json!("other-session");
    denied(call(), other_request);
    let mut inline = permission();
    inline["params"]["toolCall"]["_meta"] = call()["params"]["update"]["_meta"].clone();
    denied(call(), inline);
}

#[test]
fn broad_ambiguous_or_duplicate_option_ids_cannot_be_selected() {
    for options in [
        json!([{ "optionId":"broad","kind":"allow_always"}]),
        json!([{ "optionId":"once","kind":"allow_once"},{ "optionId":"other","kind":"allow_once"}]),
        json!([{ "optionId":"same","kind":"allow_always"},{ "optionId":"same","kind":"allow_once"}]),
        json!([{ "optionId":"","kind":"allow_once"}]),
    ] {
        let mut request = permission();
        request["params"]["options"] = options;
        denied(call(), request);
    }
}

#[test]
fn later_cli_update_replaces_arguments_and_consumed_calls_never_reapprove() {
    let mut gate = Gate::new("owned-session", "private-alias");
    gate.observe(&call());
    let update = json!({"method":"session/update","params":{"sessionId":"owned-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-one","rawInput":{"to":"alice","text":"hi","socket":"/tmp/forged"}}}});
    gate.observe(&update);
    assert_eq!(gate.outcome(&permission()), json!({"outcome":"cancelled"}));
}
