//! Cloud calls and state transitions for the Capy spawn window.

use super::CapySpawnDialog;
use crate::linux_app::models::CapySpawnOperation;
use crate::linux_app::ui::app::App;
use crate::relay::contract::capy::{
    CapyBindingState, CapyProject, CapyProjectsParams, CapyPullRequestAuthor,
    CapyThreadSpawnGetParams, CapyThreadSpawnParams,
};
use crate::relay::contract::method;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::{rc::Rc, time::Duration};

impl App {
    pub fn show_capy_spawn(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        if let Some(dialog) = shell.pages.capy_spawn.borrow().as_ref() {
            dialog.window.present();
            return;
        }
        let workspace_id = self.with_state(|state| state.account().workspace_id);
        let operation = workspace_id
            .as_deref()
            .and_then(|workspace| self.prefs().capy_spawn_operation(workspace));
        let dialog = CapySpawnDialog::build(self, operation.clone());
        let weak = self.downgrade();
        dialog.window.connect_close_request(move |_| {
            if let Some(shell) = weak.upgrade().and_then(|app| app.shell()) {
                shell.pages.capy_spawn.borrow_mut().take();
            }
            glib::Propagation::Proceed
        });
        *shell.pages.capy_spawn.borrow_mut() = Some(dialog.clone());
        dialog.window.present();
        self.load_capy_projects(None, Vec::new());
        if let Some(thread_id) = operation.and_then(|operation| operation.thread_id) {
            self.read_capy_thread(thread_id);
        }
    }

    fn capy_dialog(&self) -> Option<Rc<CapySpawnDialog>> {
        self.shell()
            .and_then(|shell| shell.pages.capy_spawn.borrow().clone())
    }

    /// The window while it is open; exposed for native layout tests.
    pub fn capy_spawn_window(&self) -> Option<gtk::Window> {
        self.capy_dialog().map(|dialog| dialog.window.clone())
    }

    fn load_capy_projects(&self, cursor: Option<String>, accumulated: Vec<CapyProject>) {
        self.view_call::<method::CapyProjectsList>(
            CapyProjectsParams { cursor },
            move |app, result| {
                let Some(dialog) = app.capy_dialog() else {
                    return;
                };
                match result {
                    Err(error) => dialog.show_project_error(&error.message),
                    Ok(page) => {
                        let mut projects = accumulated;
                        projects.extend(page.projects);
                        if page.truncated {
                            if let Some(cursor) = page.next_cursor {
                                app.load_capy_projects(Some(cursor), projects);
                                return;
                            }
                        }
                        dialog.set_projects(projects);
                    }
                }
            },
        );
    }

    pub fn start_capy_thread(&self) {
        let Some(dialog) = self.capy_dialog() else {
            return;
        };
        let Some(workspace_id) = self.with_state(|state| state.account().workspace_id) else {
            dialog.show_error("Sign in to Agent Relay Cloud to start a Capy thread.");
            return;
        };
        let Some(project_id) = dialog.project_id() else {
            dialog.show_error("Choose a Capy project first.");
            return;
        };
        let task = dialog.task();
        if task.is_empty() {
            dialog.show_error("Type a task first.");
            return;
        }
        let model = dialog.model();
        let author = dialog.author();
        let candidate = CapySpawnOperation::new(
            workspace_id.clone(),
            format!("relay-desktop-{}", crate::relay::store::random_uuid()),
            project_id,
            task,
            model,
            author.as_ref().map(|author| match author {
                CapyPullRequestAuthor::User => "user".to_owned(),
                CapyPullRequestAuthor::Capy => "capy".to_owned(),
            }),
            None,
        );
        let operation = self
            .prefs()
            .capy_spawn_operation(&workspace_id)
            .filter(|saved| saved.matches(&candidate))
            .unwrap_or(candidate);
        if let Err(error) = self
            .inner
            .prefs
            .borrow_mut()
            .set_capy_spawn_operation(&operation)
        {
            dialog.show_error(&format!("Couldn't save this Capy request: {error}"));
            return;
        }
        *dialog.operation.borrow_mut() = Some(operation.clone());
        dialog.show_starting();
        let params = CapyThreadSpawnParams {
            client_request_id: operation.client_request_id.clone(),
            project_id: operation.project_id.clone(),
            task: operation.task.clone(),
            model: operation.model.clone(),
            pull_request_author: author,
            report_to: operation.report_to.clone(),
        };
        self.view_call::<method::CapyThreadsSpawn>(params, move |app, result| {
            let Some(dialog) = app.capy_dialog() else {
                return;
            };
            match result {
                Err(error) => dialog.show_error(&error.message),
                Ok(result) => {
                    let mut operation = operation;
                    operation.thread_id = Some(result.thread_id.clone());
                    if let Err(error) = app
                        .inner
                        .prefs
                        .borrow_mut()
                        .set_capy_spawn_operation(&operation)
                    {
                        dialog.show_error(&format!(
                            "Thread started, but its id could not be saved: {error}"
                        ));
                    }
                    *dialog.operation.borrow_mut() = Some(operation);
                    dialog.show_result(&result);
                    if result.binding.state != CapyBindingState::Bound {
                        app.poll_capy_thread(result.thread_id);
                    }
                }
            }
        });
    }

    fn read_capy_thread(&self, thread_id: String) {
        self.view_call::<method::CapyThreadsGet>(
            CapyThreadSpawnGetParams {
                thread_id: thread_id.clone(),
            },
            move |app, result| {
                let Some(dialog) = app.capy_dialog() else {
                    return;
                };
                match result {
                    Err(error) => dialog.show_error(&error.message),
                    Ok(result) => {
                        dialog.show_result(&result);
                        if result.binding.state != CapyBindingState::Bound {
                            app.poll_capy_thread(thread_id);
                        }
                    }
                }
            },
        );
    }

    fn poll_capy_thread(&self, thread_id: String) {
        let Some(dialog) = self.capy_dialog() else {
            return;
        };
        if dialog.polls.get() >= 60 {
            return;
        }
        dialog.polls.set(dialog.polls.get() + 1);
        let weak = self.downgrade();
        glib::timeout_add_local_once(Duration::from_secs(2), move || {
            if let Some(app) = weak.upgrade() {
                app.read_capy_thread(thread_id);
            }
        });
    }

    pub fn retry_capy_thread_status(&self) {
        let Some(dialog) = self.capy_dialog() else {
            return;
        };
        let thread_id = dialog
            .operation
            .borrow()
            .as_ref()
            .and_then(|operation| operation.thread_id.clone());
        if let Some(thread_id) = thread_id {
            dialog.polls.set(0);
            dialog.clear_error();
            dialog.spinner.set_visible(true);
            self.read_capy_thread(thread_id);
        }
    }

    pub fn start_another_capy_thread(&self) {
        let _ = self.inner.prefs.borrow_mut().clear_capy_spawn_operation();
        if let Some(dialog) = self.capy_dialog() {
            dialog.reset();
        }
    }

    pub fn message_capy_thread(&self) {
        let agent = self
            .capy_dialog()
            .and_then(|dialog| dialog.agent.borrow().clone());
        if let Some(agent) = agent {
            if let Some(dialog) = self.capy_dialog() {
                dialog.window.close();
            }
            self.show_message_composer(&agent);
        }
    }
}
