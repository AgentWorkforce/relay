//! Inline title editing state. Native writes are optimistic and revision-fenced;
//! refreshing a session list never replaces an unsaved draft.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionTitleEdit {
    pub draft: Option<String>,
    pub optimistic: Option<String>,
    pub error: Option<String>,
    pub supported: Option<bool>,
    pub reason: Option<String>,
    pub checking: bool,
    pub capability_checked_at: Option<i64>,
    pub pending: bool,
    revision: u64,
    previous: Option<String>,
    baseline: Option<String>,
    expires_at: Option<i64>,
    previous_expires_at: Option<i64>,
}

impl SessionTitleEdit {
    /// A disconnected view drops its RPC completions. Retire their state while
    /// retaining the person's text so a reconnect can verify and retry it.
    pub fn interrupted(&mut self) {
        let draft = if self.pending {
            self.optimistic.take()
        } else {
            self.draft.take()
        };
        let error = self.pending.then(|| {
            "The connection was interrupted. Check the session title before trying again."
                .to_owned()
        });
        *self = Self {
            draft,
            error,
            revision: self.revision.wrapping_add(1),
            baseline: self.baseline.take(),
            ..Default::default()
        };
    }
    pub fn begin(&mut self, title: &str) {
        if !self.pending {
            let title = self.optimistic.as_deref().unwrap_or(title).to_owned();
            self.baseline = Some(title.clone());
            self.draft = Some(title);
            self.error = None;
        }
    }
    pub fn cancel(&mut self) {
        self.draft = None;
        self.error = None;
    }
    pub fn save(&mut self) -> Option<(u64, String)> {
        if self.pending || self.supported != Some(true) {
            return None;
        }
        let title = self.draft.as_ref()?.trim().to_owned();
        if title.is_empty()
            || self
                .baseline
                .as_deref()
                .is_some_and(|old| old.trim() == title)
        {
            self.cancel();
            return None;
        }
        if title.chars().count() > 200 || title.chars().any(char::is_control) {
            self.error =
                Some("Enter a title of 1–200 characters without control characters.".into());
            return None;
        }
        self.revision += 1;
        self.pending = true;
        self.previous = self.optimistic.replace(title.clone());
        self.previous_expires_at = self.expires_at.take();
        self.draft = None;
        self.error = None;
        Some((self.revision, title))
    }
    pub fn finish(&mut self, revision: u64, result: Result<String, String>, now: i64) {
        if !self.pending || self.revision != revision {
            return;
        }
        self.pending = false;
        match result {
            Ok(title) => {
                self.optimistic = Some(title);
                self.previous = None;
                self.expires_at = Some(now.saturating_add(60_000));
                self.previous_expires_at = None;
            }
            Err(error) => {
                self.draft = self.optimistic.take();
                self.optimistic = self.previous.take();
                self.expires_at = self.previous_expires_at.take();
                self.error = Some(error);
            }
        }
    }
    pub fn observed(&mut self, title: &str) {
        if !self.pending && self.optimistic.as_deref() == Some(title) {
            self.optimistic = None;
            self.expires_at = None;
        }
    }
    pub fn expire(&mut self, now: i64) {
        if !self.pending && self.expires_at.is_some_and(|at| at <= now) {
            self.optimistic = None;
            self.expires_at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interruption_retires_checks_and_saves_without_losing_drafts() {
        let mut edit = SessionTitleEdit::default();
        edit.checking = true;
        edit.interrupted();
        assert!(!edit.checking);
        edit.supported = Some(true);
        edit.begin("Current");
        edit.draft = Some("Unsaved draft".into());
        edit.interrupted();
        assert_eq!(edit.draft.as_deref(), Some("Unsaved draft"));
        edit.supported = Some(true);
        let (old_revision, _) = edit.save().unwrap();
        edit.interrupted();
        assert!(!edit.pending);
        assert!(edit.optimistic.is_none());
        assert_eq!(edit.draft.as_deref(), Some("Unsaved draft"));
        assert!(edit.error.is_some());
        edit.supported = Some(true);
        let (new_revision, _) = edit.save().unwrap();
        edit.finish(old_revision, Ok("Old answer".into()), 0);
        assert!(edit.pending);
        edit.finish(new_revision, Ok("New answer".into()), 0);
        assert_eq!(edit.optimistic.as_deref(), Some("New answer"));
    }

    #[test]
    fn optimistic_title_survives_stale_refresh_and_rolls_back_on_failure() {
        let mut edit = SessionTitleEdit {
            supported: Some(true),
            ..Default::default()
        };
        edit.begin("Original");
        edit.draft = Some("  New title  ".into());
        let (revision, title) = edit.save().unwrap();
        assert_eq!(title, "New title");
        edit.observed("Original");
        assert_eq!(edit.optimistic.as_deref(), Some("New title"));
        edit.finish(revision + 1, Ok("Wrong response".into()), 0);
        assert!(edit.pending);
        edit.finish(revision, Err("Could not rename".into()), 0);
        assert_eq!(edit.optimistic, None);
        assert_eq!(edit.draft.as_deref(), Some("New title"));
        assert_eq!(edit.error.as_deref(), Some("Could not rename"));
    }
    #[test]
    fn acknowledgement_releases_overlay_and_cancel_does_not_save() {
        let mut edit = SessionTitleEdit {
            supported: Some(true),
            ..Default::default()
        };
        edit.begin("Original");
        edit.draft = Some("Generated title".into());
        edit.cancel();
        assert!(edit.save().is_none());
        edit.begin("Original");
        edit.draft = Some("Final".into());
        let (revision, _) = edit.save().unwrap();
        edit.finish(revision, Ok("Final".into()), 0);
        edit.observed("Original");
        assert_eq!(edit.optimistic.as_deref(), Some("Final"));
        edit.observed("Final");
        assert_eq!(edit.optimistic, None);
    }
    #[test]
    fn acknowledged_overlays_expire_without_clearing_a_newer_write() {
        let mut edit = SessionTitleEdit {
            supported: Some(true),
            ..Default::default()
        };
        edit.begin("Original");
        edit.draft = Some("First".into());
        let (revision, _) = edit.save().unwrap();
        edit.finish(revision, Ok("First".into()), 100);
        edit.expire(60_099);
        assert_eq!(edit.optimistic.as_deref(), Some("First"));
        edit.begin("Original");
        edit.draft = Some("Second".into());
        let (revision, _) = edit.save().unwrap();
        edit.expire(60_100);
        assert_eq!(edit.optimistic.as_deref(), Some("Second"));
        edit.finish(revision, Ok("Second".into()), 60_100);
        edit.expire(60_100);
        assert_eq!(edit.optimistic.as_deref(), Some("Second"));
        edit.expire(120_100);
        assert_eq!(edit.optimistic, None);
    }
    #[test]
    fn unchanged_title_remains_a_noop_after_reconnect() {
        let mut edit = SessionTitleEdit {
            supported: Some(true),
            ..Default::default()
        };
        edit.begin("Original");
        edit.interrupted();
        edit.supported = Some(true);
        assert!(edit.save().is_none());
        assert!(edit.draft.is_none());
        assert!(!edit.pending);
    }

    #[test]
    fn unsupported_blank_and_control_character_titles_never_save() {
        let mut edit = SessionTitleEdit::default();
        edit.begin("Title");
        assert!(edit.save().is_none());
        edit.supported = Some(true);
        for title in ["  ", "Hello\nworld"] {
            edit.draft = Some(title.into());
            assert!(edit.save().is_none());
            assert!(!edit.pending);
        }
    }
}
