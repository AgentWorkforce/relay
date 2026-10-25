//! The “Start Capy thread…” window. Cloud owns the Capy key; this view saves
//! one client operation before asking the relay core to call Cloud.

use super::app::App;
use super::widgets::{self, button, hbox, text, vbox, LabelStyle};
use crate::linux_app::models::{
    cloud_settings_url, CapySpawnOperation, CAPY_STARTING, CAPY_WAITING,
};
use crate::relay::contract::capy::{
    CapyBindingState, CapyProject, CapyPullRequestAuthor, CapyThreadSpawn,
};
use gtk::prelude::*;
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

mod operations;

pub(super) struct CapySpawnDialog {
    pub window: gtk::Window,
    form: gtk::Box,
    project: gtk::DropDown,
    project_ids: RefCell<Vec<String>>,
    task: gtk::TextView,
    model: gtk::Entry,
    author: gtk::DropDown,
    start: gtk::Button,
    spinner: gtk::Spinner,
    status: gtk::Label,
    thread: gtk::Label,
    agent: RefCell<Option<String>>,
    agent_row: gtk::Box,
    agent_value: gtk::Label,
    result_actions: gtk::Box,
    error: gtk::Label,
    settings: gtk::Button,
    retry_status: gtk::Button,
    operation: RefCell<Option<CapySpawnOperation>>,
    polls: Cell<u8>,
}

impl CapySpawnDialog {
    fn build(app: &App, operation: Option<CapySpawnOperation>) -> Rc<Self> {
        let window = gtk::Window::builder()
            .title("Start Capy thread — Agent Relay")
            .transient_for(app.window())
            .modal(true)
            .resizable(false)
            .default_width(520)
            .build();
        if let Some(application) = app.window().application() {
            window.set_application(Some(&application));
        }
        let root = vbox(16, &[]);
        widgets::pad(&root, 20, None, None);
        let header = hbox(8, &[]);
        let heading = text("Start Capy thread", &["headline"]);
        heading.set_hexpand(true);
        header.append(&heading);
        let close_window = window.downgrade();
        header.append(&button("Done", &[], move || {
            if let Some(window) = close_window.upgrade() {
                window.close();
            }
        }));
        root.append(&header);
        root.append(
            &text(
                "Start a headless Capy session in this workspace. It will join Agent Relay on its first turn.",
                &["secondary"],
            )
            .wrapped(),
        );

        let form = vbox(14, &[]);
        let project = gtk::DropDown::from_strings(&["Loading Capy projects…"]);
        widgets::name(&project, "Capy project");
        form.append(&field("Project", &project));

        let task = gtk::TextView::new();
        task.set_wrap_mode(gtk::WrapMode::WordChar);
        task.set_size_request(-1, 110);
        task.add_css_class("compose");
        widgets::name(&task, "Task");
        form.append(&field("Task", &task));

        let model = gtk::Entry::new();
        model.set_placeholder_text(Some("Use the project default"));
        widgets::name(&model, "Model (optional)");
        form.append(&field("Model (optional)", &model));

        let author = gtk::DropDown::from_strings(&["Project default", "You", "Capy"]);
        widgets::name(&author, "Pull request author");
        form.append(&field("Pull request author", &author));

        let error = text("", &["warn", "caption"]).wrapped();
        error.set_visible(false);
        widgets::name(&error, "Capy spawn error");
        let settings = button(
            "Agent Relay Cloud → Settings → Workspace → Capy",
            &["flat"],
            app.on(|app| {
                let site = app.with_state(|state| state.account().site_url);
                if let Some(url) = site.as_deref().and_then(cloud_settings_url) {
                    app.open_url(&url);
                }
            }),
        );
        settings.set_halign(gtk::Align::Start);
        settings.set_visible(false);

        let form_actions = hbox(8, &[]);
        form_actions.set_halign(gtk::Align::End);
        let cancel_window = window.downgrade();
        form_actions.append(&button("Cancel", &[], move || {
            if let Some(window) = cancel_window.upgrade() {
                window.close();
            }
        }));
        let start = button("Start", &["primary"], app.on(App::start_capy_thread));
        widgets::name(&start, "Start Capy thread");
        start.set_sensitive(false);
        form_actions.append(&start);
        form.append(&form_actions);
        root.append(&form);

        let progress = hbox(10, &[]);
        let spinner = gtk::Spinner::new();
        spinner.set_spinning(true);
        progress.append(&spinner);
        let status = text("", &["settings-row-title"]).wrapped();
        progress.append(&status);
        progress.set_visible(false);
        root.append(&progress);

        let thread = text("", &[]).wrapped().copyable();
        widgets::name(&thread, "Capy thread id");
        thread.set_visible(false);
        root.append(&thread);

        let agent_row = hbox(8, &[]);
        agent_row.append(&text("Agent", &["secondary"]));
        let agent_value = text("", &[]).copyable();
        widgets::name(&agent_value, "Capy relay agent");
        agent_row.append(&agent_value);
        agent_row.set_visible(false);
        root.append(&agent_row);

        // Feedback sits outside the form so status failures remain visible
        // while the form is hidden behind the waiting state.
        root.append(&error);
        root.append(&settings);
        let retry_status = button("Check again", &[], app.on(App::retry_capy_thread_status));
        retry_status.set_halign(gtk::Align::Start);
        retry_status.set_visible(false);
        root.append(&retry_status);

        let result_actions = hbox(8, &[]);
        result_actions.set_halign(gtk::Align::End);
        result_actions.append(&button(
            "Start another",
            &[],
            app.on(App::start_another_capy_thread),
        ));
        result_actions.append(&button(
            "Message",
            &["primary"],
            app.on(App::message_capy_thread),
        ));
        result_actions.set_visible(false);
        root.append(&result_actions);

        window.set_child(Some(&root));
        let dialog = Rc::new(Self {
            window,
            form,
            project,
            project_ids: RefCell::default(),
            task,
            model,
            author,
            start,
            spinner,
            status,
            thread,
            agent: RefCell::default(),
            agent_row,
            agent_value,
            result_actions,
            error,
            settings,
            retry_status,
            operation: RefCell::new(operation),
            polls: Cell::new(0),
        });
        dialog.restore();
        dialog
    }

    fn restore(&self) {
        let Some(operation) = self.operation.borrow().clone() else {
            return;
        };
        self.task.buffer().set_text(&operation.task);
        self.model
            .set_text(operation.model.as_deref().unwrap_or(""));
        self.author
            .set_selected(match operation.pull_request_author.as_deref() {
                Some("user") => 1,
                Some("capy") => 2,
                _ => 0,
            });
        self.start.set_label("Retry");
        if let Some(thread_id) = operation.thread_id {
            self.show_waiting(&thread_id);
        }
    }

    fn set_projects(&self, projects: Vec<CapyProject>) {
        let selected = self
            .operation
            .borrow()
            .as_ref()
            .map(|operation| operation.project_id.clone());
        let names: Vec<&str> = projects
            .iter()
            .map(|project| project.name.as_str())
            .collect();
        let list = gtk::StringList::new(&names);
        self.project.set_model(Some(&list));
        *self.project_ids.borrow_mut() =
            projects.iter().map(|project| project.id.clone()).collect();
        let index = selected
            .and_then(|selected| projects.iter().position(|project| project.id == selected))
            .unwrap_or(0);
        self.project.set_selected(index as u32);
        self.project.set_sensitive(!projects.is_empty());
        self.start.set_sensitive(!projects.is_empty());
    }

    fn project_id(&self) -> Option<String> {
        self.project_ids
            .borrow()
            .get(self.project.selected() as usize)
            .cloned()
    }

    fn task(&self) -> String {
        let buffer = self.task.buffer();
        buffer
            .text(&buffer.start_iter(), &buffer.end_iter(), true)
            .trim()
            .to_owned()
    }

    fn model(&self) -> Option<String> {
        let value = self.model.text().trim().to_owned();
        (!value.is_empty()).then_some(value)
    }

    fn author(&self) -> Option<CapyPullRequestAuthor> {
        match self.author.selected() {
            1 => Some(CapyPullRequestAuthor::User),
            2 => Some(CapyPullRequestAuthor::Capy),
            _ => None,
        }
    }

    fn show_starting(&self) {
        self.clear_error();
        self.form.set_sensitive(false);
        self.form.set_visible(false);
        self.status.set_text(CAPY_STARTING);
        if let Some(widget) = self.status.parent() {
            widget.set_visible(true);
        }
        self.spinner.set_visible(true);
    }

    fn show_waiting(&self, thread_id: &str) {
        self.form.set_visible(false);
        self.status.set_text(CAPY_WAITING);
        if let Some(widget) = self.status.parent() {
            widget.set_visible(true);
        }
        self.spinner.set_visible(true);
        self.thread.set_text(&format!("Thread  {thread_id}"));
        self.thread.set_visible(true);
        self.agent_row.set_visible(false);
        self.result_actions.set_visible(false);
    }

    fn show_result(&self, result: &CapyThreadSpawn) {
        self.clear_error();
        if result.binding.state != CapyBindingState::Bound || result.binding.agent.is_none() {
            self.show_waiting(&result.thread_id);
            return;
        }
        let agent = result.binding.agent.clone().unwrap_or_default();
        let shown = if agent.starts_with('@') {
            agent.clone()
        } else {
            format!("@{agent}")
        };
        self.form.set_visible(false);
        self.status.set_text("Running on the relay");
        if let Some(widget) = self.status.parent() {
            widget.set_visible(true);
        }
        self.spinner.set_visible(false);
        self.thread
            .set_text(&format!("Thread  {}", result.thread_id));
        self.thread.set_visible(true);
        *self.agent.borrow_mut() = Some(shown.clone());
        self.agent_value.set_text(&shown);
        self.agent_row.set_visible(true);
        self.result_actions.set_visible(true);
    }

    fn show_error(&self, message: &str) {
        self.error.set_text(message);
        self.error.set_visible(true);
        self.settings
            .set_visible(message.to_lowercase().contains("capy is not connected"));
        self.form.set_sensitive(true);
        let has_thread = self
            .operation
            .borrow()
            .as_ref()
            .is_some_and(|operation| operation.thread_id.is_some());
        self.retry_status.set_visible(has_thread);
        self.spinner.set_visible(!has_thread);
        if !has_thread {
            self.form.set_visible(true);
            if let Some(widget) = self.status.parent() {
                widget.set_visible(false);
            }
        }
    }

    fn show_project_error(&self, message: &str) {
        let has_thread = self
            .operation
            .borrow()
            .as_ref()
            .is_some_and(|operation| operation.thread_id.is_some());
        if !has_thread {
            self.show_error(message);
        }
    }

    fn clear_error(&self) {
        self.error.set_visible(false);
        self.settings.set_visible(false);
        self.retry_status.set_visible(false);
    }

    fn reset(&self) {
        *self.operation.borrow_mut() = None;
        *self.agent.borrow_mut() = None;
        self.polls.set(0);
        self.task.buffer().set_text("");
        self.model.set_text("");
        self.author.set_selected(0);
        self.start.set_label("Start");
        self.form.set_sensitive(true);
        self.form.set_visible(true);
        if let Some(widget) = self.status.parent() {
            widget.set_visible(false);
        }
        self.thread.set_visible(false);
        self.agent_row.set_visible(false);
        self.result_actions.set_visible(false);
        self.clear_error();
        self.task.grab_focus();
    }
}

fn field(label: &str, control: &impl IsA<gtk::Widget>) -> gtk::Box {
    let field = vbox(6, &[]);
    field.append(&text(label, &["caption", "secondary"]));
    field.append(control);
    field
}
