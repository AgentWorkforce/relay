//! Local table presentation; never changes upload or messaging state.
use super::LocalSessionSortColumn;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const DEFAULT_WINDOW_WIDTH: i32 = 1280;
pub const DEFAULT_WINDOW_HEIGHT: i32 = 800;
pub const SESSION_COLUMNS_KEY: &str = "sessionColumns.v1";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionColumn {
    Session,
    Project,
    Updated,
    Relay,
    Upload,
    Harness,
    Directory,
    #[serde(rename = "sessionID")]
    SessionID,
    Status,
    Model,
    Reasoning,
    Created,
}
impl SessionColumn {
    pub const ALL: [Self; 12] = [
        Self::Session,
        Self::Status,
        Self::Project,
        Self::Updated,
        Self::Relay,
        Self::Upload,
        Self::Harness,
        Self::Directory,
        Self::SessionID,
        Self::Model,
        Self::Reasoning,
        Self::Created,
    ];
    pub fn title(self) -> &'static str {
        match self {
            Self::Session => "Session",
            Self::Project => "Project",
            Self::Updated => "Updated",
            Self::Relay => "Messages",
            Self::Upload => "Upload",
            Self::Harness => "Harness",
            Self::Directory => "Directory",
            Self::SessionID => "Session ID",
            Self::Status => "Status",
            Self::Model => "Model",
            Self::Reasoning => "Reasoning",
            Self::Created => "Created",
        }
    }
    pub fn width(self) -> i32 {
        match self {
            Self::Session => 420,
            Self::Project => 160,
            Self::Harness => 140,
            Self::Updated => 120,
            Self::Relay => 126,
            Self::Upload => 100,
            Self::Directory | Self::SessionID => 220,
            Self::Status => 100,
            Self::Reasoning => 130,
            Self::Model | Self::Created => 200,
        }
    }
    pub fn minimum_width(self) -> i32 {
        match self {
            Self::Session => 120,
            Self::Relay => 126,
            _ => 80,
        }
    }
    pub fn default_visible(self) -> bool {
        Self::ALL[..6].contains(&self)
    }
    pub fn sort_column(self) -> Option<LocalSessionSortColumn> {
        Some(match self {
            Self::Session => LocalSessionSortColumn::Session,
            Self::Project => LocalSessionSortColumn::Project,
            Self::Updated => LocalSessionSortColumn::Updated,
            Self::Relay => LocalSessionSortColumn::Relay,
            Self::Upload => LocalSessionSortColumn::Upload,
            Self::Harness => LocalSessionSortColumn::Harness,
            Self::Model => LocalSessionSortColumn::Model,
            Self::Reasoning => LocalSessionSortColumn::Reasoning,
            Self::Status => LocalSessionSortColumn::Status,
            Self::Created => LocalSessionSortColumn::Created,
            Self::Directory => LocalSessionSortColumn::Directory,
            Self::SessionID => LocalSessionSortColumn::SessionID,
        })
    }
    pub fn id(self) -> String {
        serde_json::to_value(self)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionColumnLayout {
    pub order: Vec<SessionColumn>,
    hidden: HashSet<SessionColumn>,
    widths: HashMap<SessionColumn, i32>,
}
impl Default for SessionColumnLayout {
    fn default() -> Self {
        Self {
            order: SessionColumn::ALL.to_vec(),
            widths: HashMap::new(),
            hidden: SessionColumn::ALL
                .into_iter()
                .filter(|c| !c.default_visible())
                .collect(),
        }
    }
}
impl SessionColumnLayout {
    pub fn from_value(value: Option<&Value>) -> Self {
        let mut result = Self::default();
        let Some(entries) = value.and_then(Value::as_array) else {
            return result;
        };
        let mut seen = Vec::new();
        for entry in entries {
            let Some(column) = entry
                .get("id")
                .and_then(|v| serde_json::from_value::<SessionColumn>(v.clone()).ok())
            else {
                continue;
            };
            if seen.contains(&column) {
                continue;
            }
            seen.push(column);
            if let Some(width) = entry
                .get("width")
                .and_then(Value::as_f64)
                .filter(|w| w.is_finite())
            {
                result.set_width(column, width.round() as i32);
            }
            result.hidden.retain(|c| *c != column);
            if !entry
                .get("visible")
                .and_then(Value::as_bool)
                .unwrap_or(column.default_visible())
            {
                result.hidden.insert(column);
            }
        }
        for column in SessionColumn::ALL {
            if !seen.contains(&column) {
                seen.push(column);
            }
        }
        result.order = seen;
        if result.visible().is_empty() {
            result.hidden.retain(|c| *c != result.order[0]);
        }
        result
    }
    pub fn visible(&self) -> Vec<SessionColumn> {
        self.order
            .iter()
            .copied()
            .filter(|c| !self.hidden.contains(c))
            .collect()
    }
    pub fn expanding_column(&self) -> Option<SessionColumn> {
        let visible = self.visible();
        if visible.contains(&SessionColumn::Session) {
            Some(SessionColumn::Session)
        } else {
            visible.last().copied()
        }
    }
    pub fn width(&self, column: SessionColumn) -> i32 {
        self.widths.get(&column).copied().unwrap_or(column.width())
    }
    pub fn has_widths(&self) -> bool {
        !self.widths.is_empty()
    }
    pub fn set_width(&mut self, column: SessionColumn, width: i32) {
        self.widths
            .insert(column, width.clamp(column.minimum_width(), 1200));
    }
    pub fn set_visible(&mut self, column: SessionColumn, visible: bool) {
        if visible {
            self.hidden.retain(|c| *c != column);
        } else if self.visible().len() > 1 && !self.hidden.contains(&column) {
            self.hidden.insert(column);
        }
    }
    pub fn move_to(&mut self, column: SessionColumn, target: SessionColumn) {
        let (Some(from), Some(to)) = (
            self.order.iter().position(|c| *c == column),
            self.order.iter().position(|c| *c == target),
        ) else {
            return;
        };
        self.order.remove(from);
        self.order.insert(to, column);
    }
    pub fn value(&self) -> Value {
        json!(self
            .order
            .iter()
            .map(|c| {
                let mut entry = json!({"id": c, "visible": !self.hidden.contains(c)});
                if let Some(width) = self.widths.get(c) {
                    entry["width"] = json!(width);
                }
                entry
            })
            .collect::<Vec<_>>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_takes_spare_width_and_defaults_fit_the_window() {
        let mut layout = SessionColumnLayout::default();
        assert_eq!(layout.expanding_column(), Some(SessionColumn::Session));
        assert!(layout.width(SessionColumn::Session) >= 400);
        assert!(
            100 + layout
                .visible()
                .iter()
                .map(|c| layout.width(*c))
                .sum::<i32>()
                + 5 * 16
                + 48
                <= DEFAULT_WINDOW_WIDTH
        );
        layout.move_to(SessionColumn::Upload, SessionColumn::Session);
        assert_eq!(layout.expanding_column(), Some(SessionColumn::Session));
        layout.set_visible(SessionColumn::Session, false);
        assert_eq!(layout.expanding_column(), layout.visible().last().copied());
    }
    #[test]
    fn widths_restore_clamp_and_survive_hide_and_move() {
        let mut layout = SessionColumnLayout::from_value(Some(&json!([
            {"id": "session", "visible": true, "width": 555},
            {"id": "project", "visible": true, "width": -1},
            {"id": "updated", "width": 9000},
            {"id": "status", "width": "bad"}
        ])));
        layout.set_visible(SessionColumn::Session, false);
        layout.move_to(SessionColumn::Session, SessionColumn::Upload);
        assert_eq!(layout.width(SessionColumn::Session), 555);
        assert_eq!(layout.width(SessionColumn::Project), 80);
        assert_eq!(layout.width(SessionColumn::Updated), 1200);
        assert_eq!(layout.width(SessionColumn::Status), 100);
        assert_eq!(
            SessionColumnLayout::from_value(Some(&layout.value())),
            layout
        );
        assert!(!SessionColumnLayout::default().has_widths());
    }
    #[test]
    fn hide_last_move_and_restore() {
        let mut layout = SessionColumnLayout::default();
        assert_eq!(layout.visible(), SessionColumn::ALL[..6]);
        layout.move_to(SessionColumn::Updated, SessionColumn::Session);
        layout.set_visible(SessionColumn::Project, false);
        layout.set_visible(SessionColumn::Directory, true);
        assert_eq!(
            layout.visible(),
            vec![
                SessionColumn::Updated,
                SessionColumn::Session,
                SessionColumn::Status,
                SessionColumn::Relay,
                SessionColumn::Upload,
                SessionColumn::Directory
            ]
        );
        assert_eq!(
            SessionColumnLayout::from_value(Some(&layout.value())),
            layout
        );
        for column in layout.visible() {
            layout.set_visible(column, false);
        }
        assert_eq!(layout.visible(), vec![SessionColumn::Directory]);
    }
    #[test]
    fn corrupted_old_and_empty_preferences_recover() {
        assert_eq!(
            SessionColumnLayout::from_value(Some(&json!("broken"))),
            SessionColumnLayout::default()
        );
        let layout = SessionColumnLayout::from_value(Some(&json!([
            {"id": "updated", "visible": false}, {"id": "retired", "visible": true}, {"id": "updated", "visible": true}
        ])));
        assert_eq!(layout.order[0], SessionColumn::Updated);
        assert!(!layout.visible().contains(&SessionColumn::Updated));
        assert_eq!(layout.order.len(), SessionColumn::ALL.len());
        let hidden = json!(SessionColumn::ALL.map(|c| json!({"id":c, "visible":false})));
        assert_eq!(
            SessionColumnLayout::from_value(Some(&hidden)).visible(),
            vec![SessionColumn::Session]
        );
    }
    #[test]
    fn preferences_survive_a_restart_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop.json");
        let mut preferences = crate::linux_app::prefs::Preferences::load(path.clone());
        let mut layout = SessionColumnLayout::default();
        layout.set_width(SessionColumn::Session, 700);
        layout.set_width(SessionColumn::Upload, 350);
        layout.move_to(SessionColumn::Upload, SessionColumn::Session);
        layout.set_visible(SessionColumn::Project, false);
        preferences
            .set(SESSION_COLUMNS_KEY, layout.value())
            .unwrap();
        let mut restored = crate::linux_app::prefs::Preferences::load(path.clone());
        assert_eq!(
            SessionColumnLayout::from_value(restored.get(SESSION_COLUMNS_KEY)),
            layout
        );
        restored
            .set(SESSION_COLUMNS_KEY, SessionColumnLayout::default().value())
            .unwrap();
        assert_eq!(
            SessionColumnLayout::from_value(
                crate::linux_app::prefs::Preferences::load(path).get(SESSION_COLUMNS_KEY)
            ),
            SessionColumnLayout::default()
        );
    }
}

#[cfg(test)]
mod sorting_tests {
    use super::*;
    #[test]
    fn every_column_has_a_matching_sort() {
        for column in SessionColumn::ALL {
            assert_eq!(
                column.sort_column().map(|sort| sort.title()),
                Some(column.title())
            );
        }
        assert!(!LocalSessionSortColumn::Created.starts_ascending());
    }
}
