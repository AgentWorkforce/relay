//! Private Dev settings persist choices without following production processes.
use super::*;
impl ClaudeDirs {
    pub fn development(root: &Path) -> Self {
        Self {
            environment: Vec::new(),
            file: Some(root.join(FILE)),
            private_root: Some(root.into()),
        }
    }

    /// Discovery may watch normal profiles, but Dev settings writers only edit
    /// owned regular files beneath their isolated client home.
    pub fn settings_writable(&self, file: &Path) -> bool {
        let Some(root) = &self.private_root else {
            return true;
        };
        if !self.valid_private_state() {
            return false;
        }
        // Folder discovery returns real paths. Keep the same boundary when
        // the trusted app-data parent uses an OS alias such as /var on macOS.
        let real_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        let file = file
            .strip_prefix(root)
            .map(|relative| real_root.join(relative))
            .unwrap_or_else(|_| file.to_path_buf());
        let root = &real_root;
        let clients = root.join("mcp/clients");
        let Ok(relative) = file.strip_prefix(&clients) else {
            return false;
        };
        if relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return false;
        }
        let Ok(relative) = file.strip_prefix(root) else {
            return false;
        };
        let mut current = root.clone();
        for part in std::iter::once(None).chain(relative.components().map(Some)) {
            if let Some(part) = part {
                current.push(part);
            }
            match std::fs::symlink_metadata(&current) {
                Ok(meta)
                    if meta.file_type().is_symlink()
                        || !crate::platform::fs::owned_by_current_user(&meta)
                        || (current == file && !meta.is_file())
                        || (current != file && !meta.is_dir()) =>
                {
                    return false
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return false,
            }
        }
        true
    }

    pub(super) fn valid_private_state(&self) -> bool {
        let Some(root) = &self.private_root else {
            return true;
        };
        if !root
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".dev"))
            || self.file.as_deref() != Some(root.join(FILE).as_path())
        {
            return false;
        }
        if std::fs::symlink_metadata(root).is_ok_and(|meta| {
            !meta.is_dir()
                || meta.file_type().is_symlink()
                || !crate::platform::fs::owned_by_current_user(&meta)
        }) {
            return false;
        }
        [root.join(FILE), lock_path(&root.join(FILE))]
            .iter()
            .all(|file| match std::fs::symlink_metadata(file) {
                Ok(meta) => {
                    meta.is_file()
                        && !meta.file_type().is_symlink()
                        && crate::platform::fs::owned_by_current_user(&meta)
                }
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            })
    }
}
