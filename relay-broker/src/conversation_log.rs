use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

use anyhow::Result;
use chrono::Local;

use crate::types::InboundRelayEvent;

const COL_TIME: usize = 8;
const COL_AGENT: usize = 16;
const COL_TYPE: usize = 14;

pub struct ConversationLog {
    file: File,
    agent_name: String,
    wrote_header: bool,
}

impl ConversationLog {
    pub fn open(path: &Path, agent_name: &str) -> Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            file,
            agent_name: agent_name.to_string(),
            wrote_header: false,
        })
    }

    fn ensure_header(&mut self) {
        if self.wrote_header {
            return;
        }
        self.wrote_header = true;
        let _ = writeln!(
            self.file,
            " {:<w_time$} | {:<w_agent$} | {:<w_type$} | Message",
            "Time",
            "Agent",
            "Type",
            w_time = COL_TIME,
            w_agent = COL_AGENT,
            w_type = COL_TYPE,
        );
        let _ = writeln!(
            self.file,
            "-{}-+-{}-+-{}-+-{}",
            "-".repeat(COL_TIME),
            "-".repeat(COL_AGENT),
            "-".repeat(COL_TYPE),
            "-".repeat(40),
        );
        let _ = self.file.flush();
    }

    fn write_row(&mut self, agent: &str, msg_type: &str, message: &str) {
        self.ensure_header();
        let ts = Local::now().format("%H:%M:%S");
        let _ = writeln!(
            self.file,
            " {:<w_time$} | {:<w_agent$} | {:<w_type$} | {}",
            ts,
            pad_or_truncate(agent, COL_AGENT),
            pad_or_truncate(msg_type, COL_TYPE),
            message,
            w_time = COL_TIME,
            w_agent = COL_AGENT,
            w_type = COL_TYPE,
        );
        let _ = self.file.flush();
    }

    pub fn log_inbound(&mut self, event: &InboundRelayEvent) {
        let msg_type = match event.kind {
            crate::types::InboundKind::DmReceived => "DM".to_string(),
            crate::types::InboundKind::GroupDmReceived => "Group DM".to_string(),
            crate::types::InboundKind::MessageCreated => event.target.clone(),
            crate::types::InboundKind::ThreadReply => format!(
                "Thread {}",
                short_id(event.thread_id.as_deref().unwrap_or("?"))
            ),
            crate::types::InboundKind::Presence => "Presence".to_string(),
        };
        let body = truncate(&event.text, 120);
        self.write_row(&event.from, &msg_type, &body);
    }

    pub fn log_registration(&mut self, workspace_id: &str, agent_id: &str) {
        self.write_row(
            &self.agent_name.clone(),
            "Registered",
            &format!(
                "workspace={} agent={}",
                short_id(workspace_id),
                short_id(agent_id)
            ),
        );
    }

    pub fn log_channel_join(&mut self, channel: &str) {
        self.write_row(&self.agent_name.clone(), "Joined", channel);
    }

    pub fn log_system(&mut self, label: &str, detail: &str) {
        self.write_row(&self.agent_name.clone(), label, detail);
    }
}

/// Find the largest byte index <= `idx` that lies on a UTF-8 char boundary.
fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut end = idx.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.replace('\n', " ");
    if trimmed.len() <= max {
        trimmed
    } else {
        let end = floor_char_boundary(&trimmed, max);
        format!("{}…", &trimmed[..end])
    }
}

fn pad_or_truncate(s: &str, width: usize) -> String {
    if s.len() > width {
        let end = floor_char_boundary(s, width - 1);
        format!("{}…", &s[..end])
    } else {
        s.to_string()
    }
}

fn short_id(value: &str) -> String {
    if value.len() <= 8 {
        value.to_string()
    } else {
        let end = floor_char_boundary(value, 8);
        value[..end].to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::ConversationLog;

    #[test]
    fn writes_table_header_and_registration() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("conversation.log");

        let mut log = ConversationLog::open(&path, "Lead").expect("open");
        log.log_registration("workspace-123456", "agent-abcdef");
        log.log_channel_join("#general");
        log.log_system("CONN", "reconnected");

        let body = fs::read_to_string(&path).expect("read");
        // Header present
        assert!(body.contains("| Agent"));
        assert!(body.contains("| Type"));
        assert!(body.contains("| Message"));
        // Separator line
        assert!(body.contains("-+-"));
        // Registration row
        assert!(body.contains("| Registered"));
        assert!(body.contains("workspace=workspac"));
        // Channel join
        assert!(body.contains("| Joined"));
        assert!(body.contains("#general"));
        // System event
        assert!(body.contains("| CONN"));
        assert!(body.contains("reconnected"));
    }

    #[test]
    fn writes_inbound_message_rows() {
        use crate::types::{InboundKind, InboundRelayEvent, RelayPriority, SenderKind};

        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("conversation.log");

        let mut log = ConversationLog::open(&path, "Lead").expect("open");
        log.log_inbound(&InboundRelayEvent {
            event_id: "e1".into(),
            kind: InboundKind::DmReceived,
            from: "alice".into(),
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target: "Lead".into(),
            text: "hey there".into(),
            thread_id: None,
            priority: RelayPriority::P2,
        });
        log.log_inbound(&InboundRelayEvent {
            event_id: "e2".into(),
            kind: InboundKind::MessageCreated,
            from: "bob".into(),
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target: "#general".into(),
            text: "hello team".into(),
            thread_id: None,
            priority: RelayPriority::P3,
        });

        let body = fs::read_to_string(&path).expect("read");
        assert!(body.contains("| alice"));
        assert!(body.contains("| DM"));
        assert!(body.contains("| hey there"));
        assert!(body.contains("| bob"));
        assert!(body.contains("| #general"));
        assert!(body.contains("| hello team"));
    }

    #[test]
    fn truncate_handles_multibyte_utf8() {
        use super::{truncate, pad_or_truncate, short_id};

        // Emoji are 4 bytes each; truncating at byte boundary mid-char must not panic
        let emoji_str = "Hello 🌍🌎🌏 world";
        let result = truncate(emoji_str, 10);
        assert!(result.ends_with('…'));
        assert!(!result.contains('\u{FFFD}')); // no replacement chars

        // pad_or_truncate with multi-byte
        let result = pad_or_truncate("café résumé", 6);
        assert!(result.ends_with('…'));

        // short_id with multi-byte prefix
        let result = short_id("🎉🎊🎈party");
        // Should not panic; 3 emoji = 12 bytes, truncate to 8 bytes = 2 emoji (8 bytes)
        assert!(result.len() <= 12);
    }
}
