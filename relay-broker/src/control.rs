use crate::types::SenderKind;

pub fn is_human_sender(sender: &str, sender_kind: SenderKind) -> bool {
    if matches!(sender_kind, SenderKind::Human) {
        return true;
    }

    let s = sender.trim().to_ascii_lowercase();
    s == "human" || s.starts_with("human:")
}

pub fn can_release_child(owner: Option<&str>, sender: &str, sender_is_human: bool) -> bool {
    sender_is_human || owner == Some(sender)
}

#[cfg(test)]
mod tests {
    use super::{can_release_child, is_human_sender};
    use crate::types::SenderKind;

    #[test]
    fn human_sender_detection() {
        assert!(is_human_sender("alice", SenderKind::Human));
        assert!(is_human_sender("human:alice", SenderKind::Unknown));
        assert!(!is_human_sender("Worker1", SenderKind::Agent));
    }

    #[test]
    fn release_acl() {
        assert!(can_release_child(Some("Lead"), "Lead", false));
        assert!(can_release_child(Some("Lead"), "alice", true));
        assert!(!can_release_child(Some("Lead"), "Worker2", false));
        assert!(!can_release_child(None, "Worker2", false));
    }
}
