//! First-install consent; reconnects keep the saved sharing policy.
use super::{bridge, user_error};
use anyhow::Result;
use std::io::{self, IsTerminal, Write};

fn import_choice(answer: &str) -> Option<bridge::SharingMode> {
    match answer.trim() {
        "" | "1" => Some(bridge::SharingMode::Selected),
        "2" => Some(bridge::SharingMode::New),
        "3" => Some(bridge::SharingMode::All),
        _ => None,
    }
}

pub(super) fn choose_import() -> Result<Option<bridge::SharingMode>> {
    if !io::stdin().is_terminal() {
        return Err(user_error("Use an interactive terminal, or explicitly pass --selected-sessions-only, --new-sessions-only, or --include-existing."));
    }
    humanln!("Share coding session content with this Cloud workspace:");
    humanln!(
        "  1. Only sessions I select (default)\n  2. Automatically upload new sessions\n  3. Automatically upload all sessions\n  4. Cancel"
    );
    print!("Choose 1, 2, 3 or 4 [1]: ");
    io::stdout().flush()?;
    let mut answer = String::new();
    if io::stdin().read_line(&mut answer)? == 0 {
        return Ok(None);
    }
    Ok(import_choice(&answer))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_install_defaults_to_selected_sessions() {
        use bridge::SharingMode::{All, New, Selected};
        assert_eq!(import_choice(""), Some(Selected));
        assert_eq!(import_choice(" 1\n"), Some(Selected));
        assert_eq!(import_choice("2"), Some(New));
        assert_eq!(import_choice("3"), Some(All));
        assert_eq!(import_choice("4"), None);
        assert_eq!(import_choice("invalid"), None);
    }
}
