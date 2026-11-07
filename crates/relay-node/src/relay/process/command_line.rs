//! What one read of a process's arguments and environment saw.

/// A process's arguments and environment as one read of it saw them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandLine {
    pub arguments: Vec<String>,
    /// `NAME=value` entries; `None` when the kernel would not let this user
    /// read them.
    pub environment: Option<Vec<String>>,
}

impl CommandLine {
    /// One variable. Windows matches names in any case, as Windows does.
    pub fn var(&self, key: &str) -> Option<String> {
        self.environment.as_ref()?.iter().find_map(|entry| {
            let (name, value) = entry.split_once('=')?;
            let named = if cfg!(windows) {
                name.eq_ignore_ascii_case(key)
            } else {
                name == key
            };
            named.then(|| value.to_string())
        })
    }
}
