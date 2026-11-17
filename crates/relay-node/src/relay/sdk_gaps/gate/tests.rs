use super::*;
use std::io::{Read, Write};

const DEVICE_TOKEN: &str = "sh_at_device0123456789";
const AGENT_TOKEN: &str = "rg_agent0123456789";
const RECOVERY: &str = "recovery-proof-0123456789";

/// A gate answering one request with `status`, `headers` and `body`;
/// returns its URL and the request it got, head and body.
fn gate(
    status: &str,
    headers: &[(&str, String)],
    body: &str,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let count = stream.read(&mut chunk).unwrap();
            request.extend_from_slice(&chunk[..count]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            if count == 0 {
                break;
            }
        }
        stream.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&request).to_string()
    });
    (url, server)
}

fn error_body(code: &str) -> String {
    format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"no"}}}}"#)
}

fn registration_body() -> String {
    r#"{"agent_id":"ag_1","gid":7,"token":"rg_issued","expires_at":"2026-11-16T10:00:00Z","user_id":"usr_1"}"#.into()
}

async fn register_answered(
    status: &str,
    headers: &[(&str, String)],
    body: &str,
) -> (Result<GateRegistration, GateError>, String) {
    let (url, server) = gate(status, headers, body);
    let result = gate_register(&url, &Secret::new(DEVICE_TOKEN), "builder", RECOVERY).await;
    (result, server.join().unwrap())
}

fn seconds(seconds: u64) -> Option<Duration> {
    Some(Duration::from_secs(seconds))
}

#[tokio::test]
async fn register_sends_the_device_token_name_and_recovery_and_reads_the_envelope() {
    let body = format!(r#"{{"ok":true,"data":{}}}"#, registration_body());
    let (result, request) = register_answered("201 Created", &[], &body).await;
    let registration = result.unwrap();
    assert_eq!(registration.agent_id, "ag_1");
    assert_eq!(registration.gid, 7);
    assert_eq!(registration.token.expose(), "rg_issued");
    assert_eq!(registration.user_id, "usr_1");
    assert_eq!(
        registration.expires_at,
        chrono::DateTime::parse_from_rfc3339("2026-11-16T10:00:00Z").unwrap()
    );
    assert!(request.starts_with("POST /v1/register "), "{request}");
    let lower = request.to_lowercase();
    assert!(
        lower.contains(&format!("authorization: bearer {DEVICE_TOKEN}")),
        "{request}"
    );
    assert!(
        lower.contains("x-relaycast-origin-client: relay-desktop"),
        "{request}"
    );
    let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(sent, json!({"name": "builder", "recovery": RECOVERY}));
}

/// The shape the live relaygate answers with (2026-11-16): a numeric
/// `gid` and an `expires_at` with milliseconds.
#[tokio::test]
async fn register_reads_the_live_answer_shape() {
    let body = r#"{"agent_id":"ag_85aa7397-0000-4000-8000-000000000000","gid":11,"token":"rg_placeholder","expires_at":"2026-11-16T18:35:44.000Z","user_id":"cd346873-0000-4000-8000-000000000000"}"#;
    let (result, _) = register_answered("201 Created", &[], body).await;
    let registration = result.unwrap();
    assert_eq!(registration.gid, 11);
    assert_eq!(
        registration.agent_id,
        "ag_85aa7397-0000-4000-8000-000000000000"
    );
    assert_eq!(registration.token.expose(), "rg_placeholder");
    assert_eq!(
        registration.expires_at,
        chrono::DateTime::parse_from_rfc3339("2026-11-16T18:35:44Z").unwrap()
    );
}

#[tokio::test]
async fn register_reads_a_numeric_string_gid() {
    let body = registration_body().replace(r#""gid":7"#, r#""gid":"11""#);
    let (result, _) = register_answered("200 OK", &[], &body).await;
    assert_eq!(result.unwrap().gid, 11);
}

#[tokio::test]
async fn register_reads_a_bare_body() {
    let (result, _) = register_answered("200 OK", &[], &registration_body()).await;
    assert_eq!(result.unwrap().token.expose(), "rg_issued");
}

#[tokio::test]
async fn register_refuses_an_answer_without_an_rg_token_or_a_readable_expiry() {
    for body in [
        registration_body().replace("rg_issued", "at_issued"),
        registration_body().replace("2026-11-16T10:00:00Z", "tomorrow"),
        registration_body().replace(r#""gid":7,"#, ""),
        registration_body().replace(r#""gid":7"#, r#""gid":"eng""#),
        registration_body().replace(r#""gid":7"#, r#""gid":-1"#),
        registration_body().replace(r#""gid":7"#, r#""gid":1.5"#),
        registration_body().replace(r#""gid":7"#, r#""gid":null"#),
    ] {
        let (result, _) = register_answered("200 OK", &[], &body).await;
        assert!(
            matches!(&result, Err(GateError::Other(error)) if matches!(**error, RelayError::InvalidResponse(_))),
            "{body}: {result:?}"
        );
    }
}

#[tokio::test]
async fn register_sends_nothing_with_a_recovery_proof_out_of_range_or_a_bad_gate_url() {
    let device = Secret::new(DEVICE_TOKEN);
    for recovery in ["", "fifteen-chars-x", &"x".repeat(513)] {
        let result = gate_register("https://gate.example.com", &device, "builder", recovery).await;
        assert!(matches!(result, Err(GateError::Invalid(_))), "{result:?}");
    }
    for url in [
        "",
        "http://gate.example.com",
        "https://gate.example.com/v1",
        "nonsense",
    ] {
        let result = gate_register(url, &device, "builder", RECOVERY).await;
        assert!(
            matches!(result, Err(GateError::Invalid(_))),
            "{url}: {result:?}"
        );
        let result = gate_delete_self(url, &Secret::new(AGENT_TOKEN)).await;
        assert!(
            matches!(result, Err(GateError::Invalid(_))),
            "{url}: {result:?}"
        );
    }
}

#[tokio::test]
async fn each_gate_refusal_is_classified() {
    type Expected = fn(&GateError) -> bool;
    let cases: Vec<(&str, String, Expected)> = vec![
        ("401 Unauthorized", error_body(GATE_UNAUTHENTICATED), |e| {
            matches!(e, GateError::Unauthenticated)
        }),
        (
            "403 Forbidden",
            error_body(GATE_DENIED),
            |e| matches!(e, GateError::Refused { code } if code == GATE_DENIED),
        ),
        (
            "403 Forbidden",
            error_body(GATE_NAME_SCOPE),
            |e| matches!(e, GateError::Refused { code } if code == GATE_NAME_SCOPE),
        ),
        ("409 Conflict", error_body(GATE_NAME_TAKEN), |e| {
            matches!(e, GateError::NameTaken)
        }),
        ("429 Too Many Requests", error_body("rate_limited"), |e| {
            matches!(e, GateError::RateLimited { retry_after: None })
        }),
        (
            "503 Service Unavailable",
            error_body("relaygate_unavailable"),
            |e| matches!(e, GateError::Unavailable { retry_after: None }),
        ),
        // A proxy's 502 has no JSON at all.
        ("502 Bad Gateway", "<html>bad gateway</html>".into(), |e| {
            matches!(e, GateError::Unavailable { retry_after: None })
        }),
        // Codes count only with their status, and other failures pass through.
        ("401 Unauthorized", error_body("unauthorized"), |e| {
            matches!(e, GateError::Other(_))
        }),
        ("400 Bad Request", error_body(GATE_NAME_TAKEN), |e| {
            matches!(e, GateError::Other(_))
        }),
        ("403 Forbidden", error_body("forbidden"), |e| {
            matches!(e, GateError::Other(_))
        }),
        ("500 Internal Server Error", error_body("internal"), |e| {
            matches!(e, GateError::Other(_))
        }),
    ];
    for (status, body, expected) in cases {
        let (result, _) = register_answered(status, &[], &body).await;
        let error = result.unwrap_err();
        assert!(expected(&error), "{status} {body}: {error:?}");
    }
}

#[tokio::test]
async fn retry_after_is_read_in_seconds_and_as_an_http_date() {
    let (result, _) = register_answered(
        "503 Service Unavailable",
        &[("Retry-After", "1".into())],
        &error_body("relaygate_unavailable"),
    )
    .await;
    assert!(matches!(
        result,
        Err(GateError::Unavailable { retry_after }) if retry_after == seconds(1)
    ));

    let (result, _) = register_answered(
        "429 Too Many Requests",
        &[("Retry-After", "7".into())],
        &error_body("rate_limited"),
    )
    .await;
    assert!(matches!(
        result,
        Err(GateError::RateLimited { retry_after }) if retry_after == seconds(7)
    ));

    let date = (chrono::Utc::now() + chrono::Duration::seconds(120))
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let (result, _) = register_answered(
        "502 Bad Gateway",
        &[("Retry-After", date)],
        &error_body("relaygate_unavailable"),
    )
    .await;
    match result {
        Err(GateError::Unavailable {
            retry_after: Some(wait),
        }) => assert!((100..=121).contains(&wait.as_secs()), "{wait:?}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn patch_self_sends_the_agent_token_and_only_the_fields_given() {
    let (url, server) = gate("200 OK", &[], r#"{"ok":true,"data":{"name":"builder"}}"#);
    let patch = GateSelfPatch {
        status: Some("busy".into()),
        skills: Some(vec![json!({"id": "review"})]),
        ..GateSelfPatch::default()
    };
    let agent = gate_patch_self(&url, &Secret::new(AGENT_TOKEN), &patch)
        .await
        .unwrap();
    assert_eq!(agent, json!({"name": "builder"}));
    let request = server.join().unwrap();
    assert!(request.starts_with("PATCH /v1/agent "), "{request}");
    assert!(request
        .to_lowercase()
        .contains(&format!("authorization: bearer {AGENT_TOKEN}")));
    let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        sent,
        json!({"status": "busy", "skills": [{"id": "review"}]})
    );
}

#[tokio::test]
async fn an_expired_agent_token_on_patch_is_unauthenticated() {
    let (url, server) = gate("401 Unauthorized", &[], &error_body(GATE_UNAUTHENTICATED));
    let result = gate_patch_self(&url, &Secret::new(AGENT_TOKEN), &GateSelfPatch::default()).await;
    server.join().unwrap();
    assert!(
        matches!(result, Err(GateError::Unauthenticated)),
        "{result:?}"
    );
}

#[tokio::test]
async fn delete_self_sends_the_agent_token_and_accepts_any_success() {
    for (status, body) in [
        ("204 No Content", ""),
        ("200 OK", ""),
        ("200 OK", r#"{"ok":true,"data":{"deleted":true}}"#),
    ] {
        let (url, server) = gate(status, &[], body);
        gate_delete_self(&url, &Secret::new(AGENT_TOKEN))
            .await
            .unwrap_or_else(|error| panic!("{status} {body}: {error:?}"));
        let request = server.join().unwrap();
        assert!(request.starts_with("DELETE /v1/agent "), "{request}");
        assert!(request
            .to_lowercase()
            .contains(&format!("authorization: bearer {AGENT_TOKEN}")));
        assert!(!request.to_lowercase().contains(DEVICE_TOKEN));
    }
}

#[test]
fn no_credential_is_debug_printed() {
    let registration = GateRegistration {
        agent_id: "ag_1".into(),
        gid: 7,
        token: Secret::new(AGENT_TOKEN),
        expires_at: chrono::Utc::now(),
        user_id: "usr_1".into(),
    };
    let printed = format!("{registration:?}");
    assert!(!printed.contains(AGENT_TOKEN), "{printed}");
    let recovery = new_recovery().unwrap();
    assert!(!format!("{recovery:?}").contains(recovery.expose()));
}

#[test]
fn a_new_recovery_proof_is_32_random_bytes_in_base64url() {
    let first = new_recovery().unwrap();
    let second = new_recovery().unwrap();
    assert_eq!(first.expose().len(), 43);
    assert!(RECOVERY_CHARS.contains(&first.expose().len()));
    assert!(first
        .expose()
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_ne!(first, second);
}

#[test]
fn only_relaygates_401_code_means_register_again() {
    let api = |status: u16, code: &str| RelayError::Api {
        code: code.into(),
        message: "no".into(),
        status,
        request_id: None,
        attempts: 1,
        retry_after_ms: None,
        details: None,
    };
    assert!(is_gate_unauthenticated(&api(401, GATE_UNAUTHENTICATED)));
    assert!(!is_gate_unauthenticated(&api(401, "unauthorized")));
    assert!(!is_gate_unauthenticated(&api(403, GATE_UNAUTHENTICATED)));
    assert!(!is_gate_unauthenticated(&RelayError::InvalidResponse(
        "x".into()
    )));
}

const LAUNCH_CREDENTIAL: &str = "sh_lt_launch0123456789";

/// A launch's credential registers the agent by name alone: no recovery
/// proof, the credential as the bearer, the same answer read.
#[tokio::test]
async fn a_launch_register_sends_the_credential_and_the_name_alone() {
    let body = format!(r#"{{"ok":true,"data":{}}}"#, registration_body());
    let (url, server) = gate("201 Created", &[], &body);
    let registration = gate_register_launch(&url, &Secret::new(LAUNCH_CREDENTIAL), "builder")
        .await
        .unwrap();
    assert_eq!(registration.agent_id, "ag_1");
    assert_eq!(registration.token.expose(), "rg_issued");
    let request = server.join().unwrap();
    assert!(request.starts_with("POST /v1/register "), "{request}");
    assert!(request
        .to_lowercase()
        .contains(&format!("authorization: bearer {LAUNCH_CREDENTIAL}")));
    let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(sent, json!({"name": "builder"}));
}

/// A refresh sends the agent's own token and no body, and reads the new
/// token; an answer without an `rg_` token is refused.
#[tokio::test]
async fn a_refresh_sends_the_agent_token_and_reads_the_new_one() {
    let (url, server) = gate(
        "200 OK",
        &[],
        r#"{"ok":true,"data":{"token":"rg_next","expires_at":"2026-11-16T11:00:00.000Z"}}"#,
    );
    let refreshed = gate_refresh(&url, &Secret::new(AGENT_TOKEN)).await.unwrap();
    assert_eq!(refreshed.token.expose(), "rg_next");
    assert_eq!(
        refreshed.expires_at,
        chrono::DateTime::parse_from_rfc3339("2026-11-16T11:00:00Z").unwrap()
    );
    let request = server.join().unwrap();
    assert!(request.starts_with("POST /v1/token/refresh "), "{request}");
    assert!(request
        .to_lowercase()
        .contains(&format!("authorization: bearer {AGENT_TOKEN}")));

    let (url, server) = gate(
        "200 OK",
        &[],
        r#"{"token":"at_live_x","expires_at":"2026-11-16T11:00:00Z"}"#,
    );
    assert!(gate_refresh(&url, &Secret::new(AGENT_TOKEN)).await.is_err());
    server.join().unwrap();

    let (url, server) = gate("401 Unauthorized", &[], &error_body(GATE_UNAUTHENTICATED));
    assert!(matches!(
        gate_refresh(&url, &Secret::new(AGENT_TOKEN)).await,
        Err(GateError::Unauthenticated)
    ));
    server.join().unwrap();
}
