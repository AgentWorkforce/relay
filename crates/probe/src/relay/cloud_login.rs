//! The two ways a person signs this computer in to Agent Relay Cloud.
//!
//! - **Browser** (`BrowserLogin`): a loopback receiver on `127.0.0.1` with
//!   PKCE. The core builds the login URL, the UI opens it, and Cloud
//!   redirects back to the receiver with a short-lived handoff token that
//!   `cloud_session::exchange_handoff` trades for a renewable session.
//! - **Device** (`DeviceLogin`): OAuth device authorization. The device code
//!   never leaves this value; callers get only the link, the human code and
//!   timing.
//!
//! Either way, a link or a callback naming another origin than the site
//! being signed in to is refused before anything is shown or kept.

use crate::relay::cloud_http;
use crate::relay::cloud_session::{api_base, iso};
use crate::relay::contract::account::SignInLink;
use crate::relay::store::CloudSession;
use crate::relay::workspace::{validated_base_url, Secret};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Why a sign-in did not finish. `state` is `denied`, `expired`, `cancelled`
/// or `error`; `message` is safe to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginError {
    pub state: &'static str,
    pub message: String,
}

impl LoginError {
    fn error(message: impl Into<String>) -> LoginError {
        LoginError {
            state: "error",
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LoginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The name Cloud shows for this computer's device sign-in.
pub fn client_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "Agent Relay for macOS"
    } else {
        "Agent Relay for Linux"
    }
}

/// The validated origin of an absolute URL, or `None` for one with user
/// info or that is not an origin credentials may go to.
fn origin_of(text: &str) -> Option<String> {
    let url = url::Url::parse(text).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    validated_base_url(&format!("{}://{}{port}", url.scheme(), url.host_str()?))
}

fn inner(value: &Value) -> &Value {
    match value.get("data") {
        Some(data) if data.is_object() => data,
        _ => value,
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// A device sign-in waiting for the person's approval.
pub struct DeviceLogin {
    pub site_url: String,
    device_code: Secret,
    /// The desktop proof, kept here until the poll; none for a sign-in that
    /// is not this desktop installation (Relay Connect's host).
    verifier: Option<Secret>,
    pub verification_url: String,
    pub verification_url_complete: Option<String>,
    pub user_code: Option<String>,
    pub expires_at_ms: i64,
    /// Seconds between polls.
    pub interval: u64,
}

fn device_start_body(desktop: Option<(&str, &Secret)>) -> Value {
    match desktop {
        Some((host_name, verifier)) => json!({ "client_name": client_name(),
            "desktop_code_challenge": base64_url(&Sha256::digest(verifier.expose().as_bytes())),
            "desktop_code_challenge_method": "S256", "desktop_host_name": host_name }),
        None => json!({ "client_name": client_name() }),
    }
}

fn device_poll_body(device_code: &Secret, verifier: Option<&Secret>) -> Value {
    let mut body = json!({ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device_code.expose() });
    if let Some(verifier) = verifier {
        body["desktop_code_verifier"] = json!(verifier.expose());
    }
    body
}

impl DeviceLogin {
    /// Starts a device sign-in on `site_url`. With `desktop_host`, it is this
    /// desktop installation's sign-in: it carries a proof Cloud records, and
    /// the approval page names the host. Without it (Relay Connect's host
    /// sign-in), an ordinary device login.
    pub async fn begin(
        site_url: &str,
        desktop_host: Option<&str>,
    ) -> Result<DeviceLogin, LoginError> {
        let site = validated_base_url(site_url).ok_or_else(|| {
            LoginError::error("The Agent Relay site is not a trusted https origin.")
        })?;
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|_| LoginError::error("Could not start local sign-in. Try again."))?;
        let verifier = Secret::new(base64_url(&bytes));
        let desktop_host = match desktop_host {
            Some(host_name) => Some(valid_desktop_host(host_name).ok_or_else(|| {
                LoginError::error("Could not identify this computer for sign-in.")
            })?),
            None => None,
        };
        let desktop_host = desktop_host.as_deref();
        let answer = cloud_http::send(
            "POST",
            format!("{}/auth/device/start", api_base(&site)),
            None,
            Some(device_start_body(
                desktop_host.map(|host| (host, &verifier)),
            )),
            Duration::from_secs(30),
        )
        .await
        .map_err(|_| LoginError::error("Could not reach Agent Relay Cloud."))?;
        let grant = inner(&answer.body);
        let unsafe_start =
            || LoginError::error("Agent Relay Cloud did not start a safe device login.");
        if !matches!(answer.status, 200 | 201) {
            return Err(unsafe_start());
        }
        let device_code = text(grant, "device_code").ok_or_else(unsafe_start)?;
        let verification = text(grant, "verification_uri")
            .filter(|url| origin_of(url).as_deref() == Some(site.as_str()))
            .ok_or_else(unsafe_start)?;
        let complete = text(grant, "verification_uri_complete");
        if complete
            .as_deref()
            .is_some_and(|url| origin_of(url).as_deref() != Some(site.as_str()))
        {
            return Err(LoginError::error(
                "Agent Relay Cloud returned an approval link on another site.",
            ));
        }
        let seconds = grant["expires_in"].as_i64().unwrap_or(600).clamp(1, 900);
        Ok(DeviceLogin {
            site_url: site,
            device_code: Secret::new(device_code),
            verifier: desktop_host.map(|_| verifier),
            verification_url: verification,
            verification_url_complete: complete,
            user_code: text(grant, "user_code"),
            expires_at_ms: crate::relay::state::now_ms() + seconds * 1000,
            interval: grant["interval"].as_u64().unwrap_or(5).clamp(1, 60),
        })
    }

    /// What the person needs to approve this computer.
    pub fn public(&self) -> SignInLink {
        SignInLink {
            verification_url: Some(self.verification_url.clone()),
            verification_url_complete: self.verification_url_complete.clone(),
            user_code: self.user_code.clone(),
            expires_at: Some(iso(self.expires_at_ms)),
            interval: Some(self.interval),
        }
    }

    /// Waits for the approval. Dropping the future cancels it.
    pub async fn poll(&self) -> Result<CloudSession, LoginError> {
        let mut delay = self.interval;
        let api = format!("{}/cloud", self.site_url);
        loop {
            let left = self.expires_at_ms - crate::relay::state::now_ms();
            if left <= 0 {
                break;
            }
            // Never sleeps past the approval's lifetime.
            tokio::time::sleep(Duration::from_secs(delay).min(Duration::from_millis(left as u64)))
                .await;
            if crate::relay::state::now_ms() >= self.expires_at_ms {
                break;
            }
            let Ok(answer) = cloud_http::send(
                "POST",
                format!("{}/auth/device/token", api_base(&self.site_url)),
                None,
                Some(device_poll_body(&self.device_code, self.verifier.as_ref())),
                Duration::from_secs(30),
            )
            .await
            else {
                continue;
            };
            let value = inner(&answer.body);
            if answer.status == 200 {
                let access = text(value, "access_token").ok_or_else(|| {
                    LoginError::error("Agent Relay Cloud did not return a sign-in session.")
                })?;
                if value["api_url"]
                    .as_str()
                    .is_some_and(|url| url.trim_end_matches('/') != api)
                {
                    return Err(LoginError::error(
                        "Agent Relay Cloud changed origin during sign-in.",
                    ));
                }
                let expires_at = text(value, "access_token_expires_at").or_else(|| {
                    value["expires_in"].as_f64().map(|seconds| {
                        iso(crate::relay::state::now_ms() + (seconds * 1000.0) as i64)
                    })
                });
                return Ok(CloudSession {
                    access_token: Secret::new(access),
                    access_token_expires_at: expires_at,
                    refresh_token: text(value, "refresh_token").map(Secret::new),
                    refresh_token_expires_at: text(value, "refresh_token_expires_at"),
                    site_url: self.site_url.clone(),
                });
            }
            let code = value["error"].as_str();
            if answer.status == 429 || code == Some("slow_down") {
                delay = (delay + 5).min(60);
                continue;
            }
            if answer.status >= 500 || code == Some("authorization_pending") {
                continue;
            }
            return Err(LoginError {
                state: if code == Some("access_denied") {
                    "denied"
                } else {
                    "expired"
                },
                message: "Device sign-in was declined or expired. Start sign-in again.".into(),
            });
        }
        Err(LoginError {
            state: "expired",
            message: "Device sign-in expired. Start sign-in again.".into(),
        })
    }
}

/// Percent-encodes a query value the way the macOS app's `URLComponents`
/// does: URL punctuation stays, `&`, `=`, `+` and `#` are escaped. Cloud's
/// login routes are tested against exactly this form.
fn query_value(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || b"-._~!$'()*,;:@/?".contains(&byte);
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn query(items: &[(&str, &str)]) -> String {
    items
        .iter()
        .map(|(name, value)| format!("{name}={}", query_value(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// This computer's name as a desktop sign-in sends it for the approval page
/// to show: trimmed, 1 to 80 UTF-16 units, no control characters.
fn valid_desktop_host(host_name: &str) -> Option<String> {
    let host_name = host_name.trim();
    (!host_name.is_empty()
        && host_name.encode_utf16().count() <= 80
        && !host_name.chars().any(char::is_control))
    .then(|| host_name.to_string())
}

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A browser sign-in: a loopback listener that only this attempt's state
/// and PKCE verifier can complete.
pub struct BrowserLogin {
    listener: TcpListener,
    port: u16,
    state: String,
    verifier: Secret,
    /// This computer's name, when the sign-in is the desktop's own: Cloud
    /// then asks the person to approve "Agent Relay Desktop on <host>".
    desktop_host: Option<String>,
}

impl BrowserLogin {
    /// Listens on a free loopback port.
    pub async fn bind() -> Result<BrowserLogin, LoginError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| LoginError::error("Could not start local sign-in. Try again."))?;
        let port = listener
            .local_addr()
            .map_err(|_| LoginError::error("Could not start local sign-in. Try again."))?
            .port();
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|_| LoginError::error("Could not start local sign-in. Try again."))?;
        Ok(BrowserLogin {
            listener,
            port,
            state: crate::relay::store::random_uuid().to_ascii_uppercase(),
            verifier: Secret::new(base64_url(&bytes)),
            desktop_host: None,
        })
    }

    /// Proves to Cloud that whoever exchanges the returned token opened this
    /// attempt's login page.
    pub fn verifier(&self) -> &Secret {
        &self.verifier
    }

    /// The S256 challenge for the verifier.
    pub fn code_challenge(&self) -> String {
        base64_url(&Sha256::digest(self.verifier.expose().as_bytes()))
    }

    /// Makes this the desktop's own sign-in, naming this computer. A name
    /// Cloud would refuse leaves it an ordinary sign-in.
    pub fn with_desktop_host(mut self, host_name: &str) -> BrowserLogin {
        self.desktop_host = valid_desktop_host(host_name);
        self
    }

    /// Where Cloud returns. The state rides in the path: Cloud's
    /// post-Google return can lose every query parameter of `next` after
    /// the first, and a path survives.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback/{}", self.port, self.state)
    }

    /// The page that starts this attempt. By default it goes through Google
    /// so the person picks the account; `reuse_browser_session` opens
    /// Cloud's CLI login directly, which returns at once in a browser
    /// already signed in.
    pub fn authorization_url(&self, site_url: &str, reuse_browser_session: bool) -> Option<String> {
        self.authorization_url_for_workspace(site_url, reuse_browser_session, None)
    }

    pub fn authorization_url_for_workspace(
        &self,
        site_url: &str,
        reuse_browser_session: bool,
        workspace: Option<&str>,
    ) -> Option<String> {
        let site = validated_base_url(site_url)?;
        let redirect = self.redirect_uri();
        let challenge = self.code_challenge();
        let mut login = query(&[
            ("redirect_uri", &redirect),
            ("state", &self.state),
            ("client", "desktop"),
            ("workspace_selection", "desktop"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        if let Some(host_name) = &self.desktop_host {
            login.push_str(&format!("&desktop_host_name={}", query_value(host_name)));
        }
        if let Some(workspace) = workspace {
            login.push_str(&format!("&workspace={}", query_value(workspace)));
        }
        Some(if reuse_browser_session {
            format!("{site}/cloud/api/v1/cli/login?{login}")
        } else {
            let next = format!("/api/v1/cli/login?{login}");
            format!(
                "{site}/cloud/api/auth/google/start?next={}",
                query_value(&next)
            )
        })
    }

    /// Waits for this attempt's return and answers the browser. Anything
    /// else that reaches the port is turned away. Dropping the future
    /// cancels it; the caller bounds how long it waits.
    pub async fn receive(&self, site_url: &str) -> CloudSession {
        loop {
            let Ok((stream, _)) = self.listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            if let Some(session) = self.answer(stream, site_url).await {
                return session;
            }
        }
    }

    async fn answer(&self, mut stream: TcpStream, site_url: &str) -> Option<CloudSession> {
        let mut request = Vec::new();
        let mut buffer = [0u8; 2048];
        let read = tokio::time::timeout(Duration::from_secs(2), async {
            while request.len() < 8192 {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => request.extend_from_slice(&buffer[..count]),
                }
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
        })
        .await;
        let session = read
            .ok()
            .and_then(|_| self.accept(&String::from_utf8_lossy(&request), site_url));
        respond(&mut stream, session.is_some()).await;
        session
    }

    /// The handoff session a callback request carries, when it is this
    /// attempt's and names the site being signed in to.
    fn accept(&self, request: &str, site_url: &str) -> Option<CloudSession> {
        let line = request.split("\r\n").next()?;
        let mut parts = line.split(' ');
        let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
            return None;
        };
        let url = url::Url::parse(&format!("http://127.0.0.1:{}{target}", self.port)).ok()?;
        let in_path = url.path() == format!("/callback/{}", self.state);
        if !in_path && url.path() != "/callback" {
            return None;
        }
        let mut values = HashMap::new();
        for (name, value) in url.query_pairs() {
            values.entry(name.to_string()).or_insert(value.to_string());
        }
        let state_matches = in_path || values.get("state") == Some(&self.state);
        let token = values
            .get("access_token")
            .filter(|token| !token.is_empty())?;
        let api = values.get("api_url")?.trim_matches('/');
        let site = validated_base_url(site_url)?;
        if !state_matches || api != format!("{site}/cloud") {
            return None;
        }
        Some(CloudSession {
            access_token: Secret::new(token.clone()),
            access_token_expires_at: values
                .get("access_token_expires_at")
                .filter(|value| !value.is_empty())
                .cloned(),
            refresh_token: None,
            refresh_token_expires_at: None,
            site_url: site,
        })
    }
}

/// Closes the tab once it has shown the result. Browsers only let a page close
/// a tab whose history it owns, so a tab that stays open says so instead.
const CLOSE_TAB: &str = "<script>history.replaceState(null,'','/done');setTimeout(function(){window.close();setTimeout(function(){document.getElementById('detail').textContent='You can close this tab.'},300)},1500)</script>";

fn page(title: &str, detail: &str, script: &str) -> String {
    include_str!("../../resources/sign-in/page.html")
        .replace("{{title}}", title)
        .replace("{{detail}}", detail)
        .replace("{{script}}", script)
}

async fn respond(stream: &mut TcpStream, success: bool) {
    let (status, body) = if success {
        (
            "200 OK",
            page(
                "This computer is connected",
                "You're signed in to Agent Relay. This tab closes on its own.",
                CLOSE_TAB,
            ),
        )
    } else {
        (
            "400 Bad Request",
            page(
                "Sign-in failed",
                "This sign-in request was not recognized. Start again from the Agent Relay app.",
                "",
            ),
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn device_proof_keeps_the_verifier_local_until_poll() {
        let verifier = Secret::new(base64_url(&[7u8; 32]));
        let start = device_start_body(Some(("test-mini", &verifier)));
        assert_eq!(start["desktop_code_challenge_method"], "S256");
        assert_eq!(start["desktop_host_name"], "test-mini");
        assert_eq!(
            start["desktop_code_challenge"],
            base64_url(&Sha256::digest(verifier.expose().as_bytes()))
        );
        assert!(!start.to_string().contains(verifier.expose()));
        let poll = device_poll_body(
            &Secret::new(String::from("synthetic-device-code")),
            Some(&verifier),
        );
        assert_eq!(poll["desktop_code_verifier"], verifier.expose());
        assert!(poll.get("desktop_host_name").is_none());
    }

    #[test]
    fn a_sign_in_that_is_not_the_desktop_carries_no_desktop_proof() {
        let start = device_start_body(None);
        assert!(start.get("desktop_code_challenge").is_none());
        assert!(start.get("desktop_host_name").is_none());
        let poll = device_poll_body(&Secret::new(String::from("synthetic-device-code")), None);
        assert!(poll.get("desktop_code_verifier").is_none());
    }

    #[tokio::test]
    async fn workspace_bound_login_preserves_the_choice_and_pkce_through_google() {
        let login = super::BrowserLogin::bind().await.unwrap();
        let workspace = "0f8fad5b-d9cb-469f-a165-70867728950e";
        for reuse in [false, true] {
            let url = url::Url::parse(
                &login
                    .authorization_url_for_workspace(
                        "https://agentrelay.com",
                        reuse,
                        Some(workspace),
                    )
                    .unwrap(),
            )
            .unwrap();
            let url = if reuse {
                url
            } else {
                let next = url
                    .query_pairs()
                    .find(|(key, _)| key == "next")
                    .unwrap()
                    .1
                    .into_owned();
                url::Url::parse(&format!("https://agentrelay.com{next}")).unwrap()
            };
            let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
            assert_eq!(pairs.get("workspace").unwrap(), workspace);
            assert_eq!(
                pairs.get("code_challenge").unwrap(),
                &login.code_challenge()
            );
        }
    }

    use super::*;

    async fn response_to_callback(success: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        respond(&mut server, success).await;
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn the_callback_page_is_complete_and_closes_only_after_success() {
        for success in [true, false] {
            let response = response_to_callback(success).await;
            let (head, body) = response.split_once("\r\n\r\n").unwrap();
            assert!(head.contains(&format!("Content-Length: {}", body.len())));
            assert!(!body.contains("{{"));
            assert_eq!(body.contains("window.close()"), success);
            assert!(body.contains(if success {
                "<h1>This computer is connected</h1>"
            } else {
                "<h1>Sign-in failed</h1>"
            }));
        }
    }

    #[test]
    fn the_login_url_matches_the_macos_app_s_encoding() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let login = runtime.block_on(BrowserLogin::bind()).unwrap();
        let state = login.state.clone();
        let port = login.port;
        let challenge = login.code_challenge();
        let google = login
            .authorization_url("https://agentrelay.com", false)
            .unwrap();
        assert_eq!(
            google,
            format!(
                "https://agentrelay.com/cloud/api/auth/google/start?next=/api/v1/cli/login?redirect_uri%3Dhttp://127.0.0.1:{port}/callback/{state}%26state%3D{state}%26client%3Ddesktop%26workspace_selection%3Ddesktop%26code_challenge%3D{challenge}%26code_challenge_method%3DS256"
            )
        );
        let direct = login
            .authorization_url("https://agentrelay.com", true)
            .unwrap();
        assert_eq!(
            direct,
            format!(
                "https://agentrelay.com/cloud/api/v1/cli/login?redirect_uri=http://127.0.0.1:{port}/callback/{state}&state={state}&client=desktop&workspace_selection=desktop&code_challenge={challenge}&code_challenge_method=S256"
            )
        );
        assert!(login
            .authorization_url("http://evil.example", true)
            .is_none());
    }

    #[test]
    fn the_desktop_s_own_browser_sign_in_names_this_computer() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let login = runtime
            .block_on(BrowserLogin::bind())
            .unwrap()
            .with_desktop_host(" test-mini ");
        let challenge = login.code_challenge();
        let direct = login
            .authorization_url_for_workspace("https://agentrelay.com", true, Some("w1"))
            .unwrap();
        assert!(
            direct.ends_with(&format!(
                "&code_challenge={challenge}&code_challenge_method=S256&desktop_host_name=test-mini&workspace=w1"
            )),
            "{direct}"
        );
        let google = login
            .authorization_url("https://agentrelay.com", false)
            .unwrap();
        // Cloud's google/start reads `next` as one query value and returns
        // to it whole: decoded, it must be the full sign-in with every
        // parameter, the computer's name and the challenge included.
        let google = url::Url::parse(&google).unwrap();
        let next: Vec<String> = google
            .query_pairs()
            .filter(|(key, _)| key == "next")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(google.query_pairs().count(), 1, "only next: {google}");
        let next = url::Url::parse(&format!("https://agentrelay.com/cloud{}", next[0])).unwrap();
        let inner: std::collections::HashMap<_, _> = next.query_pairs().into_owned().collect();
        assert_eq!(next.path(), "/cloud/api/v1/cli/login");
        assert_eq!(inner["desktop_host_name"], "test-mini");
        assert_eq!(inner["code_challenge"], challenge);
        assert_eq!(inner["code_challenge_method"], "S256");
        assert_eq!(inner["client"], "desktop");

        // A name Cloud would refuse, or an ordinary sign-in, names nothing.
        for login in [
            runtime
                .block_on(BrowserLogin::bind())
                .unwrap()
                .with_desktop_host("bad\u{7}name"),
            runtime.block_on(BrowserLogin::bind()).unwrap(),
        ] {
            let url = login
                .authorization_url("https://agentrelay.com", true)
                .unwrap();
            assert!(!url.contains("desktop_host_name"), "{url}");
        }
    }

    #[test]
    fn the_challenge_is_s256_of_a_43_character_verifier() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let login = runtime.block_on(BrowserLogin::bind()).unwrap();
        assert_eq!(login.verifier().expose().len(), 43);
        assert_eq!(
            login.code_challenge(),
            base64_url(&Sha256::digest(login.verifier().expose().as_bytes()))
        );
        // RFC 7636 appendix B.
        assert_eq!(
            base64_url(&Sha256::digest(
                b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            )),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn only_this_attempt_s_callback_for_this_site_is_accepted() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let login = runtime.block_on(BrowserLogin::bind()).unwrap();
        let state = login.state.clone();
        let site = "https://agentrelay.com";
        let get = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n");
        let good = login
            .accept(
                &get(&format!(
                    "/callback/{state}?access_token=tok&api_url=https://agentrelay.com/cloud/&access_token_expires_at=2026-10-01T00:00:00Z"
                )),
                site,
            )
            .unwrap();
        assert_eq!(good.access_token.expose(), "tok");
        assert_eq!(good.site_url, site);
        assert_eq!(
            good.access_token_expires_at.as_deref(),
            Some("2026-10-01T00:00:00Z")
        );
        assert!(good.refresh_token.is_none());
        // State in the query, for a return that kept it.
        assert!(login
            .accept(
                &get(&format!(
                    "/callback?state={state}&access_token=tok&api_url=https://agentrelay.com/cloud"
                )),
                site
            )
            .is_some());
        for forged in [
            "/callback?state=OTHER&access_token=tok&api_url=https://agentrelay.com/cloud"
                .to_string(),
            "/callback/OTHER?access_token=tok&api_url=https://agentrelay.com/cloud".to_string(),
            format!("/callback/{state}?access_token=tok&api_url=https://evil.example/cloud"),
            format!("/callback/{state}?access_token=&api_url=https://agentrelay.com/cloud"),
            format!("/callback/{state}?api_url=https://agentrelay.com/cloud"),
            format!("/elsewhere/{state}?access_token=tok&api_url=https://agentrelay.com/cloud"),
        ] {
            assert!(login.accept(&get(&forged), site).is_none(), "{forged}");
        }
        assert!(login
            .accept(
                &format!("POST /callback/{state}?access_token=tok&api_url=https://agentrelay.com/cloud HTTP/1.1\r\n\r\n"),
                site
            )
            .is_none());
    }

    #[test]
    fn origins_carry_no_user_info() {
        assert_eq!(
            origin_of("https://agentrelay.com/device?code=1").as_deref(),
            Some("https://agentrelay.com")
        );
        assert_eq!(origin_of("https://user@agentrelay.com/device"), None);
        assert_eq!(
            origin_of("http://127.0.0.1:4000/x").as_deref(),
            Some("http://127.0.0.1:4000")
        );
        assert_eq!(origin_of("http://agentrelay.com/x"), None);
    }
}
