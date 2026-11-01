//! Keeps a signed-in desktop's Cloud workspace binding in place without an
//! interactive sign-in, and says why its agents cannot reach Cloud when they
//! cannot.
//!
//! A desktop counts as signed in once its session uploader is attached, but
//! the binding (`store.cloud`, which the desktop identity sync needs) was only
//! written by an interactive sign-in. A headless Linux core attached by the
//! setup flow never ran one, so its agents never reached Cloud and the hosted
//! MCP's `join_relay` could not link them. Each supervision pass now adopts
//! the binding with a Cloud session this computer already has: the
//! environment's, this app's kept one (renewed like any other Cloud call), or
//! the official CLI's. The CLI's tokens are only read, never renewed: an
//! expired one is reported with "sign in" guidance instead.
//!
//! The identity sync hands agent tokens to whoever owns the session it uses.
//! A session this app did not keep (the environment's or the CLI's) may be
//! another person's, so it is used only once Cloud confirms it belongs to the
//! account this computer is signed in as.

use super::*;
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::Instant;

/// Whether this desktop's agents can reach Cloud's identity sync, and if not,
/// why. `setup/status` reports it as `cloud_identity_sync`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdentitySync {
    Ready,
    /// Signed in with a Cloud session, but the workspace binding could not
    /// be resolved yet; it is retried with a backoff.
    NoBinding,
    /// Signed in, with no Cloud session this computer may use.
    NoSession,
    /// Signed in only through the official CLI, whose sign-in has expired.
    CliSessionExpired,
    /// The environment's or the CLI's session is another person's (or could
    /// not be confirmed), so this computer's agents are not sent with it.
    SessionMismatch,
}

impl IdentitySync {
    pub(crate) fn code(self) -> &'static str {
        match self {
            IdentitySync::Ready => "ready",
            IdentitySync::NoBinding => "no_binding",
            IdentitySync::NoSession => "no_session",
            IdentitySync::CliSessionExpired => "cli_session_expired",
            IdentitySync::SessionMismatch => "session_mismatch",
        }
    }

    fn guidance(self) -> &'static str {
        match self {
            IdentitySync::Ready => "This computer's agents are linked to Agent Relay Cloud again.",
            IdentitySync::NoBinding => {
                "Signed in, but this computer could not link its workspace's relay yet; retrying. Hosted MCP sessions cannot join this computer's agents until it does."
            }
            IdentitySync::NoSession => {
                "Signed in, but this computer has no Agent Relay Cloud session, so its agents are not linked to Cloud. Sign in again: POST /setup/sign-in on the Agent Relay socket, or Sign in in the app."
            }
            IdentitySync::CliSessionExpired => {
                "The Agent Relay CLI's sign-in that this computer was using has expired, so its agents are not linked to Cloud. Sign in again: POST /setup/sign-in on the Agent Relay socket, or Sign in in the app."
            }
            IdentitySync::SessionMismatch => {
                "The Agent Relay Cloud session available here belongs to someone other than the person this computer is signed in as, so its agents are not linked to Cloud. Sign in as that person: POST /setup/sign-in on the Agent Relay socket, or Sign in in the app."
            }
        }
    }
}

/// A binding attempt's backoff applies only to the sign-in and session it was
/// made with: a sign-out bumps the epoch, a new attachment the revision, and a
/// sign-in or kept session brings another bearer.
type Generation = (u64, u64, u64);

/// Per core: the last state reported, logged only when it changes.
static STATES: Mutex<BTreeMap<usize, IdentitySync>> = Mutex::new(BTreeMap::new());
/// Per core: the last identity sync failed (cleared when one succeeds).
static SYNC_FAILED: Mutex<BTreeMap<usize, bool>> = Mutex::new(BTreeMap::new());
/// Per core: when the next binding attempt may run, after how many failures,
/// for which sign-in.
static RETRIES: Mutex<BTreeMap<usize, (Instant, u32, Generation)>> = Mutex::new(BTreeMap::new());
/// Per core: the sign-in (epoch, uploader revision) the last pass ran under,
/// so a new one starts with no recorded sync failure.
static SIGN_INS: Mutex<BTreeMap<usize, (u64, u64)>> = Mutex::new(BTreeMap::new());
/// Per core: whose session a token is, by a hash of the token, so Cloud is
/// asked once per token.
static OWNERS: Mutex<BTreeMap<(usize, u64), String>> = Mutex::new(BTreeMap::new());

/// A core's slot in these maps: its address, mixed with its home so a core
/// built later at a freed address never inherits an earlier one's answers.
fn key(core: &Core) -> usize {
    let mut hasher = DefaultHasher::new();
    (core as *const Core as usize).hash(&mut hasher);
    core.config().home.hash(&mut hasher);
    hasher.finish() as usize
}

fn lock<T>(map: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    map.lock().unwrap_or_else(|p| p.into_inner())
}

fn token_hash(token: &Secret) -> u64 {
    let mut hasher = DefaultHasher::new();
    token.expose().hash(&mut hasher);
    hasher.finish()
}

/// `cloud_identity_sync` for `setup/status`: `None` until the first pass, and
/// while signed out. `sync_failed` when the binding is in place but Cloud
/// refused the last identity sync.
pub(crate) fn report(core: &Core) -> Option<&'static str> {
    report_for(key(core))
}

fn report_for(slot: usize) -> Option<&'static str> {
    let state = *lock(&STATES).get(&slot)?;
    let failed = lock(&SYNC_FAILED).get(&slot).copied().unwrap_or(false);
    Some(match state {
        IdentitySync::Ready if failed => "sync_failed",
        state => state.code(),
    })
}

/// Records how the last identity sync went, for `report`. `None` when the
/// sync did not run (its session awaits confirmation): no failure stands.
pub(crate) fn note_identity_sync(core: &Core, succeeded: Option<bool>) {
    lock(&SYNC_FAILED).insert(key(core), succeeded == Some(false));
}

/// Forgets everything recorded for a core's sign-in: on sign-out, and before
/// a new sign-in's first pass.
fn forget(slot: usize, keep_state: bool) {
    if !keep_state {
        lock(&STATES).remove(&slot);
    }
    lock(&SYNC_FAILED).remove(&slot);
    lock(&RETRIES).remove(&slot);
}

/// Who a borrowed session belongs to, as far as Cloud said.
enum Owner {
    Confirmed,
    Someone,
    /// Cloud could not be asked (unreachable, or an error answer).
    Unknown,
}

/// Whether the official CLI holds a sign-in for `site` at all, fresh or not.
fn cli_signed_in(relay_home: &Path, site: &str) -> bool {
    if cfg!(not(feature = "relay-cli")) {
        return false;
    }
    let Ok(raw) = std::fs::read(relay_home.join("cloud-auth.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
        return false;
    };
    let api = value["apiUrl"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_end_matches('/');
    api == format!("{site}/cloud") && value["accessToken"].as_str().is_some_and(|t| !t.is_empty())
}

/// Doubles from one supervision period to 32 after each failed attempt.
fn backoff(period: Duration, failures: u32) -> Duration {
    period.saturating_mul(1 << failures.min(5))
}

/// The session Cloud calls for `site` would use, read without renewing it.
enum Source {
    /// The environment's or the official CLI's: possibly another person's.
    Borrowed(Secret),
    /// This app's own kept session.
    Kept,
    CliExpired,
    None,
}

impl Account {
    /// Each supervision pass: the binding first, then the identity sync.
    pub(super) async fn sync_cloud_identities(&self) {
        let Some(core) = self.core() else { return };
        self.ensure_cloud_binding(&core).await;
        core.request_desktop_identity_sync();
    }

    fn generation(&self, bearer: &Secret) -> Generation {
        (
            self.epoch.load(Ordering::SeqCst),
            self.uploader.revision(),
            token_hash(bearer),
        )
    }

    fn source(&self, site: &str) -> Source {
        let now = crate::relay::state::now_ms();
        if let Some(token) = &self.env_token {
            return Source::Borrowed(token.clone());
        }
        if self.load_session().is_some_and(|s| s.site_url == site) {
            return Source::Kept;
        }
        match cloud_session::cli_session(&self.relay_home, site, now) {
            Some(cli) => Source::Borrowed(cli.access_token),
            None if cli_signed_in(&self.relay_home, site) => Source::CliExpired,
            None => Source::None,
        }
    }

    /// Whether the identity sync may send agent tokens with the session Cloud
    /// calls would use now: this app's own, or a borrowed one Cloud confirmed
    /// is the signed-in person's. Without a session the sync cannot run.
    pub(super) fn identity_sync_allowed(&self) -> bool {
        let Some(account) = CloudAccess::account(self) else {
            return false;
        };
        match self.source(&account.site_url) {
            Source::Borrowed(token) => {
                let core = self.core().map_or(0, |core| key(&core));
                let owner = lock(&OWNERS).get(&(core, token_hash(&token))).cloned();
                owner.is_some() && owner == self.install_person(&account)
            }
            Source::Kept | Source::CliExpired | Source::None => true,
        }
    }

    async fn ensure_cloud_binding(&self, core: &Arc<Core>) {
        let Some(account) = CloudAccess::account(self) else {
            forget(key(core), false);
            lock(&SIGN_INS).remove(&key(core));
            return;
        };
        let sign_in = (self.epoch.load(Ordering::SeqCst), self.uploader.revision());
        if lock(&SIGN_INS).insert(key(core), sign_in) != Some(sign_in) {
            forget(key(core), true);
        }
        let bound = core.store.read(|s| {
            s.cloud
                .as_ref()
                .and_then(|cloud| cloud.account_workspace_id.as_deref())
                == Some(account.workspace_id.as_str())
        });
        let site = &account.site_url;
        let state = match self.source(site) {
            Source::CliExpired => IdentitySync::CliSessionExpired,
            Source::None => IdentitySync::NoSession,
            Source::Borrowed(token) => match self.owned_by(core, &account, &token).await {
                Owner::Someone => IdentitySync::SessionMismatch,
                // Not confirmed either way: retried with the backoff, never bound.
                Owner::Unknown => IdentitySync::NoBinding,
                Owner::Confirmed if bound => IdentitySync::Ready,
                Owner::Confirmed => self.adopt_binding(core, &account, &token).await,
            },
            Source::Kept if bound => {
                let now = crate::relay::state::now_ms();
                let kept = self.load_session().filter(|s| s.site_url == *site);
                match kept
                    .is_some_and(|s| access_is_fresh(&s, FRESH_MARGIN, now) || can_refresh(&s, now))
                {
                    true => IdentitySync::Ready,
                    false => IdentitySync::NoSession,
                }
            }
            Source::Kept => self.bind_with_kept_session(core, &account).await,
        };
        self.report_identity_sync(core, state);
    }

    /// The person this computer is signed in as: the attached install's
    /// account, else the person an interactive sign-in confirmed. Never the
    /// person behind a borrowed session.
    fn install_person(&self, account: &CloudAccount) -> Option<String> {
        CloudAccess::agent_owner(self)
            .map(|owner| owner.user_id)
            .or_else(|| account.user_id.clone())
    }

    /// Binds with this app's own kept session, renewed like any Cloud call
    /// would renew it (serialized with the uploads' renewal). A renewal that
    /// fails, here or by the uploads, is `no_session`; this one backs off.
    async fn bind_with_kept_session(
        &self,
        core: &Arc<Core>,
        account: &CloudAccount,
    ) -> IdentitySync {
        let site = &account.site_url;
        let Some(kept) = self.load_session().filter(|s| s.site_url == *site) else {
            return IdentitySync::NoSession;
        };
        let now = crate::relay::state::now_ms();
        if access_is_fresh(&kept, FRESH_MARGIN, now) {
            return self.adopt_binding(core, account, &kept.access_token).await;
        }
        // A refresh token that is gone or expired cannot be renewed by anyone.
        if !can_refresh(&kept, now) {
            return IdentitySync::NoSession;
        }
        // Uploads blocked on sign-in already tried to renew it and Cloud
        // refused: renewal has failed, not merely in flight, so the person
        // must sign in (the uploads keep retrying on their own backoff).
        let uploads_renewal_failed = self
            .upload_auth_retry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .failures
            > 0;
        if uploads_renewal_failed {
            return IdentitySync::NoSession;
        }
        let generation = self.generation(&kept.access_token);
        let waiting = lock(&RETRIES)
            .get(&key(core))
            .is_some_and(|(next, _, made)| *made == generation && *next > Instant::now());
        if waiting {
            // Keep what the last attempt found (a failed renewal stays
            // no_session) rather than flipping between states each pass.
            return lock(&STATES)
                .get(&key(core))
                .copied()
                .filter(|state| *state != IdentitySync::Ready)
                .unwrap_or(IdentitySync::NoBinding);
        }
        match self.kept_session(site, FRESH_MARGIN).await {
            Kept::Usable(session) => {
                self.adopt_binding(core, account, &session.access_token)
                    .await
            }
            Kept::Unrenewable | Kept::Absent => {
                self.back_off(core, generation);
                IdentitySync::NoSession
            }
        }
    }

    fn back_off(&self, core: &Core, generation: Generation) {
        let mut retries = lock(&RETRIES);
        let failures = retries
            .get(&key(core))
            .filter(|(_, _, made)| *made == generation)
            .map_or(0, |(_, failures, _)| *failures);
        let wait = backoff(self.supervise_every, failures);
        retries.insert(key(core), (Instant::now() + wait, failures + 1, generation));
    }

    /// Whose session `token` is, as Cloud says, against the person this
    /// computer is signed in as. A definite answer is kept per token; when
    /// Cloud cannot be asked, the next ask waits for the binding backoff.
    async fn owned_by(&self, core: &Core, account: &CloudAccount, token: &Secret) -> Owner {
        let Some(user) = self.install_person(account) else {
            return Owner::Someone;
        };
        let hash = (key(core), token_hash(token));
        if let Some(owner) = lock(&OWNERS).get(&hash) {
            return if *owner == user {
                Owner::Confirmed
            } else {
                Owner::Someone
            };
        }
        let generation = self.generation(token);
        let waiting = lock(&RETRIES)
            .get(&key(core))
            .is_some_and(|(next, _, made)| *made == generation && *next > Instant::now());
        if waiting {
            return Owner::Unknown;
        }
        match cloud_session::whoami(&account.site_url, token).await {
            Ok(identity) => {
                let owner = identity.user_id == user;
                lock(&OWNERS).insert(hash, identity.user_id);
                if owner {
                    Owner::Confirmed
                } else {
                    Owner::Someone
                }
            }
            Err(_) => {
                self.back_off(core, generation);
                Owner::Unknown
            }
        }
    }

    fn signing_in(&self) -> bool {
        self.attempt
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    /// Resolves the account workspace's binding with `bearer` and saves it,
    /// as an interactive sign-in would. A sign-in in flight owns the binding;
    /// an answer that arrives after the sign-in changed is dropped; failures
    /// back off, for this sign-in only.
    async fn adopt_binding(
        &self,
        core: &Arc<Core>,
        account: &CloudAccount,
        bearer: &Secret,
    ) -> IdentitySync {
        let slot = key(core);
        let now = Instant::now();
        let generation = self.generation(bearer);
        let waiting = lock(&RETRIES)
            .get(&slot)
            .is_some_and(|(next, _, made)| *made == generation && *next > now);
        if waiting || self.signing_in() {
            return IdentitySync::NoBinding;
        }
        let resolved =
            cloud_session::resolve_workspace(&account.site_url, bearer, &account.workspace_id)
                .await;
        let unchanged = self.generation(bearer) == generation
            && !self.signing_in()
            && CloudAccess::account(self).as_ref() == Some(account);
        let saved = match resolved {
            Ok(resolved) if unchanged => core
                .store
                .update(|s| {
                    let switched = s.cloud.as_ref().is_some_and(|cloud| {
                        cloud.account_workspace_id.as_deref()
                            != resolved.account_workspace_id.as_deref()
                    });
                    if switched {
                        s.queue_desktop_identity_clear(false);
                    }
                    s.cloud = Some(resolved);
                })
                .map_err(|error| error.to_string()),
            // A sign-in, sign-out or switch while Cloud answered keeps
            // nothing from the old one.
            // and a failure for it does not count against the new one.
            Ok(_) => return IdentitySync::NoBinding,
            Err(_) if !unchanged => return IdentitySync::NoBinding,
            Err(error) => Err(error.to_string()),
        };
        match saved {
            Ok(()) => {
                lock(&RETRIES).remove(&slot);
                core.refresh_workspace().await;
                IdentitySync::Ready
            }
            Err(error) => {
                self.back_off(core, generation);
                let message = format!("Could not link this computer's workspace relay: {error}");
                crate::relay::diagnostics::write(format_args!("relay: {message}"));
                core.hub.activity(Level::Warning, message);
                IdentitySync::NoBinding
            }
        }
    }

    /// Logs a change of state: loudly while agents cannot reach Cloud, once
    /// when they can again.
    fn report_identity_sync(&self, core: &Core, state: IdentitySync) {
        let before = lock(&STATES).insert(key(core), state);
        if before == Some(state) || (before.is_none() && state == IdentitySync::Ready) {
            return;
        }
        let level = if state == IdentitySync::Ready {
            Level::Info
        } else {
            Level::Warning
        };
        crate::relay::diagnostics::write(format_args!(
            "relay: cloud_identity_sync={}: {}",
            state.code(),
            state.guidance()
        ));
        core.hub.activity(level, state.guidance());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "relay-cli"))]
    #[test]
    fn without_relay_cli_a_cli_sign_in_is_not_recognised() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("cloud-auth.json"),
            json!({"apiUrl": "https://agentrelay.com/cloud/", "accessToken": "token"}).to_string(),
        )
        .unwrap();
        assert!(!cli_signed_in(home.path(), "https://agentrelay.com"));
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn a_cli_sign_in_is_recognised_for_its_site_even_when_expired() {
        let home = tempfile::tempdir().unwrap();
        let site = "https://agentrelay.com";
        assert!(!cli_signed_in(home.path(), site));
        std::fs::write(
            home.path().join("cloud-auth.json"),
            json!({"apiUrl": "https://agentrelay.com/cloud/", "accessToken": "token",
                   "accessTokenExpiresAt": "2000-01-01T00:00:00Z"})
            .to_string(),
        )
        .unwrap();
        assert!(cli_signed_in(home.path(), site));
        assert!(!cli_signed_in(home.path(), "https://other.example"));
    }

    #[test]
    fn a_failed_identity_sync_is_reported_until_one_succeeds() {
        let slot = usize::MAX - 7;
        lock(&STATES).insert(slot, IdentitySync::Ready);
        assert_eq!(report_for(slot), Some("ready"));
        lock(&SYNC_FAILED).insert(slot, true);
        assert_eq!(report_for(slot), Some("sync_failed"));
        // Only a binding in place is downgraded: other states say why first.
        lock(&STATES).insert(slot, IdentitySync::NoSession);
        assert_eq!(report_for(slot), Some("no_session"));
        lock(&STATES).insert(slot, IdentitySync::Ready);
        lock(&SYNC_FAILED).insert(slot, false);
        assert_eq!(report_for(slot), Some("ready"));
        lock(&STATES).remove(&slot);
        lock(&SYNC_FAILED).remove(&slot);
    }

    #[test]
    fn a_new_sign_in_starts_with_no_recorded_sync_failure() {
        let slot = usize::MAX - 11;
        lock(&STATES).insert(slot, IdentitySync::Ready);
        lock(&SYNC_FAILED).insert(slot, true);
        assert_eq!(report_for(slot), Some("sync_failed"));
        // A new sign-in keeps the state until its pass, but not the failure.
        forget(slot, true);
        assert_eq!(report_for(slot), Some("ready"));
        lock(&SYNC_FAILED).insert(slot, true);
        // Signing out forgets both.
        forget(slot, false);
        assert_eq!(report_for(slot), None);
        assert!(!lock(&SYNC_FAILED).contains_key(&slot));
    }

    #[test]
    fn binding_attempts_back_off_to_thirty_two_periods() {
        let period = Duration::from_secs(10);
        assert_eq!(backoff(period, 0), period);
        assert_eq!(backoff(period, 1), period * 2);
        assert_eq!(backoff(period, 5), period * 32);
        assert_eq!(backoff(period, 9), period * 32);
    }

    #[test]
    fn every_state_has_a_stable_code() {
        let codes: Vec<_> = [
            IdentitySync::Ready,
            IdentitySync::NoBinding,
            IdentitySync::NoSession,
            IdentitySync::CliSessionExpired,
            IdentitySync::SessionMismatch,
        ]
        .iter()
        .map(|state| state.code())
        .collect();
        assert_eq!(
            codes,
            [
                "ready",
                "no_binding",
                "no_session",
                "cli_session_expired",
                "session_mismatch"
            ]
        );
    }
}
