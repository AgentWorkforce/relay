//! The claude.ai sign-in the `claude-web` connector lists and reads Claude
//! Code cloud sessions with: Claude Code's own login, never one of ours.
//!
//! The connector reads only a credentials file, `~/.claude/.credentials.json`
//! (or `RELAYHISTORY_CLAUDE_CREDENTIALS`). On Linux Claude Code keeps its
//! login there. On macOS it keeps the live login in the login Keychain
//! (generic password, service `Claude Code-credentials`, account the login
//! user name) and the file, when there is one, may be an old copy. So:
//!
//! - the file is used when it holds a token whose `expiresAt` is in the
//!   future;
//! - otherwise, on macOS, the Keychain item is read by this process
//!   through the Security framework ([`claude_keychain`]) and handed to the
//!   connector as a private home for the length of one pass: a 0600 file in
//!   a 0700 folder under the probe's data folder, removed when the pass ends
//!   (also on error);
//! - an expired token is "not ready": no request is made with it.
//!
//! A capture pass reads the Keychain quietly: it never raises macOS's
//! "allow access" prompt, and without the person's Always Allow it has no
//! login ([`KEYCHAIN_DENIED`]). The prompt comes only from a person's own
//! action: turning Claude Code cloud sessions on in Settings, or opening a
//! cloud session ([`Ask::Person`]), which waits for their answer.
//!
//! The Keychain is never read on the capture thread: a busy `securityd`
//! (just after wake or login) can hold even a quiet read. So [`Keychain`]
//! reads on a thread of its own, at most one at a time per process: a pass
//! waits [`PASS_WAIT`] for the answer, then goes on without Claude cloud
//! sessions ("not ready", [`KEYCHAIN_WAITING`]) while every other source
//! carries on. Later passes reuse the same pending read rather than start
//! another, and the passes after it is answered use the login, which every
//! caller waiting on that read gets and which is dropped after
//! [`ANSWER_TTL`]. Once one pass has waited for a read, later ones do not
//! wait on it again. A refusal is never reused: the next caller reads
//! again, so access granted in Settings reaches the next listing.
//!
//! [`claude_keychain`]: agent_relay_probe::relay::claude_keychain
//!
//! Claude Code's credential is never refreshed, rewritten or otherwise
//! changed, and neither the token nor the file's contents are logged.
use agent_relay_probe::platform::fs as private_fs;
#[cfg(target_os = "macos")]
use agent_relay_probe::relay::claude_keychain;
use anyhow::{Context, Result};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// The connector's own override of the credentials file.
pub const CREDENTIALS_ENV: &str = "RELAYHISTORY_CLAUDE_CREDENTIALS";

/// The plain reasons a Claude login cannot be used, as the remote
/// diagnostic records them.
pub const EXPIRED: &str = "Claude Code's sign-in has expired; open Claude Code to refresh it";
pub const UNREADABLE: &str = "Claude Code's sign-in could not be read";
pub const NOT_SIGNED_IN: &str = "Claude Code is not signed in";
pub const KEYCHAIN_DENIED: &str =
    "Agent Relay may not read Claude Code's sign-in from the Keychain. Turn Claude Code cloud sessions on again in Settings and choose Always Allow";
pub const PREPARE_FAILED: &str = "Agent Relay could not prepare Claude Code's sign-in";
pub const KEYCHAIN_WAITING: &str = "Waiting for Keychain access to Claude Code's sign-in";

/// How long a capture pass waits for the Keychain. A quiet read answers in
/// milliseconds; three seconds covers a busy `securityd` (just after wake
/// or login) while adding little to a pass and delaying a stop request by
/// at most that much.
pub const PASS_WAIT: Duration = Duration::from_secs(3);
/// How long a person opening a cloud session waits: they asked for it and
/// are likely at the screen to answer the prompt.
pub const PERSON_WAIT: Duration = Duration::from_secs(60);
/// How long a read's answer is kept for the passes that follow, then
/// dropped and zeroed whether or not anyone used it. It outlasts the
/// remote listing's five-minute interval, so an answer that arrived after
/// its pass gave up still reaches the next listing, and never lingers
/// longer than that in the long-lived helper.
pub const ANSWER_TTL: Duration = Duration::from_secs(6 * 60);

/// Where Claude Code keeps a login other than its credentials file. The
/// macOS login Keychain in the app; a fake in tests, which never touch the
/// real Keychain.
pub trait KeychainSource: Send + Sync {
    /// Whether the item exists, by its attributes only: never reads the
    /// secret, so it never prompts.
    fn present(&self) -> bool;
    /// The item's secret: Claude Code's credentials JSON. Only an
    /// `interactive` read may show macOS's prompt.
    fn read(&self, interactive: bool) -> Option<Vec<u8>>;
}

/// No Keychain: Linux, where Claude Code keeps its login in the file.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
pub struct NoKeychain;

impl KeychainSource for NoKeychain {
    fn present(&self) -> bool {
        false
    }
    fn read(&self, _interactive: bool) -> Option<Vec<u8>> {
        None
    }
}

/// The login Keychain's `Claude Code-credentials` item.
#[cfg(target_os = "macos")]
pub struct LoginKeychain;

#[cfg(target_os = "macos")]
impl KeychainSource for LoginKeychain {
    fn present(&self) -> bool {
        claude_keychain::present()
    }

    fn read(&self, interactive: bool) -> Option<Vec<u8>> {
        claude_keychain::read(interactive)
    }
}

/// Who is asking for the Keychain's secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    /// A capture pass: reads quietly, waiting until [`PASS_WAIT`] after
    /// the read started (not at all once a pending read is older than that).
    Pass,
    /// A person opening a cloud session: may show macOS's prompt, and waits
    /// [`PERSON_WAIT`] for their answer.
    Person,
}

/// A Keychain source read off the caller's thread, one read at a time.
/// Clones share the source and its single pending read.
#[derive(Clone)]
pub struct Keychain {
    source: Arc<dyn KeychainSource>,
    slot: Arc<Slot>,
    /// How long an answer is kept for callers: [`ANSWER_TTL`].
    ttl: Duration,
}

#[derive(Default)]
struct Slot {
    state: Mutex<SlotState>,
    answered: Condvar,
}

#[derive(Default)]
struct SlotState {
    /// Reads started so far; names each read and its answer.
    generation: u64,
    /// When the read outstanding on its thread started, if one is: nobody
    /// starts another.
    reading: Option<Instant>,
    /// The last read's answer, shared by every caller until it expires.
    answer: Option<Answer>,
}

/// What a read answered: the secret, or `None` when it was refused or
/// failed. Zeroed when dropped.
struct Answer {
    generation: u64,
    secret: Option<Vec<u8>>,
    /// The read could show macOS's prompt: its refusal is the person's.
    interactive: bool,
    at: Instant,
}

impl Answer {
    fn result(&self) -> Result<Vec<u8>, &'static str> {
        self.secret.clone().ok_or(KEYCHAIN_DENIED)
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        if let Some(secret) = &mut self.secret {
            secret.fill(0);
        }
    }
}

impl SlotState {
    fn expire(&mut self, ttl: Duration) {
        if self.answer.as_ref().is_some_and(|a| a.at.elapsed() >= ttl) {
            self.answer = None;
        }
    }
}

impl Keychain {
    pub fn new(source: Arc<dyn KeychainSource>) -> Self {
        Self {
            source,
            slot: Arc::default(),
            ttl: ANSWER_TTL,
        }
    }

    pub fn source(&self) -> &dyn KeychainSource {
        &*self.source
    }

    /// Waits until a finished read's answer is in the slot. A test that
    /// answers the prompt and expects the very next pass to use it would
    /// otherwise race the read's own thread storing it.
    #[cfg(test)]
    pub(crate) fn wait_answered(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while self.slot.lock().answer.is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the Keychain answer never arrived"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Drop a kept answer: the Keychain is no longer the login in use.
    pub fn forget(&self) {
        self.slot.lock().answer = None;
    }

    /// The item's secret, waiting no longer than `ask` allows. `Err` is the
    /// plain reason there is none for now: [`KEYCHAIN_WAITING`] while the
    /// read is still unanswered (it stays pending for the next caller),
    /// [`KEYCHAIN_DENIED`] when it was refused.
    pub fn read(&self, ask: Ask) -> Result<Vec<u8>, &'static str> {
        match ask {
            Ask::Pass => self.read_within(PASS_WAIT, false),
            Ask::Person => self.read_within(PERSON_WAIT, true),
        }
    }

    fn read_within(&self, wait: Duration, person: bool) -> Result<Vec<u8>, &'static str> {
        let mut state = self.slot.lock();
        state.expire(self.ttl);
        // A refusal is read again: access may have been granted since.
        if state.answer.as_ref().is_some_and(|a| a.secret.is_none()) {
            state.answer = None;
        }
        let mut deadline = None;
        loop {
            match &state.answer {
                // A person is never answered by a quiet read's refusal (one
                // already in flight when they asked): they are asked.
                Some(answer) if person && answer.secret.is_none() && !answer.interactive => {
                    state.answer = None
                }
                Some(answer) => return answer.result(),
                None => {}
            }
            if state.reading.is_none() {
                state.generation += 1;
                let generation = state.generation;
                state.reading = Some(Instant::now());
                if self.spawn(generation, person).is_err() {
                    state.reading = None;
                    return Err(PREPARE_FAILED);
                }
            }
            // A pass waits out the read's own bound, so once one pass
            // waited, later ones go straight on; a person waits their own.
            let deadline = *deadline.get_or_insert_with(|| match (&state.reading, person) {
                (Some(started), false) => *started + wait,
                _ => Instant::now() + wait,
            });
            let now = Instant::now();
            if now >= deadline {
                return Err(KEYCHAIN_WAITING);
            }
            state = self
                .slot
                .answered
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Read on a thread of its own; the answer is shared with every caller
    /// for `ttl`, then dropped (and zeroed) even if nobody asked again.
    fn spawn(&self, generation: u64, interactive: bool) -> std::io::Result<()> {
        let source = Arc::clone(&self.source);
        let slot = Arc::clone(&self.slot);
        let ttl = self.ttl;
        std::thread::Builder::new()
            .name("claude-keychain".into())
            .spawn(move || {
                let secret = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    source.read(interactive)
                }))
                .ok()
                .flatten();
                {
                    let mut state = slot.lock();
                    state.reading = None;
                    state.answer = Some(Answer {
                        generation,
                        secret,
                        interactive,
                        at: Instant::now(),
                    });
                    slot.answered.notify_all();
                }
                std::thread::sleep(ttl);
                let mut state = slot.lock();
                if state
                    .answer
                    .as_ref()
                    .is_some_and(|a| a.generation == generation)
                {
                    state.answer = None;
                }
            })
            .map(drop)
    }
}

impl Slot {
    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// This platform's Keychain, one per process so every pass shares its one
/// pending read. Tests never reach the real Keychain: they pass a fake
/// through the `_with` entry points instead.
pub fn system_keychain() -> Keychain {
    static SYSTEM: OnceLock<Keychain> = OnceLock::new();
    SYSTEM
        .get_or_init(|| {
            #[cfg(all(target_os = "macos", not(test)))]
            {
                Keychain::new(Arc::new(LoginKeychain))
            }
            #[cfg(any(not(target_os = "macos"), test))]
            {
                Keychain::new(Arc::new(NoKeychain))
            }
        })
        .clone()
}

/// The credentials file the connector reads under `home`, as relayhistory's
/// `claude-web` resolves it: `RELAYHISTORY_CLAUDE_CREDENTIALS`, else
/// `<home>/.claude/.credentials.json`.
pub fn credentials_path(home: &Path) -> PathBuf {
    override_path().unwrap_or_else(|| home.join(".claude/.credentials.json"))
}

fn override_path() -> Option<PathBuf> {
    std::env::var_os(CREDENTIALS_ENV)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Which Claude login a pass would use, chosen without reading a secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Login {
    /// The credentials file holds an unexpired token.
    File,
    /// The file is absent or out of date, and the Keychain item exists.
    Keychain,
    /// The only login found has expired.
    Expired,
    /// The only login found cannot be read as a Claude Code credential.
    Unreadable,
    /// Claude Code is not signed in here.
    Missing,
}

/// Whether credentials JSON holds a usable token at `now_ms`: `None` when it
/// is not a Claude Code credential at all. Reads only the token's presence
/// and `expiresAt`; a token without `expiresAt` is taken as current, as the
/// connector takes it.
fn fresh(bytes: &[u8], now_ms: i64) -> Option<bool> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())?;
    Some(
        oauth
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_none_or(|expires| expires > now_ms),
    )
}

/// The file-versus-Keychain choice. The file wins while its token is
/// current; an override (`RELAYHISTORY_CLAUDE_CREDENTIALS`) is the file and
/// never falls back to the Keychain.
pub fn choose(home: &Path, keychain: &dyn KeychainSource, now_ms: i64) -> Login {
    let path = credentials_path(home);
    let file = std::fs::read(&path).ok().map(|bytes| fresh(&bytes, now_ms));
    let keychain_allowed = override_path().is_none();
    match file {
        Some(Some(true)) => Login::File,
        _ if keychain_allowed && keychain.present() => Login::Keychain,
        Some(Some(false)) => Login::Expired,
        Some(None) => Login::Unreadable,
        None => Login::Missing,
    }
}

/// The home a connector call reads the Claude login under, for one pass.
/// A private home is removed when this is dropped.
pub struct CredentialHome {
    home: PathBuf,
    private: Option<PathBuf>,
}

impl CredentialHome {
    pub fn home(&self) -> &Path {
        &self.home
    }
}

impl Drop for CredentialHome {
    fn drop(&mut self) {
        if let Some(dir) = &self.private {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// The login for one pass: the person's own home when the file is current,
/// else the Keychain item written to a private home under `data_dir`.
/// `Err` carries the plain reason the login cannot be used; no request is
/// made in that case. The Keychain is waited on only as long as `ask`
/// allows.
pub fn prepare(
    home: &Path,
    data_dir: &Path,
    keychain: &Keychain,
    now_ms: i64,
    ask: Ask,
) -> Result<CredentialHome, &'static str> {
    let login = choose(home, keychain.source(), now_ms);
    if login != Login::Keychain {
        keychain.forget();
    }
    match login {
        Login::File => Ok(CredentialHome {
            home: home.to_path_buf(),
            private: None,
        }),
        Login::Expired => Err(EXPIRED),
        Login::Unreadable => Err(UNREADABLE),
        Login::Missing => Err(NOT_SIGNED_IN),
        Login::Keychain => {
            let mut secret = keychain.read(ask)?;
            let verdict = fresh(&secret, now_ms);
            let prepared = match verdict {
                Some(true) => private_home(data_dir, &secret).map_err(|_| PREPARE_FAILED),
                Some(false) => Err(EXPIRED),
                None => Err(UNREADABLE),
            };
            secret.fill(0);
            prepared
        }
    }
}

/// Write `secret` as `<data_dir>/claude-cloud/<pid>-<n>/.claude/.credentials.json`,
/// owner-only. Each call gets its own folder, so a targeted hydration and
/// the collector's pass never remove each other's login.
fn private_home(data_dir: &Path, secret: &[u8]) -> Result<CredentialHome> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let root = data_dir.join("claude-cloud");
    private_fs::create_private_dir_all(&root)?;
    private_fs::set_mode(&root, 0o700)?;
    remove_abandoned(&root);
    let dir = root.join(format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    private_fs::private_dir(&mut std::fs::DirBuilder::new()).create(&dir)?;
    // From here the guard owns the folder: an error below removes it.
    let prepared = CredentialHome {
        home: dir.clone(),
        private: Some(dir.clone()),
    };
    let claude = dir.join(".claude");
    private_fs::private_dir(&mut std::fs::DirBuilder::new()).create(&claude)?;
    let partial = claude.join(".credentials.json.partial");
    let mut file = private_fs::private(std::fs::OpenOptions::new().write(true).create_new(true))
        .open(&partial)
        .context("private Claude login")?;
    file.write_all(secret)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&partial, claude.join(".credentials.json"))?;
    Ok(prepared)
}

/// Remove private homes a process that has since exited left behind (one
/// killed mid-pass never ran its cleanup).
fn remove_abandoned(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.split('-').next())
            .and_then(|pid| pid.parse::<i32>().ok())
        else {
            continue;
        };
        if pid as u32 == std::process::id() || alive(pid) {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

fn alive(pid: i32) -> bool {
    // No signal: only whether the process exists (one of another user's
    // answers EPERM; on Windows, whether it opens and has not exited).
    agent_relay_probe::platform::process::exists(pid)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A Keychain that holds `secret` (or nothing) and counts secret reads.
    /// A blocking one answers each read only when the test sends the
    /// answer, the way an unanswered prompt holds `SecItemCopyMatching`.
    pub(crate) struct FakeKeychain {
        pub(crate) secret: Option<Vec<u8>>,
        /// The item exists, whether or not this helper may read it.
        present: bool,
        pub(crate) reads: AtomicUsize,
        /// The reads that could show macOS's prompt.
        pub(crate) interactive_reads: AtomicUsize,
        answers: Option<Mutex<std::sync::mpsc::Receiver<Option<Vec<u8>>>>>,
    }

    impl FakeKeychain {
        pub(crate) fn holding(secret: Option<&str>) -> Arc<Self> {
            Arc::new(Self {
                secret: secret.map(|s| s.as_bytes().to_vec()),
                present: secret.is_some(),
                reads: AtomicUsize::new(0),
                interactive_reads: AtomicUsize::new(0),
                answers: None,
            })
        }

        /// An item that exists but that this helper may not read quietly:
        /// the person has not chosen Always Allow.
        pub(crate) fn protected() -> Arc<Self> {
            Arc::new(Self {
                secret: None,
                present: true,
                reads: AtomicUsize::new(0),
                interactive_reads: AtomicUsize::new(0),
                answers: None,
            })
        }

        /// An item that exists and whose every read waits for an answer on
        /// the returned sender: `Some` allows, `None` denies. Dropping the
        /// sender denies whatever read is still waiting.
        pub(crate) fn blocking() -> (Arc<Self>, std::sync::mpsc::Sender<Option<Vec<u8>>>) {
            let (answer, answers) = std::sync::mpsc::channel();
            let fake = Arc::new(Self {
                secret: None,
                present: true,
                reads: AtomicUsize::new(0),
                interactive_reads: AtomicUsize::new(0),
                answers: Some(Mutex::new(answers)),
            });
            (fake, answer)
        }

        pub(crate) fn keychain(self: &Arc<Self>) -> Keychain {
            Keychain::new(self.clone())
        }
    }

    impl KeychainSource for FakeKeychain {
        fn present(&self) -> bool {
            self.present
        }
        fn read(&self, interactive: bool) -> Option<Vec<u8>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if interactive {
                self.interactive_reads.fetch_add(1, Ordering::SeqCst);
            }
            match &self.answers {
                Some(answers) => answers.lock().unwrap().recv().ok().flatten(),
                None => self.secret.clone(),
            }
        }
    }

    pub(crate) fn credentials(expires_at: i64) -> String {
        format!(r#"{{"claudeAiOauth":{{"accessToken":"test-token","expiresAt":{expires_at}}}}}"#)
    }

    const NOW: i64 = 1_800_000_000_000;

    fn write_file(home: &Path, contents: &str) {
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/.credentials.json"), contents).unwrap();
    }

    #[test]
    fn a_current_file_wins_over_the_keychain() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = super::super::tests::EnvGuard::remove(CREDENTIALS_ENV);
        let home = tempfile::tempdir().unwrap();
        write_file(home.path(), &credentials(NOW + 60_000));
        let keychain = FakeKeychain::holding(Some(&credentials(NOW + 60_000)));
        assert_eq!(choose(home.path(), &*keychain, NOW), Login::File);
        let data = tempfile::tempdir().unwrap();
        let prepared = prepare(
            home.path(),
            data.path(),
            &keychain.keychain(),
            NOW,
            Ask::Pass,
        )
        .unwrap();
        assert_eq!(prepared.home(), home.path());
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            0,
            "the Keychain was read"
        );
    }

    #[test]
    fn an_expired_or_absent_file_falls_back_to_the_keychain() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = super::super::tests::EnvGuard::remove(CREDENTIALS_ENV);
        let keychain = FakeKeychain::holding(Some(&credentials(NOW + 60_000)));
        let data = tempfile::tempdir().unwrap();
        for stale in [
            Some(credentials(NOW - 1)),
            Some("not json".to_string()),
            None,
        ] {
            let home = tempfile::tempdir().unwrap();
            if let Some(contents) = &stale {
                write_file(home.path(), contents);
            }
            assert_eq!(choose(home.path(), &*keychain, NOW), Login::Keychain);
            let prepared = prepare(
                home.path(),
                data.path(),
                &keychain.keychain(),
                NOW,
                Ask::Pass,
            )
            .unwrap();
            let file = prepared.home().join(".claude/.credentials.json");
            assert!(prepared
                .home()
                .starts_with(data.path().join("claude-cloud")));
            // Windows has no modes: the profile's access list keeps it private.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode =
                    |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode(&file), 0o600);
                assert_eq!(mode(prepared.home()), 0o700);
                assert_eq!(mode(&prepared.home().join(".claude")), 0o700);
                assert_eq!(mode(&data.path().join("claude-cloud")), 0o700);
            }
            assert!(fresh(&std::fs::read(&file).unwrap(), NOW).unwrap());
            let private = prepared.home().to_path_buf();
            drop(prepared);
            assert!(!private.exists(), "the private login outlived its pass");
            // The person's own file is never touched.
            match &stale {
                Some(contents) => assert_eq!(
                    &std::fs::read_to_string(home.path().join(".claude/.credentials.json"))
                        .unwrap(),
                    contents
                ),
                None => assert!(!home.path().join(".claude").exists()),
            }
        }
    }

    #[test]
    fn an_expired_login_is_not_ready_and_never_written() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = super::super::tests::EnvGuard::remove(CREDENTIALS_ENV);
        let data = tempfile::tempdir().unwrap();
        // Expired file, no Keychain (Linux).
        let home = tempfile::tempdir().unwrap();
        write_file(home.path(), &credentials(NOW - 1));
        assert_eq!(choose(home.path(), &NoKeychain, NOW), Login::Expired);
        assert_eq!(
            prepare(
                home.path(),
                data.path(),
                &Keychain::new(Arc::new(NoKeychain)),
                NOW,
                Ask::Pass
            )
            .err(),
            Some(EXPIRED)
        );
        // Expired Keychain item: read once, refused, nothing left behind.
        let keychain = FakeKeychain::holding(Some(&credentials(NOW - 1)));
        assert_eq!(
            prepare(
                home.path(),
                data.path(),
                &keychain.keychain(),
                NOW,
                Ask::Pass
            )
            .err(),
            Some(EXPIRED)
        );
        assert!(std::fs::read_dir(data.path().join("claude-cloud"))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
        // Nothing anywhere.
        let bare = tempfile::tempdir().unwrap();
        assert_eq!(choose(bare.path(), &NoKeychain, NOW), Login::Missing);
    }

    /// The app's Keychain source is the login Keychain; tests only name it
    /// and never call it, so no test reads the real Keychain.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_app_reads_the_login_keychain() {
        let _source: &dyn KeychainSource = &LoginKeychain;
        assert_eq!(claude_keychain::SERVICE, "Claude Code-credentials");
    }

    #[test]
    fn an_override_never_falls_back_to_the_keychain() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("creds.json");
        std::fs::write(&path, credentials(NOW - 1)).unwrap();
        let _env = super::super::tests::EnvGuard::set(CREDENTIALS_ENV, &path);
        let keychain = FakeKeychain::holding(Some(&credentials(NOW + 60_000)));
        assert_eq!(choose(dir.path(), &*keychain, NOW), Login::Expired);
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 0);
    }

    /// Wait until the fake's pending read has started on its thread.
    fn read_started(fake: &FakeKeychain, reads: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while fake.reads.load(Ordering::SeqCst) < reads {
            assert!(Instant::now() < deadline, "the Keychain read never started");
            std::thread::yield_now();
        }
    }

    #[test]
    fn an_unanswered_read_waits_briefly_and_only_once() {
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = fake.keychain();
        let wait = Duration::from_millis(200);
        let started = Instant::now();
        assert_eq!(keychain.read_within(wait, false), Err(KEYCHAIN_WAITING));
        let waited = started.elapsed();
        assert!(waited >= wait && waited < wait + Duration::from_secs(2));
        read_started(&fake, 1);
        // A later pass, or a clone, joins the read still waiting, and does
        // not wait on it again once its bound has passed.
        let started = Instant::now();
        assert_eq!(keychain.read_within(wait, false), Err(KEYCHAIN_WAITING));
        assert_eq!(
            keychain.clone().read_within(wait, false),
            Err(KEYCHAIN_WAITING)
        );
        assert!(started.elapsed() < wait, "a later pass waited again");
        // A person asking waits their own time on the same read.
        assert_eq!(keychain.read_within(wait, true), Err(KEYCHAIN_WAITING));
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            1,
            "a second read started"
        );
        // Answered meanwhile: the next callers all get the answer.
        answer
            .send(Some(credentials(NOW + 60_000).into_bytes()))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let secret = loop {
            match keychain.read_within(Duration::from_millis(50), true) {
                Ok(secret) => break secret,
                Err(reason) => assert_eq!(reason, KEYCHAIN_WAITING),
            }
            assert!(Instant::now() < deadline, "the answer never arrived");
        };
        assert_eq!(fresh(&secret, NOW), Some(true));
        assert_eq!(keychain.read_within(wait, false), Ok(secret));
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn every_caller_waiting_on_a_read_gets_its_answer() {
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = fake.keychain();
        let waiters: Vec<_> = (0..4)
            .map(|n| {
                let keychain = keychain.clone();
                std::thread::spawn(move || {
                    keychain.read_within(Duration::from_secs(10), n % 2 == 0)
                })
            })
            .collect();
        read_started(&fake, 1);
        // Let every waiter reach the wait before the prompt is answered.
        std::thread::sleep(Duration::from_millis(200));
        let secret = credentials(NOW + 60_000).into_bytes();
        answer.send(Some(secret.clone())).unwrap();
        for waiter in waiters {
            assert_eq!(waiter.join().unwrap(), Ok(secret.clone()));
        }
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            1,
            "a second read started"
        );
    }

    #[test]
    fn an_answer_nobody_collects_is_dropped() {
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = Keychain {
            ttl: Duration::from_millis(100),
            ..fake.keychain()
        };
        assert_eq!(
            keychain.read_within(Duration::from_millis(10), false),
            Err(KEYCHAIN_WAITING)
        );
        read_started(&fake, 1);
        // Answered after its pass gave up, and no pass comes.
        answer
            .send(Some(credentials(NOW + 60_000).into_bytes()))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while keychain.slot.lock().answer.is_none() {
            assert!(Instant::now() < deadline, "the answer never arrived");
            std::thread::yield_now();
        }
        while keychain.slot.lock().answer.is_some() {
            assert!(Instant::now() < deadline, "the answer outlived its time");
            std::thread::sleep(Duration::from_millis(10));
        }
        // The next pass reads again.
        assert_eq!(
            keychain.read_within(Duration::from_millis(10), false),
            Err(KEYCHAIN_WAITING)
        );
        read_started(&fake, 2);
    }

    #[test]
    fn an_answer_is_dropped_once_the_keychain_is_not_the_login() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = super::super::tests::EnvGuard::remove(CREDENTIALS_ENV);
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = fake.keychain();
        answer
            .send(Some(credentials(NOW + 60_000).into_bytes()))
            .unwrap();
        assert!(keychain.read_within(Duration::from_secs(5), false).is_ok());
        assert!(keychain.slot.lock().answer.is_some());
        // Claude Code wrote a current file: the Keychain's answer goes.
        let home = tempfile::tempdir().unwrap();
        write_file(home.path(), &credentials(NOW + 60_000));
        let data = tempfile::tempdir().unwrap();
        let prepared = prepare(home.path(), data.path(), &keychain, NOW, Ask::Pass).unwrap();
        assert_eq!(prepared.home(), home.path());
        assert!(keychain.slot.lock().answer.is_none());
    }

    #[test]
    fn a_later_answer_prepares_the_next_pass() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = super::super::tests::EnvGuard::remove(CREDENTIALS_ENV);
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = fake.keychain();
        let started = Instant::now();
        assert_eq!(
            prepare(home.path(), data.path(), &keychain, NOW, Ask::Pass).err(),
            Some(KEYCHAIN_WAITING)
        );
        assert!(started.elapsed() < PASS_WAIT + Duration::from_secs(2));
        read_started(&fake, 1);
        answer
            .send(Some(credentials(NOW + 60_000).into_bytes()))
            .unwrap();
        // The read finishes on its own thread; the next pass uses it.
        keychain.wait_answered();
        let prepared = prepare(home.path(), data.path(), &keychain, NOW, Ask::Pass).unwrap();
        assert!(prepared
            .home()
            .starts_with(data.path().join("claude-cloud")));
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_protected_keychain_login_is_reported_as_denied() {
        let _lock = super::super::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _env = super::super::tests::EnvGuard::remove(CREDENTIALS_ENV);
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let keychain = FakeKeychain::protected();
        assert_eq!(choose(home.path(), &*keychain, NOW), Login::Keychain);
        assert_eq!(
            prepare(
                home.path(),
                data.path(),
                &keychain.keychain(),
                NOW,
                Ask::Pass
            )
            .err(),
            Some(KEYCHAIN_DENIED)
        );
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 1);
        assert_eq!(keychain.interactive_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_person_is_asked_even_while_a_quiet_read_is_in_flight() {
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = fake.keychain();
        // A pass's quiet read is still unanswered.
        assert_eq!(
            keychain.read_within(Duration::from_millis(10), false),
            Err(KEYCHAIN_WAITING)
        );
        let person = {
            let keychain = keychain.clone();
            std::thread::spawn(move || keychain.read_within(Duration::from_secs(5), true))
        };
        // The quiet read is refused; the person is then asked, and allows.
        answer.send(None).unwrap();
        answer
            .send(Some(credentials(NOW + 60_000).into_bytes()))
            .unwrap();
        assert!(person.join().unwrap().is_ok());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
        assert_eq!(fake.interactive_reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_a_person_is_asked_and_a_refusal_is_read_again() {
        let (fake, answer) = FakeKeychain::blocking();
        let keychain = fake.keychain();
        let wait = Duration::from_secs(5);
        let allow = || {
            answer
                .send(Some(credentials(NOW + 60_000).into_bytes()))
                .unwrap()
        };
        // A pass reads quietly, and its refusal is not kept: the next pass
        // reads again, so access granted since is used.
        answer.send(None).unwrap();
        assert_eq!(keychain.read_within(wait, false), Err(KEYCHAIN_DENIED));
        allow();
        assert!(keychain.read_within(wait, false).is_ok());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
        assert_eq!(
            fake.interactive_reads.load(Ordering::SeqCst),
            0,
            "a pass raised the prompt"
        );
        // A person's read may show the prompt.
        keychain.forget();
        allow();
        assert!(keychain.read_within(wait, true).is_ok());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 3);
        assert_eq!(fake.interactive_reads.load(Ordering::SeqCst), 1);
    }
}
