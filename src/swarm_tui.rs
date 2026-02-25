use std::collections::BTreeMap;
use std::io::{self, Write};

use crossterm::{
    cursor, event, execute, queue,
    style::{self, Stylize},
    terminal,
};
use tokio::sync::mpsc;

/// Commands sent from the TUI input loop to the swarm event loop.
pub enum TuiCommand {
    SendMessage { to: String, text: String },
    Quit,
}

/// Updates sent from the swarm event loop to the TUI renderer.
pub enum TuiUpdate {
    WorkerActivity {
        name: String,
        activity: String,
    },
    WorkerCompleted {
        name: String,
    },
    Tick {
        elapsed_secs: u64,
        pending_count: usize,
        total_count: usize,
    },
    /// A log line that would normally go to eprintln — displayed briefly
    /// in the status area instead of writing raw to stderr.
    Log {
        message: String,
    },
}

/// RAII guard that restores the terminal on drop.
struct RawModeGuard;

impl RawModeGuard {
    fn enable() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        // Move to a fresh line so subsequent output isn't mangled.
        let _ = execute!(io::stderr(), cursor::Show, style::ResetColor);
        eprintln!();
    }
}

/// State for the mini TUI that renders to stderr.
pub struct SwarmTui {
    input_buf: String,
    workers: BTreeMap<String, WorkerState>,
    pattern: String,
    total_count: usize,
    elapsed_secs: u64,
    last_render_lines: usize,
    status_message: Option<String>,
    term_width: u16,
}

struct WorkerState {
    activity: String,
    completed: bool,
}

impl SwarmTui {
    pub fn new(pattern: &str, total_count: usize) -> Self {
        let term_width = terminal::size().map(|(w, _)| w).unwrap_or(80);
        Self {
            input_buf: String::new(),
            workers: BTreeMap::new(),
            pattern: pattern.to_string(),
            total_count,
            elapsed_secs: 0,
            last_render_lines: 0,
            status_message: None,
            term_width,
        }
    }

    fn apply_update(&mut self, update: TuiUpdate) {
        match update {
            TuiUpdate::WorkerActivity { name, activity } => {
                let short = short_name(&name);
                let entry = self
                    .workers
                    .entry(short.to_string())
                    .or_insert(WorkerState {
                        activity: String::new(),
                        completed: false,
                    });
                if !entry.completed {
                    entry.activity = truncate(&activity, 60);
                }
            }
            TuiUpdate::WorkerCompleted { name } => {
                let short = short_name(&name);
                let entry = self
                    .workers
                    .entry(short.to_string())
                    .or_insert(WorkerState {
                        activity: String::new(),
                        completed: false,
                    });
                entry.completed = true;
                entry.activity = "completed".to_string();
            }
            TuiUpdate::Tick {
                elapsed_secs,
                pending_count,
                total_count,
            } => {
                self.elapsed_secs = elapsed_secs;
                self.total_count = total_count;
                let _ = pending_count; // derived from worker states
            }
            TuiUpdate::Log { message } => {
                self.status_message = Some(message);
            }
        }
    }

    fn render(&mut self, stderr: &mut io::Stderr) -> io::Result<()> {
        // Refresh terminal width on each render (handles resize).
        self.term_width = terminal::size().map(|(w, _)| w).unwrap_or(80);
        let w = self.term_width as usize;

        // Move cursor up to clear previous render.
        if self.last_render_lines > 0 {
            queue!(
                stderr,
                cursor::MoveUp(self.last_render_lines as u16),
                terminal::Clear(terminal::ClearType::FromCursorDown)
            )?;
        }

        let mut phys_lines: usize = 0;

        // Header line.
        let running = self.workers.values().filter(|w| !w.completed).count();
        let completed = self.workers.values().filter(|w| w.completed).count();
        let header = format!(
            "[swarm] {}s | {} | {}/{} running, {} done",
            self.elapsed_secs, self.pattern, running, self.total_count, completed,
        );
        let header = clamp(&header, w);
        queue!(stderr, style::Print(&header), style::Print("\r\n"))?;
        phys_lines += count_phys_lines(&header, w);

        // Worker lines.
        for (name, state) in &self.workers {
            let line = if state.completed {
                format!("  {}: completed", name)
            } else if state.activity.is_empty() {
                format!("  {}: (starting...)", name)
            } else {
                format!("  {}: {}", name, state.activity)
            };
            let line = clamp(&line, w);
            if state.completed {
                // Print with green color for the "completed" part.
                let prefix = format!("  {}: ", name);
                let prefix = clamp(&prefix, w);
                queue!(
                    stderr,
                    style::Print(&prefix),
                    style::PrintStyledContent("completed".green()),
                    style::Print("\r\n"),
                )?;
            } else {
                queue!(stderr, style::Print(&line), style::Print("\r\n"))?;
            }
            phys_lines += count_phys_lines(&line, w);
        }

        // Status message (briefly shown after sending or from log).
        if let Some(msg) = &self.status_message {
            let line = format!("  {}", msg);
            let line = clamp(&line, w);
            queue!(
                stderr,
                style::PrintStyledContent(line.clone().dark_yellow()),
                style::Print("\r\n"),
            )?;
            phys_lines += count_phys_lines(&line, w);
        }

        // Input prompt — clamp the visible portion but keep the buffer intact.
        let prompt = format!("> {}", self.input_buf);
        let prompt = clamp(&prompt, w);
        queue!(stderr, style::Print(&prompt))?;
        phys_lines += count_phys_lines(&prompt, w);

        stderr.flush()?;
        self.last_render_lines = phys_lines;
        Ok(())
    }
}

/// Clamp a string to fit within `max_cols` columns to prevent terminal wrapping.
fn clamp(s: &str, max_cols: usize) -> String {
    if max_cols == 0 {
        return String::new();
    }
    if s.len() <= max_cols {
        return s.to_string();
    }
    // Find a safe char boundary.
    let boundary = s
        .char_indices()
        .take_while(|(i, _)| *i < max_cols.saturating_sub(1))
        .last()
        .map_or(0, |(i, c)| i + c.len_utf8());
    s[..boundary].to_string()
}

/// Count how many physical terminal lines a string occupies (at least 1).
fn count_phys_lines(s: &str, term_width: usize) -> usize {
    if term_width == 0 || s.is_empty() {
        return 1;
    }
    let len = s.len();
    // Ceiling division, but at least 1.
    ((len + term_width - 1) / term_width).max(1)
}

/// Resolve a user-typed short name (e.g. "team-1") to a full worker name
/// by searching the provided list.
pub fn resolve_worker_name<'a>(short: &str, worker_names: &'a [String]) -> Option<&'a str> {
    // Exact match first.
    if let Some(found) = worker_names.iter().find(|n| n.as_str() == short) {
        return Some(found.as_str());
    }
    // Try matching against short_name().
    if let Some(found) = worker_names.iter().find(|n| short_name(n) == short) {
        return Some(found.as_str());
    }
    // Partial suffix match: "team-1" matches "swarm-team-1-12345-67890".
    if let Some(found) = worker_names.iter().find(|n| short_name(n).ends_with(short)) {
        return Some(found.as_str());
    }
    None
}

/// Parse user input like "@team-1 check your progress" into a TuiCommand.
fn parse_input(input: &str, worker_names: &[String]) -> Option<(TuiCommand, Option<String>)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.starts_with('@') {
        return Some((
            TuiCommand::SendMessage {
                to: String::new(),
                text: String::new(),
            },
            Some("Usage: @worker-name message  |  @all message".to_string()),
        ));
    }

    let rest = &trimmed[1..];
    let (target, message) = match rest.find(char::is_whitespace) {
        Some(pos) => (&rest[..pos], rest[pos..].trim()),
        None => {
            return Some((
                TuiCommand::SendMessage {
                    to: String::new(),
                    text: String::new(),
                },
                Some("Usage: @worker-name your message here".to_string()),
            ));
        }
    };

    if message.is_empty() {
        return Some((
            TuiCommand::SendMessage {
                to: String::new(),
                text: String::new(),
            },
            Some("Message cannot be empty".to_string()),
        ));
    }

    if target == "all" {
        // Send to all pending workers — caller handles expanding this.
        return Some((
            TuiCommand::SendMessage {
                to: "@all".to_string(),
                text: message.to_string(),
            },
            Some(format!("Sent to all workers: {}", truncate(message, 40))),
        ));
    }

    match resolve_worker_name(target, worker_names) {
        Some(full_name) => Some((
            TuiCommand::SendMessage {
                to: full_name.to_string(),
                text: message.to_string(),
            },
            Some(format!(
                "Sent to {}: {}",
                short_name(full_name),
                truncate(message, 40)
            )),
        )),
        None => Some((
            TuiCommand::SendMessage {
                to: String::new(),
                text: String::new(),
            },
            Some(format!(
                "Unknown worker '{}'. Use @all or a team name.",
                target
            )),
        )),
    }
}

/// Run the TUI input/render loop. Returns when Ctrl-C is pressed or the
/// update channel closes.
pub async fn run_tui(
    pattern: String,
    total_count: usize,
    worker_names: Vec<String>,
    cmd_tx: mpsc::Sender<TuiCommand>,
    mut update_rx: mpsc::Receiver<TuiUpdate>,
) {
    let _guard = match RawModeGuard::enable() {
        Ok(g) => g,
        Err(err) => {
            eprintln!("[swarm-tui] failed to enable raw mode: {}", err);
            return;
        }
    };

    let mut tui = SwarmTui::new(&pattern, total_count);
    let mut stderr = io::stderr();

    // Hide the cursor during TUI operation.
    let _ = execute!(stderr, cursor::Hide);

    // Initial render.
    let _ = tui.render(&mut stderr);

    let mut reader = event::EventStream::new();
    use futures_lite::StreamExt;

    loop {
        tokio::select! {
            maybe_event = reader.next() => {
                let Some(Ok(evt)) = maybe_event else {
                    break;
                };
                match evt {
                    event::Event::Key(key) => {
                        match key.code {
                            event::KeyCode::Char('c')
                                if key.modifiers.contains(event::KeyModifiers::CONTROL) =>
                            {
                                let _ = cmd_tx.send(TuiCommand::Quit).await;
                                break;
                            }
                            event::KeyCode::Enter => {
                                let input = std::mem::take(&mut tui.input_buf);
                                if let Some((cmd, status)) = parse_input(&input, &worker_names) {
                                    tui.status_message = status;
                                    // Only send valid commands (non-empty `to`).
                                    match &cmd {
                                        TuiCommand::SendMessage { to, .. } if !to.is_empty() => {
                                            let _ = cmd_tx.send(cmd).await;
                                        }
                                        _ => {}
                                    }
                                }
                                let _ = tui.render(&mut stderr);
                            }
                            event::KeyCode::Backspace => {
                                tui.input_buf.pop();
                                let _ = tui.render(&mut stderr);
                            }
                            event::KeyCode::Char(c) => {
                                tui.input_buf.push(c);
                                let _ = tui.render(&mut stderr);
                            }
                            _ => {}
                        }
                    }
                    event::Event::Resize(_, _) => {
                        let _ = tui.render(&mut stderr);
                    }
                    _ => {}
                }
            }
            maybe_update = update_rx.recv() => {
                let Some(update) = maybe_update else {
                    break;
                };
                // Clear transient status on non-Log updates.
                if !matches!(&update, TuiUpdate::Log { .. }) {
                    tui.status_message = None;
                }
                tui.apply_update(update);
                let _ = tui.render(&mut stderr);
            }
        }
    }
}

/// Extract a short display name: "swarm-team-1-41675-1772026298" → "swarm-team-1".
fn short_name(full: &str) -> &str {
    full.strip_suffix(full.rfind('-').map_or("", |i| &full[i..]))
        .and_then(|s| s.strip_suffix(s.rfind('-').map_or("", |i| &s[i..])))
        .unwrap_or(full)
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        let boundary = text
            .char_indices()
            .take_while(|(i, _)| *i < max.saturating_sub(3))
            .last()
            .map_or(0, |(i, c)| i + c.len_utf8());
        format!("{}...", &text[..boundary])
    }
}

/// Check if stderr is a TTY (for deciding whether to enable interactive mode).
pub fn stderr_is_tty() -> bool {
    #[cfg(unix)]
    {
        use std::os::fd::AsFd;

        nix::unistd::isatty(std::io::stderr().as_fd()).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_name_strips_pid_and_timestamp() {
        assert_eq!(short_name("swarm-team-1-41675-1772026298"), "swarm-team-1");
        assert_eq!(short_name("swarm-stage-2-123-456"), "swarm-stage-2");
    }

    #[test]
    fn short_name_preserves_no_dash_input() {
        // No dashes means nothing to strip.
        assert_eq!(short_name("simple"), "simple");
    }

    #[test]
    fn resolve_finds_by_short_name() {
        let names = vec![
            "swarm-team-1-123-456".to_string(),
            "swarm-team-2-123-456".to_string(),
        ];
        assert_eq!(
            resolve_worker_name("swarm-team-1", &names),
            Some("swarm-team-1-123-456")
        );
    }

    #[test]
    fn resolve_finds_by_suffix() {
        let names = vec![
            "swarm-team-1-123-456".to_string(),
            "swarm-team-2-123-456".to_string(),
        ];
        assert_eq!(
            resolve_worker_name("team-1", &names),
            Some("swarm-team-1-123-456")
        );
    }

    #[test]
    fn resolve_returns_none_for_unknown() {
        let names = vec!["swarm-team-1-123-456".to_string()];
        assert_eq!(resolve_worker_name("team-99", &names), None);
    }

    #[test]
    fn truncate_short_strings_unchanged() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_long_strings_with_ellipsis() {
        let result = truncate("this is a long string", 10);
        assert!(result.ends_with("..."));
        assert!(result.len() <= 13); // 10 chars + "..."
    }

    #[test]
    fn clamp_short_string_unchanged() {
        assert_eq!(clamp("hello", 80), "hello");
    }

    #[test]
    fn clamp_long_string_truncated() {
        let result = clamp("this is a very long string that exceeds width", 20);
        assert!(result.len() <= 20);
    }

    #[test]
    fn count_phys_lines_single() {
        assert_eq!(count_phys_lines("short", 80), 1);
    }

    #[test]
    fn count_phys_lines_wrapping() {
        // 100 chars in an 80-col terminal = 2 physical lines.
        let long = "a".repeat(100);
        assert_eq!(count_phys_lines(&long, 80), 2);
    }
}
