//! Refresh long-lived capture handles when folder consent changes.
use super::*;

/// A small settings read once a second invalidates retained roots and iterator
/// positions. Failed refreshes block acquisition until the new consent can be
/// applied; an old store must not keep reading a newly unshared folder.
#[derive(Clone, Default)]
pub struct RootSettings {
    loaded: Option<Option<Vec<u8>>>,
    checked: Option<Instant>,
    unavailable: bool,
    recorded: Option<claude_dirs::Recorded>,
}
impl RootSettings {
    /// Discover newly created sibling roots without rereading mutable choices.
    pub fn extra_claude_roots(&self, store: &SessionStore) -> Result<Vec<ProviderRoots>> {
        ensure!(!self.unavailable, "capture roots refresh pending");
        let recorded = self
            .recorded
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("capture roots not validated"))?;
        Ok(extra_claude_roots_recorded(store.roots(), recorded))
    }

    /// Rebind a newly opened reader to the existing validated snapshot.
    pub fn bind(&self, store: &SessionStore) -> Result<SessionStore> {
        ensure!(!self.unavailable, "capture roots refresh pending");
        let recorded = self
            .recorded
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("capture roots not validated"))?;
        open_snapshot(store, recorded)
    }

    pub fn last_checked(&self) -> Option<Instant> {
        self.checked
    }

    pub fn invalidate(&mut self) {
        self.checked = None;
    }

    /// Compare with the settings that opened the retained store, not a fresh
    /// baseline that could already include a revoked folder.
    pub fn changed(&self, store: &SessionStore) -> bool {
        let env = |key: &str| std::env::var(key).ok();
        let file = relay_home(&env, &store.roots().home).join(claude_dirs::FILE);
        let current = match std::fs::read(file) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return true,
        };
        self.loaded.as_ref() != Some(&current)
    }

    pub fn refresh(&mut self, store: &mut SessionStore) -> Result<bool> {
        if self
            .checked
            .is_some_and(|at| at.elapsed() < Duration::from_secs(1))
        {
            return if self.unavailable {
                Err(anyhow::anyhow!("capture roots refresh pending"))
            } else {
                Ok(false)
            };
        }
        self.checked = Some(Instant::now());
        self.unavailable = true;
        let env = |key: &str| std::env::var(key).ok();
        let file = relay_home(&env, &store.roots().home).join(claude_dirs::FILE);
        let dirs = ClaudeDirs::from_env(
            &env,
            &store.roots().home,
            &relay_home(&env, &store.roots().home),
        );
        dirs.remember_running(&SystemProcesses::default());
        let settings = match std::fs::read(file) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if self.loaded.as_ref() == Some(&settings) {
            self.unavailable = false;
            return Ok(false);
        }
        // Reject malformed settings instead of silently reverting to the
        // default sharing choice while an external writer is replacing them.
        let recorded = settings
            .as_deref()
            .map(serde_json::from_slice::<claude_dirs::Recorded>)
            .transpose()?
            .unwrap_or_default();
        *store = open_snapshot(store, &recorded)?;
        self.loaded = Some(settings);
        self.recorded = Some(recorded);
        self.unavailable = false;
        Ok(true)
    }
}

fn open_snapshot(store: &SessionStore, recorded: &claude_dirs::Recorded) -> Result<SessionStore> {
    let env = |key: &str| std::env::var(key).ok();
    let mut roots = ProviderRoots::from_env(store.roots().home.clone());
    let default = claude_dirs::default_home(&env, &roots.home);
    if !recorded.choice(&default).shared {
        roots.claude = store.db_path().with_extension("claude-not-shared");
    }
    // Never reread mutable settings through open() after snapshot validation.
    open_with(store.db_path(), roots)
}

#[cfg(test)]
mod snapshot_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_uses_validated_choices_even_if_settings_change_before_open() {
        let Some(home) = crate::live::tests::isolated_home("history::roots::tests::candidate_uses_validated_choices_even_if_settings_change_before_open") else { return; };
        let store = open(&home.join("probe/history.db")).unwrap();
        let env = |key: &str| std::env::var(key).ok();
        let dirs = ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home));
        let default = home.join(".claude");
        dirs.set_shared(default.to_str().unwrap(), false, &default)
            .unwrap();
        let validated = dirs.recorded();
        std::fs::write(dirs.file.as_ref().unwrap(), b"{").unwrap();
        let candidate = open_snapshot(&store, &validated).unwrap();
        assert_ne!(
            candidate.roots().claude,
            default,
            "a later malformed read must not replace the validated denial with default sharing"
        );
    }

    #[test]
    fn retained_roots_follow_default_folder_consent_and_retry_bad_settings() {
        let Some(home) = crate::live::tests::isolated_home("history::roots::tests::retained_roots_follow_default_folder_consent_and_retry_bad_settings") else { return; };
        let env = |key: &str| std::env::var(key).ok();
        let dirs = ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home));
        let default = claude_dirs::default_home(&env, &home);
        std::fs::create_dir_all(default.join("projects/p")).unwrap();
        dirs.set_shared(default.to_str().unwrap(), false, &default)
            .unwrap();
        let mut store = open(&home.join("probe/history.db")).unwrap();
        let mut settings = RootSettings::default();
        assert!(settings.refresh(&mut store).unwrap());
        assert_ne!(store.roots().claude, default);
        dirs.set_shared(default.to_str().unwrap(), true, &default)
            .unwrap();
        settings.checked = None;
        assert!(settings.refresh(&mut store).unwrap());
        assert_eq!(store.roots().claude, default);
        let transcript = default.join("projects/p/consent.jsonl");
        crate::live::tests::append(
            &transcript,
            &crate::live::tests::transcript_line("consent", "one"),
        );
        sweep_paths_once(
            &store,
            true,
            Some(vec![Source::Claude]),
            Some(vec![transcript.clone()]),
            || false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            rusqlite::Connection::open(store.db_path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM session_events WHERE session_id='consent'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        dirs.set_shared(default.to_str().unwrap(), false, &default)
            .unwrap();
        settings.checked = None;
        assert!(settings.refresh(&mut store).unwrap());
        crate::live::tests::append(
            &transcript,
            &crate::live::tests::transcript_line("consent", "two"),
        );
        sweep_paths_once(
            &store,
            true,
            Some(vec![Source::Claude]),
            Some(vec![transcript]),
            || false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            rusqlite::Connection::open(store.db_path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM session_events WHERE session_id='consent'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1,
            "unshared hot path must not acquire"
        );
        std::fs::write(dirs.file.as_ref().unwrap(), b"{").unwrap();
        settings.checked = None;
        assert!(settings.refresh(&mut store).is_err());
        assert!(
            settings.refresh(&mut store).is_err(),
            "retry delay must not permit old roots"
        );
        assert_ne!(store.roots().claude, default);
    }
}
