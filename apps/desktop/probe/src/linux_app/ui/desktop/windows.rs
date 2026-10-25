//! The Windows desktop: links through `ShellExecuteW`, link handlers from
//! the registry, resumes in Windows Terminal (else a console), and toast
//! notifications.

use crate::linux_app::install::windows::{self as tree, registry};
use crate::relay::contract::connection::CoreNotification;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use tokio::sync::mpsc;

/// `CREATE_NEW_CONSOLE`: the resumed CLI gets a console window of its own.
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
/// Files opened in their own program; anything else is shown in Explorer.
const DOCUMENTS: [&str; 6] = ["log", "txt", "json", "jsonl", "md", "csv"];
/// Schemes handed to Windows. Others (`ms-msdt:` and the like run programs)
/// are not opened from the app.
const SCHEMES: [&str; 5] = ["http", "https", "mailto", "codex", "agentrelay"];

/// A clicked notification: its link, else `None` for the window.
pub type Activations = mpsc::UnboundedSender<Option<String>>;

/// Delivers notification clicks, which Windows reports on a thread of its
/// own, to `application`'s `open-link` and `show` actions on the main
/// thread.
pub fn activations(application: &gtk::Application) -> Activations {
    let (sender, mut clicked) = mpsc::unbounded_channel::<Option<String>>();
    let application = application.downgrade();
    glib::spawn_future_local(async move {
        while let Some(link) = clicked.recv().await {
            let Some(application) = application.upgrade() else {
                return;
            };
            match link {
                Some(link) => application.activate_action("open-link", Some(&link.to_variant())),
                None => application.activate_action("show", None),
            }
        }
    });
    sender
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// `ShellExecuteW(open)` on its own thread: the shell may take a while, and
/// the browser outlives the call.
fn shell_open(file: String, parameters: Option<String>) {
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let (verb, file) = (wide("open"), wide(&file));
        let parameters = parameters.as_deref().map(wide);
        // SAFETY: NUL-terminated UTF-16 strings that outlive the call.
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                parameters
                    .as_ref()
                    .map_or(std::ptr::null(), |parameters| parameters.as_ptr()),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    });
}

/// What opening `uri` does: a link for its handler, a document for its
/// program, a folder in Explorer, or any other file selected in Explorer.
#[derive(Debug, PartialEq, Eq)]
pub enum Opening {
    Link(String),
    Path(PathBuf),
    Select(PathBuf),
    Refused,
}

pub fn opening(uri: &str) -> Opening {
    let Ok(url) = url::Url::parse(uri) else {
        return Opening::Refused;
    };
    if url.scheme() == "file" {
        let Ok(path) = url.to_file_path() else {
            return Opening::Refused;
        };
        let document = path.extension().is_some_and(|extension| {
            DOCUMENTS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        });
        return if path.is_dir() || (document && path.is_file()) {
            Opening::Path(path)
        } else {
            Opening::Select(path)
        };
    }
    if SCHEMES.contains(&url.scheme()) {
        Opening::Link(url.to_string())
    } else {
        Opening::Refused
    }
}

pub fn open_uri(uri: &str) {
    match opening(uri) {
        Opening::Link(link) => shell_open(link, None),
        Opening::Path(path) => shell_open(path.display().to_string(), None),
        Opening::Select(path) => shell_open(
            "explorer.exe".into(),
            Some(format!(
                "/select,{}",
                tree::quote_argument(&path.display().to_string())
            )),
        ),
        Opening::Refused => {}
    }
}

/// A scheme Windows has a handler for: `HKEY_CLASSES_ROOT\<scheme>` (this
/// person's and the machine's classes) marked `URL Protocol`.
pub fn has_uri_handler(scheme: &str) -> bool {
    !scheme.is_empty()
        && !scheme.contains(['\\', '/'])
        && registry::read_string(registry::Root::ClassesRoot, scheme, "URL Protocol").is_some()
}

/// The words of a POSIX shell line, `&&` as a word of its own; `None` for
/// anything more than words in quotes (pipes, expansions, unclosed quotes).
pub fn posix_words(line: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if let Some(word) = word.take() {
                    words.push(word);
                }
            }
            '\'' => {
                let word = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => word.push(c),
                    }
                }
            }
            '"' => {
                let word = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' if matches!(chars.peek(), Some('"' | '\\' | '$' | '`')) => {
                            word.push(chars.next()?)
                        }
                        '$' | '`' => return None,
                        c => word.push(c),
                    }
                }
            }
            '\\' => word.get_or_insert_with(String::new).push(chars.next()?),
            '&' if word.is_none() && chars.peek() == Some(&'&') => {
                chars.next();
                words.push("&&".into());
            }
            '&' | '|' | ';' | '<' | '>' | '$' | '`' | '(' | ')' | '*' | '?' => return None,
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    Some(words)
}

/// A resume line (`cd -- '<folder>' && claude --resume '<id>'`) as a folder
/// and the program's words. Words a console would read as its own syntax
/// are refused.
pub fn resume(command: &str) -> Option<(Option<PathBuf>, Vec<String>)> {
    let words = posix_words(command)?;
    let (folder, program) = match words.as_slice() {
        [cd, dashes, folder, and, rest @ ..] if cd == "cd" && dashes == "--" && and == "&&" => {
            (Some(PathBuf::from(folder)), rest.to_vec())
        }
        [cd, folder, and, rest @ ..] if cd == "cd" && and == "&&" => {
            (Some(PathBuf::from(folder)), rest.to_vec())
        }
        _ => (None, words),
    };
    let console_syntax = |word: &String| {
        word.contains([
            '&', '|', '<', '>', '^', '%', '!', '"', '(', ')', ';', '\n', '\r',
        ])
    };
    if program.is_empty() || program.iter().any(console_syntax) || program.iter().any(|w| w == "&&")
    {
        return None;
    }
    Some((folder, program))
}

pub fn open_terminal(command: &str) -> Result<(), String> {
    let Some((folder, program)) = resume(command) else {
        return Err(
            "This resume command cannot run in a Windows terminal. Copy it and run it in your terminal."
                .into(),
        );
    };
    let folder = folder.filter(|folder| folder.is_dir());
    let mut terminal = std::process::Command::new("wt.exe");
    if let Some(folder) = &folder {
        terminal.arg("-d").arg(folder);
    }
    terminal.args(["cmd.exe", "/K"]).args(&program);
    let started = match terminal.stdin(std::process::Stdio::null()).spawn() {
        Ok(child) => Ok(child),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut console = std::process::Command::new("cmd.exe");
            console
                .arg("/K")
                .args(&program)
                .creation_flags(CREATE_NEW_CONSOLE);
            if let Some(folder) = &folder {
                console.current_dir(folder);
            }
            console.spawn()
        }
        Err(error) => Err(error),
    };
    match started {
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// A toast under the app's registered identity; clicking it opens its link,
/// else the window, while the app runs. (A toast clicked from the Action
/// Center after the app quit does nothing: that needs a COM activator, which
/// only a packaged or COM-registered app has.)
pub fn notify(activations: &Activations, notification: &CoreNotification) {
    let _ = tree::register_app_user_model();
    let title = if notification.title.is_empty() {
        "Agent Relay"
    } else {
        &notification.title
    };
    let link = notification.link.clone().filter(|link| !link.is_empty());
    let clicked = activations.clone();
    let mut toast = tauri_winrt_notification::Toast::new(tree::APP_USER_MODEL_ID).title(title);
    if !notification.body.is_empty() {
        toast = toast.text1(&notification.body);
    }
    let _ = toast
        .on_activated(move |_| {
            let _ = clicked.send(link.clone());
            Ok(())
        })
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn resume_lines_become_a_folder_and_a_program() {
        assert_eq!(
            resume(r#"cd -- 'C:\Users\o'"'"'neil\repo' && claude --resume 'abc-123'"#),
            Some((
                Some(PathBuf::from(r"C:\Users\o'neil\repo")),
                vec!["claude".into(), "--resume".into(), "abc-123".into()]
            ))
        );
        assert_eq!(
            resume("codex resume 'id'"),
            Some((None, vec!["codex".into(), "resume".into(), "id".into()]))
        );
        assert_eq!(resume("claude --resume 'a&calc'"), None);
        assert_eq!(resume("claude --resume $(calc)"), None);
        assert_eq!(resume("cd -- 'C:\\x' && claude 'unclosed"), None);
        assert_eq!(resume("cd -- 'C:\\x' && claude a && calc"), None);
        assert_eq!(resume("claude | calc"), None);
    }

    #[test]
    fn only_links_documents_and_folders_open() {
        assert_eq!(
            opening("https://agentrelay.com/x"),
            Opening::Link("https://agentrelay.com/x".into())
        );
        assert_eq!(
            opening("codex://threads/abc"),
            Opening::Link("codex://threads/abc".into())
        );
        assert_eq!(opening("ms-msdt:/id x"), Opening::Refused);
        assert_eq!(opening("not a link"), Opening::Refused);
        let folder = tempfile::tempdir().unwrap();
        let uri = |path: &Path| url::Url::from_file_path(path).unwrap().to_string();
        assert_eq!(
            opening(&uri(folder.path())),
            Opening::Path(folder.path().to_path_buf())
        );
        let log = folder.path().join("collector.log");
        std::fs::write(&log, "x").unwrap();
        assert_eq!(opening(&uri(&log)), Opening::Path(log));
        let program = folder.path().join("setup.exe");
        std::fs::write(&program, "MZ").unwrap();
        assert_eq!(opening(&uri(&program)), Opening::Select(program));
    }
}
