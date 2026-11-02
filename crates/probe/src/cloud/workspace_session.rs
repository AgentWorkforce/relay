//! The workspace-scoped RelayHistory session exchange — issuing the
//! short-lived tokens an install syncs history with.

use super::{
    cloud_json_response, cloud_send, cloud_site, history_origin, require_history_destination,
    rotate_key, workspace_history_origin, HistoryUnresolved, RenewalFailure, StoredAuth,
    WorkspaceSessionResponse,
};
use anyhow::Result;
use serde::Deserialize;

/// What Cloud answered a workspace-session request.
pub(crate) enum Issued {
    /// A well-formed session for the scope asked for, for whichever
    /// workspace Cloud named; the caller checks that it is the one asked.
    Session(StoredAuth),
    /// Cloud answered with this non-success status.
    Status(u16),
    /// Cloud did not answer.
    Unreachable,
    /// The workspace's own RelayHistory answered its sign-in with this
    /// non-success status.
    HistoryStatus(u16),
    /// The workspace's own RelayHistory did not answer its sign-in.
    HistoryUnreachable,
}

/// Cloud's answer for a workspace with its own RelayHistory: Cloud never
/// holds a key to that History, so it hands over a short-lived Agent Relay
/// assertion for the probe to exchange there itself.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientExchangeResponse {
    base_url: String,
    org_id: String,
    workspace_id: String,
    assertion: String,
    #[serde(default)]
    scopes: Vec<String>,
}

/// The workspace RelayHistory's answer to `POST /v1/cli/login`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLoginResponse {
    access_token: String,
    access_token_expires_at: String,
    #[serde(default)]
    refresh_token: Option<String>,
    token_type: String,
    #[serde(default)]
    scopes: Vec<String>,
}

/// Why sign-in failed when the workspace's own RelayHistory, not Cloud,
/// could not start the session.
pub(super) const HISTORY_UNAVAILABLE: &str = "You are signed in, but your workspace's RelayHistory could not start your history connection. Please try again shortly. If this continues, contact your workspace admin.";

/// A renewal's session, or why there is none. Cloud refusing this person or
/// workspace needs them; a rate limit or an outage, Cloud's or the
/// workspace History's, passes by itself.
pub(super) fn renewed(issued: Result<Issued>) -> std::result::Result<StoredAuth, RenewalFailure> {
    match issued {
        Ok(Issued::Session(session)) => Ok(session),
        Ok(Issued::Status(401 | 403 | 404)) => Err(RenewalFailure::CloudRefused),
        Ok(
            Issued::Status(429 | 500..=599)
            | Issued::Unreachable
            | Issued::HistoryStatus(429 | 500..=599)
            | Issued::HistoryUnreachable,
        ) => Err(RenewalFailure::CloudUnreachable),
        // Any other status (the workspace's own History refusing the
        // assertion included), or an answer that is not a usable session.
        Ok(Issued::Status(_) | Issued::HistoryStatus(_)) | Err(_) => {
            Err(RenewalFailure::CloudRefused)
        }
    }
}

/// [`workspace_session`]'s exchange, without its errors or workspace check.
pub(crate) fn issue_workspace_session(
    api_url: &str,
    bearer: &str,
    workspace: &str,
    mode: &str,
    label: &str,
) -> Result<Issued> {
    let required_scope = match mode {
        "sync" => "rth:sync",
        "read" => "rth:read",
        other => anyhow::bail!("invalid mode '{other}' (expected `read` or `sync`)"),
    };
    rotate_key::ensure_workspace_id(workspace)?;
    let site = cloud_site(api_url)?;
    let Some(response) = cloud_send(
        "POST",
        &format!("{api_url}/api/v1/workspaces/{workspace}/relayhistory/session"),
        Some(bearer),
        Some(serde_json::json!({ "mode": mode, "label": label })),
    ) else {
        return Ok(Issued::Unreachable);
    };
    let status = response.status();
    if status != 200 {
        return Ok(Issued::Status(status));
    }
    let answer = cloud_json_response(response)?;
    if answer.get("exchange").and_then(serde_json::Value::as_str) == Some("client") {
        let answer: ClientExchangeResponse = serde_json::from_value(answer)?;
        let base_url = client_exchange_origin(&answer, &site, required_scope)?;
        return exchange_at_history(&base_url, answer, label, required_scope);
    }
    let session: WorkspaceSessionResponse = serde_json::from_value(answer)?;
    issued_session(session, &site, required_scope).map(Issued::Session)
}

/// The History a client-exchange answer may be exchanged at: only the
/// workspace's own origin. Cloud exchanges for the default stage itself, so
/// an answer asking the probe to sign in there is refused.
fn client_exchange_origin(
    answer: &ClientExchangeResponse,
    site: &str,
    required_scope: &str,
) -> Result<String> {
    let base_url = workspace_history_origin(&answer.base_url, site)?;
    anyhow::ensure!(
        history_origin(&base_url, site).is_err(),
        "untrusted history origin"
    );
    anyhow::ensure!(
        !answer.org_id.is_empty()
            && !answer.assertion.is_empty()
            && (answer.scopes.is_empty()
                || answer.scopes.iter().any(|scope| scope == required_scope)),
        "invalid scoped session"
    );
    Ok(base_url)
}

/// Exchange Cloud's assertion at the workspace's own RelayHistory, `POST
/// {base_url}/v1/cli/login`: bounded and redirect-free like a Cloud request,
/// carrying no Cloud bearer, and keeping the assertion and every response
/// body out of errors.
fn exchange_at_history(
    base_url: &str,
    answer: ClientExchangeResponse,
    label: &str,
    required_scope: &str,
) -> Result<Issued> {
    // A name that does not resolve right now is an outage, not a refusal;
    // a refused address stays an error.
    if let Err(error) = require_history_destination(base_url) {
        if error.is::<HistoryUnresolved>() {
            return Ok(Issued::HistoryUnreachable);
        }
        return Err(error);
    }
    let Some(response) = cloud_send(
        "POST",
        &format!("{base_url}/v1/cli/login"),
        None,
        Some(serde_json::json!({ "agentRelayToken": answer.assertion, "label": label })),
    ) else {
        return Ok(Issued::HistoryUnreachable);
    };
    let status = response.status();
    if !matches!(status, 200 | 201) {
        return Ok(Issued::HistoryStatus(status));
    }
    let login: HistoryLoginResponse = cloud_json_response(response)
        .and_then(|value| Ok(serde_json::from_value(value)?))
        .map_err(|_| anyhow::anyhow!("invalid history session"))?;
    // The History grants the scope itself; an answer naming none is refused.
    anyhow::ensure!(
        login.token_type == "Bearer"
            && !login.access_token.is_empty()
            && login
                .refresh_token
                .as_deref()
                .is_some_and(|token| !token.is_empty())
            && login.scopes.iter().any(|scope| scope == required_scope),
        "invalid history session"
    );
    Ok(Issued::Session(StoredAuth {
        base_url: base_url.to_string(),
        access_token: login.access_token,
        access_token_expires_at: Some(login.access_token_expires_at),
        refresh_token: login.refresh_token,
        org_id: Some(answer.org_id),
        workspace_id: Some(answer.workspace_id),
    }))
}

/// The session in Cloud's answer, once its stage and scope are trusted.
fn issued_session(
    session: WorkspaceSessionResponse,
    site: &str,
    required_scope: &str,
) -> Result<StoredAuth> {
    // Cloud names the stage: production, or the workspace's own registered
    // RelayHistory origin.
    let base_url = workspace_history_origin(&session.base_url, site)?;
    anyhow::ensure!(
        !session.org_id.is_empty()
            && (session.scopes.is_empty()
                || session.scopes.iter().any(|scope| scope == required_scope)),
        "invalid scoped session"
    );
    Ok(StoredAuth {
        base_url,
        access_token: session.access_token,
        access_token_expires_at: Some(session.access_token_expires_at),
        refresh_token: Some(session.refresh_token),
        org_id: Some(session.org_id),
        workspace_id: Some(session.workspace_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{history_origin, require_secure_transport, site_origin};

    const SITE: &str = "https://agentrelay.com";
    const WORKSPACE_ORIGIN: &str = "https://history.hookdeck.example";

    fn answer(base_url: &str) -> WorkspaceSessionResponse {
        serde_json::from_value(serde_json::json!({
            "baseUrl": base_url,
            "orgId": "org_1",
            "workspaceId": "ws_1",
            "accessToken": "rth_at_issued",
            "refreshToken": "rth_rt_issued",
            "accessTokenExpiresAt": "2999-01-01T00:00:00Z",
            "scopes": ["rth:read", "rth:sync"],
        }))
        .unwrap()
    }

    /// The origin a workspace registered in Cloud is trusted for upload,
    /// login and refresh once Cloud names it, with no development switch.
    #[test]
    fn the_workspace_origin_cloud_names_is_trusted_without_the_dev_flag() {
        let _guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        std::env::remove_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");

        let session = issued_session(answer(&format!("{WORKSPACE_ORIGIN}/")), SITE, "rth:sync")
            .expect("Cloud's workspace origin is accepted");
        assert_eq!(session.base_url, WORKSPACE_ORIGIN);
        // Every authenticated request and refresh to it passes the transport guard.
        assert!(require_secure_transport(&session.base_url).is_ok());
        // An explicit https port is part of the origin Cloud names.
        assert_eq!(
            issued_session(
                answer("https://history.hookdeck.example:8443"),
                SITE,
                "rth:sync"
            )
            .unwrap()
            .base_url,
            "https://history.hookdeck.example:8443"
        );
        // The default stage is unaffected.
        assert_eq!(
            issued_session(answer("https://history.agentrelay.com"), SITE, "rth:sync")
                .unwrap()
                .base_url,
            "https://history.agentrelay.com"
        );
        // Nothing but Cloud's answer widens the Cloud site itself.
        assert!(site_origin("https://cloud.hookdeck.example").is_err());

        if let Some(value) = previous {
            std::env::set_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", value);
        }
    }

    /// Even from Cloud, a workspace origin must be an https origin on a DNS
    /// name; and a local Cloud never names a remote stage.
    #[test]
    fn a_workspace_origin_that_is_not_a_plain_https_origin_is_refused() {
        for raw in [
            "http://history.hookdeck.example",
            "https://history.hookdeck.example/v1",
            "https://history.hookdeck.example/?tenant=a",
            "https://history.hookdeck.example/#x",
            "https://user:secret@history.hookdeck.example",
            "https://localhost",
            "https://history.localhost",
            "https://127.0.0.1",
            "https://10.0.0.5",
            "https://[::1]",
            "https://intranet",
            "ftp://history.hookdeck.example",
            "history.hookdeck.example",
        ] {
            assert!(
                issued_session(answer(raw), SITE, "rth:sync").is_err(),
                "{raw}"
            );
        }
        assert!(issued_session(
            answer(WORKSPACE_ORIGIN),
            "http://127.0.0.1:3100",
            "rth:sync"
        )
        .is_err());
    }

    /// A trailing DNS dot spells the same host as an absolute name, so
    /// `localhost.` or `intranet.` must not slip past the loopback and
    /// single-label checks; internal-only suffixes are refused too, matching
    /// the rule Cloud applies when the origin is registered.
    #[test]
    fn a_workspace_origin_on_an_absolute_or_internal_name_is_refused() {
        for raw in [
            "https://localhost.",
            "https://localhost.:8443",
            "https://history.localhost.",
            "https://intranet.",
            "https://history.hookdeck.example.",
            "https://history.corp.internal",
            "https://history.local",
            "https://history.lan",
            "https://history.home.arpa",
        ] {
            assert!(
                issued_session(answer(raw), SITE, "rth:sync").is_err(),
                "{raw}"
            );
            assert!(
                client_exchange_origin(&client_answer(raw), SITE, "rth:sync").is_err(),
                "{raw}"
            );
        }
    }

    /// A workspace History on a DNS name that resolves to this machine or a
    /// private network is refused before Cloud's assertion is sent there.
    /// `localhost` stands in for such a name: it resolves without a network.
    #[test]
    fn a_workspace_history_resolving_to_a_private_address_gets_no_assertion() {
        let _guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        std::env::remove_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let base_url = format!("https://localhost:{port}");
        assert!(
            exchange_at_history(&base_url, client_answer(&base_url), "Probe", "rth:sync").is_err()
        );
        // Nothing connected, so nothing was sent.
        assert!(listener.accept().is_err());
        if let Some(value) = previous {
            std::env::set_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", value);
        }
    }

    /// A workspace History whose name does not resolve right now is an
    /// outage, so renewal reports it as unreachable and retries; a name that
    /// resolves to a refused address is still a refusal.
    #[test]
    fn an_unresolved_workspace_history_is_unreachable_not_refused() {
        let _guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        std::env::remove_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        let exchange = |base_url: &str| {
            exchange_at_history(base_url, client_answer(base_url), "Probe", "rth:sync")
        };
        let unresolved = "https://history.relayhistory.invalid";
        assert!(matches!(
            exchange(unresolved),
            Ok(Issued::HistoryUnreachable)
        ));
        assert_eq!(
            renewed(exchange(unresolved)).unwrap_err(),
            RenewalFailure::CloudUnreachable
        );
        assert_eq!(
            renewed(exchange("https://localhost:8443")).unwrap_err(),
            RenewalFailure::CloudRefused
        );
        if let Some(value) = previous {
            std::env::set_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", value);
        }
    }

    /// Outside Cloud's answer the custom origin stays untrusted: the rule the
    /// saved configuration, pushed sessions and every other path use refuses it.
    #[test]
    fn the_workspace_origin_is_refused_when_cloud_did_not_name_it() {
        assert!(history_origin(WORKSPACE_ORIGIN, SITE).is_err());
        assert!(crate::cloud::pushed_history_origin(WORKSPACE_ORIGIN).is_err());
    }

    const ASSERTION: &str = "ra_assertion_private";

    fn client_answer(base_url: &str) -> ClientExchangeResponse {
        serde_json::from_value(serde_json::json!({
            "exchange": "client",
            "baseUrl": base_url,
            "orgId": "org_1",
            "workspaceId": "ws_1",
            "assertion": ASSERTION,
            "scopes": ["rth:read", "rth:sync"],
        }))
        .unwrap()
    }

    fn history_login(token_type: &str, refresh_token: Option<&str>, scopes: &[&str]) -> String {
        let mut login = serde_json::json!({
            "sessionId": "sess_1",
            "accessToken": "rth_at_history",
            "accessTokenExpiresAt": "2999-01-01T00:00:00Z",
            "refreshTokenExpiresAt": "2999-02-01T00:00:00Z",
            "tokenType": token_type,
            "scopes": scopes,
        });
        if let Some(token) = refresh_token {
            login["refreshToken"] = token.into();
        }
        login.to_string()
    }

    /// The request line, headers and body a mock server saw.
    type SeenRequest = (String, std::collections::HashMap<String, String>, String);

    /// Serves one History sign-in with `response` (status line onward) and
    /// hands back the request it saw.
    fn history_server(response: String) -> (String, std::thread::JoinHandle<SeenRequest>) {
        use std::io::Write;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = crate::cloud::tests::read_http_request(&mut stream);
            stream.write_all(response.as_bytes()).unwrap();
            request
        });
        (base_url, server)
    }

    fn json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// For a workspace's own History, Cloud only vouches for the person: the
    /// probe signs in there itself with Cloud's assertion, so Cloud never
    /// holds a key to that History.
    #[test]
    fn a_client_exchange_signs_in_at_the_workspace_history_itself() {
        assert_eq!(
            client_exchange_origin(
                &client_answer(&format!("{WORKSPACE_ORIGIN}/")),
                SITE,
                "rth:sync"
            )
            .unwrap(),
            WORKSPACE_ORIGIN
        );

        let (base_url, server) = history_server(json_response(
            "201 Created",
            &history_login("Bearer", Some("rth_rt_history"), &["rth:read", "rth:sync"]),
        ));
        let issued =
            exchange_at_history(&base_url, client_answer(&base_url), "Probe", "rth:sync").unwrap();
        let (first_line, headers, body) = server.join().unwrap();
        assert!(
            first_line.starts_with("POST /v1/cli/login "),
            "{first_line}"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "agentRelayToken": ASSERTION, "label": "Probe" })
        );
        // The Cloud bearer never reaches the workspace's History.
        assert!(!headers.contains_key("authorization"));
        let Issued::Session(session) = issued else {
            panic!("no session");
        };
        assert_eq!(
            session,
            StoredAuth {
                base_url,
                access_token: "rth_at_history".into(),
                access_token_expires_at: Some("2999-01-01T00:00:00Z".into()),
                refresh_token: Some("rth_rt_history".into()),
                org_id: Some("org_1".into()),
                workspace_id: Some("ws_1".into()),
            }
        );
    }

    /// Cloud exchanges for the default History itself; an answer asking the
    /// probe to sign in there is refused before any request.
    #[test]
    fn a_client_exchange_naming_the_default_history_is_refused() {
        for raw in [
            "https://history.agentrelay.com",
            "https://history.agentrelay.com/",
        ] {
            assert!(
                client_exchange_origin(&client_answer(raw), SITE, "rth:sync").is_err(),
                "{raw}"
            );
        }
    }

    /// A client exchange is held to the same origin rule as a token-bearing
    /// answer, and to the same organization and scope checks.
    #[test]
    fn a_client_exchange_for_an_untrusted_origin_or_scope_is_refused() {
        for raw in [
            "http://history.hookdeck.example",
            "https://history.hookdeck.example/v1",
            "https://user:secret@history.hookdeck.example",
            "https://127.0.0.1",
            "https://10.0.0.5",
            "https://[::1]",
            "https://localhost",
            "https://intranet",
        ] {
            assert!(
                client_exchange_origin(&client_answer(raw), SITE, "rth:sync").is_err(),
                "{raw}"
            );
        }
        let mut answer = client_answer(WORKSPACE_ORIGIN);
        answer.scopes = vec!["rth:read".into()];
        assert!(client_exchange_origin(&answer, SITE, "rth:sync").is_err());
        let mut answer = client_answer(WORKSPACE_ORIGIN);
        answer.org_id.clear();
        assert!(client_exchange_origin(&answer, SITE, "rth:sync").is_err());
        let mut answer = client_answer(WORKSPACE_ORIGIN);
        answer.assertion.clear();
        assert!(client_exchange_origin(&answer, SITE, "rth:sync").is_err());
    }

    /// The History's answer must be a bearer session for the scope asked
    /// for; a refusal names neither the assertion nor the answer.
    #[test]
    fn a_history_answer_that_is_not_a_usable_session_is_refused_privately() {
        for login in [
            history_login("private-mac", Some("rth_rt_private"), &["rth:sync"]),
            history_login("Bearer", None, &["rth:sync"]),
            history_login("Bearer", Some(""), &["rth:sync"]),
            history_login("Bearer", Some("rth_rt_private"), &["rth:read"]),
            history_login("Bearer", Some("rth_rt_private"), &[]),
            r#"{"accessToken":"private-token","tokenType":"Bearer"}"#.to_string(),
            r#"{"accessToken":1,"tokenType":"private-type"}"#.to_string(),
            "private-not-json".to_string(),
        ] {
            let (base_url, server) = history_server(json_response("200 OK", &login));
            let result =
                exchange_at_history(&base_url, client_answer(&base_url), "Probe", "rth:sync");
            server.join().unwrap();
            let message = match result {
                Err(error) => format!("{error:#}"),
                Ok(_) => panic!("accepted {login}"),
            };
            assert!(!message.contains(ASSERTION), "{message}");
            assert!(!message.contains("private"), "{message}");
            assert!(!message.contains("rth_at_history"), "{message}");
        }
    }

    /// A History redirecting its sign-in is not followed: the assertion
    /// goes to the origin Cloud named and nowhere else.
    #[test]
    fn a_history_redirect_is_not_followed() {
        for (status, code) in [("302 Found", 302), ("307 Temporary Redirect", 307)] {
            let elsewhere = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            elsewhere.set_nonblocking(true).unwrap();
            let (base_url, server) = history_server(format!(
                "HTTP/1.1 {status}\r\nLocation: http://{}/v1/cli/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                elsewhere.local_addr().unwrap()
            ));
            let issued =
                exchange_at_history(&base_url, client_answer(&base_url), "Probe", "rth:sync")
                    .unwrap();
            server.join().unwrap();
            assert!(
                matches!(issued, Issued::HistoryStatus(seen) if seen == code),
                "{status}"
            );
            assert!(
                matches!(
                    elsewhere.accept(),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
                ),
                "{status}"
            );
        }
    }
}
