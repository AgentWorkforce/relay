//! Rebuild the editable transcript heading for the selected native session.
use super::*;

impl App {
    pub(super) fn install_transcript_title(&self, page: &TranscriptPage, row: &LocalSessionRow) {
        clear(&page.title_group);
        page.title_cell.borrow_mut().take();
        if let Some(parent) = page.title.parent().and_downcast::<gtk::Button>() {
            parent.set_child(None::<&gtk::Widget>);
        }
        if let Some(parent) = page.title.parent().and_downcast::<gtk::Stack>() {
            parent.remove(&page.title);
        }
        if let Some(parent) = page.title.parent().and_downcast::<gtk::Box>() {
            parent.remove(&page.title);
        }
        let cell =
            crate::linux_app::ui::session_titles::SessionTitleCell::build(self, row, &page.title);
        page.title_group.append(&cell.root);
        page.title_group.append(&page.subtitle);
        *page.title_cell.borrow_mut() = Some(cell);
        page.title.set_text(&row.title());
        page.title.set_tooltip_text(Some(&row.title()));
        page.subtitle.set_text(
            &[
                source_name(row.source()),
                row.project(),
                "Local transcript".into(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
        );
    }
}
