//! Device sign-in, as Relay Connect hosts use it: OAuth device authorization.
//!
//! The device code never leaves `DeviceLogin`; callers get only the link, the
//! human code and timing. A link naming another origin than the site being
//! signed in to is refused before anything is shown or kept.

use crate::relay::cloud_http;
use crate::relay::cloud_session::{api_base, iso};
use crate::relay::contract::account::SignInLink;
use crate::relay::store::CloudSession;
use crate::relay::workspace::{validated_base_url, Secret};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

/// Why a sign-in did not finish. `state` is `denied`, `expired`, `cancelled`,
/// `no_workspace` or `error`; `message` is safe to show.
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

    /// The account belongs to no workspace: the person creates one in the
    /// dashboard, then signs in again.
    pub fn no_workspace() -> LoginError {
        LoginError {
            state: "no_workspace",
            message: "Your Agent Relay account has no workspace yet. Create one in your dashboard, then try again.".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

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
