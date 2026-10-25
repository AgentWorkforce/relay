//! Local, named snapshots of session presentation preferences.
use super::{LocalSessionSort, SessionColumnLayout};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SAVED_SESSION_VIEWS_KEY: &str = "savedSessionViews.v1";
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionViewConfiguration {
    pub search: String,
    pub grouping: u32,
    pub sort: LocalSessionSort,
    pub columns: Value,
    pub show_hidden: bool,
}
impl SessionViewConfiguration {
    pub fn layout(&self) -> SessionColumnLayout {
        SessionColumnLayout::from_value(Some(&self.columns))
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedSessionView {
    pub id: u64,
    pub name: String,
    pub configuration: SessionViewConfiguration,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SavedSessionViews {
    pub views: Vec<SavedSessionView>,
    pub default_id: Option<u64>,
}
impl SavedSessionViews {
    pub fn from_value(value: Option<&Value>) -> Self {
        let mut result: Self = value
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        if result.default_view().is_none() {
            result.default_id = None;
        }
        result
    }
    pub fn default_view(&self) -> Option<&SavedSessionView> {
        self.views.iter().find(|v| Some(v.id) == self.default_id)
    }
    pub fn can_save(&self, name: &str) -> bool {
        !name.trim().is_empty()
            && !self
                .views
                .iter()
                .any(|v| v.name.to_lowercase() == name.trim().to_lowercase())
    }
    pub fn save(
        &mut self,
        name: &str,
        configuration: SessionViewConfiguration,
        make_default: bool,
    ) -> Option<u64> {
        if !self.can_save(name) {
            return None;
        }
        let id = self
            .views
            .iter()
            .map(|v| v.id)
            .max()
            .unwrap_or(0)
            .checked_add(1)?;
        self.views.push(SavedSessionView {
            id,
            name: name.trim().to_owned(),
            configuration,
        });
        if make_default {
            self.default_id = Some(id);
        }
        Some(id)
    }
    pub fn set_default(&mut self, id: Option<u64>) {
        self.default_id = self.views.iter().find(|v| Some(v.id) == id).map(|v| v.id);
    }
    pub fn delete(&mut self, id: u64) {
        self.views.retain(|v| v.id != id);
        if self.default_id == Some(id) {
            self.default_id = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux_app::models::{LocalSessionSortColumn, SessionColumn};
    #[test]
    fn saved_views_restore_the_entire_configuration_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop.json");
        let mut prefs = crate::linux_app::prefs::Preferences::load(path.clone());
        let mut layout = SessionColumnLayout::default();
        layout.set_width(SessionColumn::Session, 640);
        layout.set_visible(SessionColumn::Project, false);
        layout.move_to(SessionColumn::Updated, SessionColumn::Session);
        let config = SessionViewConfiguration {
            search: "updated:>=2026-10-08".into(),
            grouping: 1,
            sort: LocalSessionSort {
                column: LocalSessionSortColumn::Session,
                ascending: true,
            },
            columns: layout.value(),
            show_hidden: true,
        };
        let mut views = SavedSessionViews::default();
        let id = views.save(" Last week ", config.clone(), true).unwrap();
        assert!(!views.can_save("last WEEK"));
        assert!(!views.can_save("  "));
        prefs
            .set(
                SAVED_SESSION_VIEWS_KEY,
                serde_json::to_value(&views).unwrap(),
            )
            .unwrap();
        let prefs = crate::linux_app::prefs::Preferences::load(path);
        let mut restored = SavedSessionViews::from_value(prefs.get(SAVED_SESSION_VIEWS_KEY));
        assert_eq!(restored.default_view().unwrap().configuration, config);
        assert_eq!(
            restored.default_view().unwrap().configuration.layout(),
            layout
        );
        restored.delete(id);
        assert!(restored.views.is_empty());
        assert!(restored.default_view().is_none());
        assert_eq!(restored.default_id, None);
    }
    #[test]
    fn default_changes_and_corrupt_preferences_are_safe() {
        assert_eq!(
            SavedSessionViews::from_value(Some(&serde_json::json!("broken"))),
            SavedSessionViews::default()
        );
        let mut views = SavedSessionViews::default();
        views.set_default(Some(42));
        assert_eq!(views.default_id, None);
    }
}
