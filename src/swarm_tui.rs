use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Write};

use crossterm::{
    cursor, event, execute, queue,
    style::{self, Color, Stylize},
    terminal,
};
use tokio::sync::mpsc;

// ── Theme (inspired by relay's cyan/green/yellow palette) ───────────────

const CLR_BORDER: Color = Color::DarkGrey;
const CLR_BORDER_ACCENT: Color = Color::Cyan;
const CLR_HEADER: Color = Color::Cyan;
const CLR_ONLINE: Color = Color::Green;
const CLR_ACTIVE: Color = Color::Yellow;
const CLR_COMPLETED: Color = Color::Green;
const CLR_DIM: Color = Color::DarkGrey;
const CLR_ERROR: Color = Color::Red;
const CLR_INPUT_PROMPT: Color = Color::Cyan;

// Box-drawing characters.
const TL: &str = "┌";
const TR: &str = "┐";
const BL: &str = "└";
const BR: &str = "┘";
const H: &str = "─";
const V: &str = "│";
const LT: &str = "├";
const RT: &str = "┤";

// Status symbols.
const DOT_ONLINE: &str = "●";
const DOT_ACTIVE: &str = "●";
const CHECK: &str = "✓";

// ── Public types ────────────────────────────────────────────────────────

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
    Log {
        message: String,
    },
}

// ── Terminal guard ──────────────────────────────────────────────────────

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
        let _ = execute!(io::stderr(), cursor::Show, style::ResetColor);
        eprintln!();
    }
}

// ── TUI state ───────────────────────────────────────────────────────────

pub struct SwarmTui {
    input_buf: String,
    workers: BTreeMap<String, WorkerState>,
    pattern: String,
    total_count: usize,
    elapsed_secs: u64,
    last_render_lines: usize,
    /// Rolling log of recent events (shown in the activity pane).
    log_lines: VecDeque<LogEntry>,
    term_width: u16,
}

struct WorkerState {
    activity: String,
    completed: bool,
}

struct LogEntry {
    text: String,
    is_error: bool,
}

const MAX_LOG_LINES: usize = 6;

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
            log_lines: VecDeque::new(),
            term_width,
        }
    }

    fn push_log(&mut self, text: String, is_error: bool) {
        self.log_lines.push_back(LogEntry { text, is_error });
        while self.log_lines.len() > MAX_LOG_LINES {
            self.log_lines.pop_front();
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
                    entry.activity = activity;
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
                entry.activity = "done".to_string();
            }
            TuiUpdate::Tick {
                elapsed_secs,
                pending_count,
                total_count,
            } => {
                self.elapsed_secs = elapsed_secs;
                self.total_count = total_count;
                let _ = pending_count;
            }
            TuiUpdate::Log { message } => {
                let is_error = message.contains("ERROR") || message.contains("failed");
                self.push_log(message, is_error);
            }
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────

    fn render(&mut self, stderr: &mut io::Stderr) -> io::Result<()> {
        self.term_width = terminal::size().map(|(w, _)| w).unwrap_or(80);
        let w = self.term_width as usize;
        if w < 30 {
            return Ok(()); // too narrow
        }
        // Inner content width (between the │ borders).
        let inner = w.saturating_sub(2);

        // Erase previous frame.
        if self.last_render_lines > 0 {
            queue!(
                stderr,
                cursor::MoveUp(self.last_render_lines as u16),
                terminal::Clear(terminal::ClearType::FromCursorDown)
            )?;
        }

        let mut lines: usize = 0;

        // ── Header bar ──────────────────────────────────────────────────
        let running = self.workers.values().filter(|ws| !ws.completed).count();
        let done = self.workers.values().filter(|ws| ws.completed).count();

        let title = " Agent Relay ";
        let stats = format!(
            " {} {} {} {}/{} running {} done ",
            self.pattern,
            V,
            format_elapsed(self.elapsed_secs),
            running,
            self.total_count,
            done,
        );
        // Fill the rest with horizontal lines.
        let fill_len = w
            .saturating_sub(TL.len() + title.len() + stats.len() + TR.len())
            .saturating_sub(2); // 2 extra H chars for padding
        let fill: String = H.repeat(fill_len);

        queue!(
            stderr,
            style::PrintStyledContent(TL.with(CLR_BORDER)),
            style::PrintStyledContent(H.with(CLR_BORDER_ACCENT)),
            style::PrintStyledContent(title.bold().with(CLR_HEADER)),
            style::PrintStyledContent(H.with(CLR_BORDER_ACCENT)),
            style::Print(
                &fill
                    .chars()
                    .map(|_| H.chars().next().unwrap())
                    .collect::<String>()
            ),
        )?;
        // Right side stats.
        queue!(
            stderr,
            style::PrintStyledContent(stats.with(CLR_DIM)),
            style::PrintStyledContent(TR.with(CLR_BORDER)),
            style::Print("\r\n"),
        )?;
        lines += 1;

        // ── WORKERS section header ──────────────────────────────────────
        let section = " WORKERS";
        let pad = " ".repeat(inner.saturating_sub(section.len()));
        queue!(
            stderr,
            style::PrintStyledContent(V.with(CLR_BORDER)),
            style::PrintStyledContent(section.bold().with(CLR_DIM)),
            style::Print(&pad),
            style::PrintStyledContent(V.with(CLR_BORDER)),
            style::Print("\r\n"),
        )?;
        lines += 1;

        // ── Worker rows ─────────────────────────────────────────────────
        for (name, state) in &self.workers {
            queue!(stderr, style::PrintStyledContent(V.with(CLR_BORDER)))?;

            if state.completed {
                // ✓ name   done
                let prefix = format!(" {} {} ", CHECK, name);
                let activity_max = inner.saturating_sub(prefix.len() + 1);
                let act = pad_or_truncate("done", activity_max);
                let act_len = act.len();
                queue!(
                    stderr,
                    style::Print(" "),
                    style::PrintStyledContent(CHECK.with(CLR_COMPLETED)),
                    style::Print(" "),
                    style::PrintStyledContent(name.clone().with(CLR_DIM)),
                    style::Print("   "),
                    style::PrintStyledContent(act.with(CLR_COMPLETED)),
                )?;
                let used = 1 + CHECK.len() + 1 + name.len() + 3 + act_len;
                let rem = inner.saturating_sub(used);
                queue!(stderr, style::Print(" ".repeat(rem)))?;
            } else {
                // ● name   activity...
                let dot = if state.activity.is_empty() {
                    DOT_ONLINE
                } else {
                    DOT_ACTIVE
                };
                let dot_color = if state.activity.is_empty() {
                    CLR_ONLINE
                } else {
                    CLR_ACTIVE
                };
                let activity_text = if state.activity.is_empty() {
                    "starting..."
                } else {
                    &state.activity
                };
                let prefix_len = 1 + dot.len() + 1 + name.len() + 3;
                let activity_max = inner.saturating_sub(prefix_len + 1);
                let act = pad_or_truncate(activity_text, activity_max);
                let act_len = act.len();

                queue!(
                    stderr,
                    style::Print(" "),
                    style::PrintStyledContent(dot.with(dot_color)),
                    style::Print(" "),
                    style::PrintStyledContent(name.clone().bold().white()),
                    style::Print("   "),
                    style::PrintStyledContent(act.with(CLR_DIM)),
                )?;
                let used = 1 + dot.len() + 1 + name.len() + 3 + act_len;
                let rem = inner.saturating_sub(used);
                queue!(stderr, style::Print(" ".repeat(rem)))?;
            }

            queue!(
                stderr,
                style::PrintStyledContent(V.with(CLR_BORDER)),
                style::Print("\r\n"),
            )?;
            lines += 1;
        }

        // ── Separator ───────────────────────────────────────────────────
        let sep: String = H.repeat(inner);
        queue!(
            stderr,
            style::PrintStyledContent(LT.with(CLR_BORDER)),
            style::PrintStyledContent(sep.clone().with(CLR_BORDER)),
            style::PrintStyledContent(RT.with(CLR_BORDER)),
            style::Print("\r\n"),
        )?;
        lines += 1;

        // ── Activity log ────────────────────────────────────────────────
        if self.log_lines.is_empty() {
            // Empty state.
            let msg = "waiting for activity...";
            let pad_left = (inner.saturating_sub(msg.len())) / 2;
            let pad_right = inner.saturating_sub(pad_left + msg.len());
            queue!(
                stderr,
                style::PrintStyledContent(V.with(CLR_BORDER)),
                style::Print(" ".repeat(pad_left)),
                style::PrintStyledContent(msg.with(CLR_DIM)),
                style::Print(" ".repeat(pad_right)),
                style::PrintStyledContent(V.with(CLR_BORDER)),
                style::Print("\r\n"),
            )?;
            lines += 1;
        } else {
            for entry in &self.log_lines {
                let color = if entry.is_error { CLR_ERROR } else { CLR_DIM };
                let text = pad_or_truncate(&format!(" {}", entry.text), inner);
                queue!(
                    stderr,
                    style::PrintStyledContent(V.with(CLR_BORDER)),
                    style::PrintStyledContent(text.with(color)),
                    style::PrintStyledContent(V.with(CLR_BORDER)),
                    style::Print("\r\n"),
                )?;
                lines += 1;
            }
        }

        // ── Separator ───────────────────────────────────────────────────
        queue!(
            stderr,
            style::PrintStyledContent(LT.with(CLR_BORDER)),
            style::PrintStyledContent(sep.clone().with(CLR_BORDER)),
            style::PrintStyledContent(RT.with(CLR_BORDER)),
            style::Print("\r\n"),
        )?;
        lines += 1;

        // ── Input bar ───────────────────────────────────────────────────
        let prompt_char = "> ";
        let input_max = inner.saturating_sub(prompt_char.len() + 1);
        let visible_input = if self.input_buf.len() > input_max {
            // Show the tail of the input.
            let start = self.input_buf.len() - input_max;
            &self.input_buf[start..]
        } else {
            &self.input_buf
        };
        let input_pad = inner.saturating_sub(prompt_char.len() + visible_input.len());
        queue!(
            stderr,
            style::PrintStyledContent(V.with(CLR_BORDER)),
            style::PrintStyledContent(prompt_char.with(CLR_INPUT_PROMPT)),
            style::Print(visible_input),
            style::Print(" ".repeat(input_pad)),
            style::PrintStyledContent(V.with(CLR_BORDER)),
            style::Print("\r\n"),
        )?;
        lines += 1;

        // ── Bottom bar (shortcuts) ──────────────────────────────────────
        let hints = format!(" @name msg {} @all msg {} Ctrl-C quit ", V, V);
        let bottom_fill = inner.saturating_sub(hints.len());
        queue!(
            stderr,
            style::PrintStyledContent(BL.with(CLR_BORDER)),
            style::PrintStyledContent(hints.with(CLR_DIM)),
            style::PrintStyledContent(H.repeat(bottom_fill).with(CLR_BORDER)),
            style::PrintStyledContent(BR.with(CLR_BORDER)),
            style::Print("\r\n"),
        )?;
        lines += 1;

        stderr.flush()?;
        self.last_render_lines = lines;
        Ok(())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Pad or truncate a string to exactly `max` characters.
fn pad_or_truncate(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let char_count = s.chars().count();
    if char_count <= max {
        let mut out = s.to_string();
        for _ in 0..(max - char_count) {
            out.push(' ');
        }
        out
    } else {
        let boundary: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", boundary)
    }
}

fn format_elapsed(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else {
        format!("{}m{}s", secs / 60, secs % 60)
    }
}

/// Resolve a user-typed short name (e.g. "team-1") to a full worker name.
pub fn resolve_worker_name<'a>(short: &str, worker_names: &'a [String]) -> Option<&'a str> {
    if let Some(found) = worker_names.iter().find(|n| n.as_str() == short) {
        return Some(found.as_str());
    }
    if let Some(found) = worker_names.iter().find(|n| short_name(n) == short) {
        return Some(found.as_str());
    }
    if let Some(found) = worker_names.iter().find(|n| short_name(n).ends_with(short)) {
        return Some(found.as_str());
    }
    None
}

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

// ── Main TUI loop ───────────────────────────────────────────────────────

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

    let _ = execute!(stderr, cursor::Hide);
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
                                    if let Some(msg) = status {
                                        tui.push_log(msg, false);
                                    }
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
                tui.apply_update(update);
                let _ = tui.render(&mut stderr);
            }
        }
    }
}

// ── Shared utilities ────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────────

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
        assert!(result.len() <= 13);
    }

    #[test]
    fn pad_or_truncate_pads_short() {
        let result = pad_or_truncate("hi", 5);
        assert_eq!(result, "hi   ");
        assert_eq!(result.len(), 5);
    }

    #[test]
    fn pad_or_truncate_truncates_long() {
        let result = pad_or_truncate("this is a very long string", 10);
        assert!(result.chars().count() <= 10);
        assert!(result.ends_with('…'));
    }

    #[test]
    fn format_elapsed_seconds() {
        assert_eq!(format_elapsed(45), "45s");
    }

    #[test]
    fn format_elapsed_minutes() {
        assert_eq!(format_elapsed(125), "2m5s");
    }

    #[test]
    fn log_ring_buffer_caps_at_max() {
        let mut tui = SwarmTui::new("fan-out", 2);
        for i in 0..20 {
            tui.push_log(format!("line {}", i), false);
        }
        assert_eq!(tui.log_lines.len(), MAX_LOG_LINES);
        assert!(tui.log_lines.back().unwrap().text.contains("19"));
    }
}
