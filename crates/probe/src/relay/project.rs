//! Stable project names for local sessions.
//!
//! A transcript's cwd is often a useful project hint, but broker-launched
//! sessions inherit the broker controller's cwd and linked worktrees often
//! have disposable directory names. Prefer Git's repository identity when
//! the directory still exists, suppress a positively identified relay
//! controller root, and retain the folder fallback for old/missing paths.

mod cache;
pub(crate) use cache::Names;

use std::fs;
use std::path::{Path, PathBuf};

/// Resolves the project shown for `directory`.
fn name(directory: Option<&str>, relay_home: &Path) -> Option<String> {
    let directory = Path::new(directory?.trim());
    if directory.as_os_str().is_empty() {
        return None;
    }

    let controller = controller_paths(directory, relay_home);
    let (search_root, floor) = controller
        .as_ref()
        .map(|(directory, root)| (directory.as_path(), Some(root.as_path())))
        .unwrap_or((directory, None));
    if let Some((root, git_dir)) = repository(search_root, floor) {
        return remote_name(&git_dir).or_else(|| file_name(&root));
    }

    if controller
        .as_ref()
        .is_some_and(|(directory, root)| same_path(directory, root))
    {
        return None;
    }
    file_name(directory)
}

fn repository(directory: &Path, floor: Option<&Path>) -> Option<(PathBuf, PathBuf)> {
    let start = floor.map_or_else(
        || {
            directory
                .canonicalize()
                .unwrap_or_else(|_| directory.to_path_buf())
        },
        |_| directory.to_path_buf(),
    );
    for root in start.ancestors() {
        if floor.is_some_and(|floor| !root.starts_with(floor)) {
            break;
        }
        let marker = root.join(".git");
        if marker.is_dir() {
            return Some((root.to_path_buf(), common_git_dir(&marker)));
        }
        if marker.is_file() {
            let contents = fs::read_to_string(&marker).ok()?;
            let relative = contents.trim().strip_prefix("gitdir:")?.trim();
            let git_dir = resolve(root, Path::new(relative));
            return Some((root.to_path_buf(), common_git_dir(&git_dir)));
        }
        if floor.is_some_and(|floor| root == floor) {
            break;
        }
    }
    None
}

fn common_git_dir(git_dir: &Path) -> PathBuf {
    let Some(relative) = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return git_dir.to_path_buf();
    };
    resolve(git_dir, Path::new(&relative))
}

fn resolve(base: &Path, path: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    path.canonicalize().unwrap_or(path)
}

fn remote_name(git_dir: &Path) -> Option<String> {
    let config = fs::read_to_string(git_dir.join("config")).ok()?;
    let mut origin = false;
    for raw in config.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            origin = line.eq_ignore_ascii_case("[remote \"origin\"]");
            continue;
        }
        if !origin {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            return repository_name(value.trim());
        }
    }
    None
}

fn repository_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let leaf = trimmed
        .rsplit(|character| character == '/' || character == ':')
        .next()?
        .strip_suffix(".git")
        .unwrap_or_else(|| {
            trimmed
                .rsplit(|character| character == '/' || character == ':')
                .next()
                .unwrap_or("")
        })
        .trim();
    (!leaf.is_empty()).then(|| leaf.to_string())
}

/// Returns the path to search and the controller root that bounds it.
///
/// Relay controllers are the relay home itself and each direct child. Git
/// evidence inside a controller is useful, but a repository above it is not.
fn controller_paths(directory: &Path, relay_home: &Path) -> Option<(PathBuf, PathBuf)> {
    if let Some(root) = controller_root(directory, relay_home) {
        return Some((directory.to_path_buf(), root));
    }
    let directory = directory.canonicalize().ok()?;
    let relay_home = relay_home.canonicalize().ok()?;
    controller_root(&directory, &relay_home).map(|root| (directory, root))
}

fn controller_root(directory: &Path, relay_home: &Path) -> Option<PathBuf> {
    let relative = directory.strip_prefix(relay_home).ok()?;
    let first = relative.components().next();
    match first {
        None => Some(relay_home.to_path_buf()),
        Some(std::path::Component::Normal(name)) => Some(relay_home.join(name)),
        _ => None,
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || left
            .canonicalize()
            .ok()
            .zip(right.canonicalize().ok())
            .is_some_and(|(left, right)| left == right)
}

fn file_name(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn ordinary_checkout_and_nested_directory_use_remote_repository() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("relay-desktop-231-recovery-1005");
        fs::create_dir_all(root.join("probe/src")).unwrap();
        write(
            &root.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github.com:acme/relay-desktop.git\n",
        );
        assert_eq!(
            name(
                Some(root.join("probe/src").to_str().unwrap()),
                &temp.path().join("relay")
            ),
            Some("relay-desktop".into())
        );
    }

    #[test]
    fn linked_worktree_reads_the_common_remote() {
        let temp = tempfile::tempdir().unwrap();
        let common = temp.path().join("source/.git");
        let worktree_git = common.join("worktrees/cloud-pr3951");
        let checkout = temp.path().join("cloud-pr3951");
        fs::create_dir_all(&checkout).unwrap();
        write(
            &checkout.join(".git"),
            &format!("gitdir: {}\n", worktree_git.display()),
        );
        write(&worktree_git.join("commondir"), "../..\n");
        write(
            &common.join("config"),
            "[remote \"origin\"]\nurl = https://github.com/acme/cloud.git\n",
        );
        assert_eq!(
            name(Some(checkout.to_str().unwrap()), &temp.path().join("relay")),
            Some("cloud".into())
        );
    }

    #[test]
    fn local_repository_without_origin_uses_checkout_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("legitimate-node");
        fs::create_dir_all(root.join(".git")).unwrap();
        assert_eq!(
            name(Some(root.to_str().unwrap()), &temp.path().join("relay")),
            Some("legitimate-node".into())
        );
    }

    #[test]
    fn only_identified_controller_roots_are_suppressed() {
        let temp = tempfile::tempdir().unwrap();
        let relay_home = temp.path().join("relay");
        let controller = relay_home.join("test-mini-node");
        let task = controller.join("checkout-without-git");
        fs::create_dir_all(&task).unwrap();
        assert_eq!(name(Some(controller.to_str().unwrap()), &relay_home), None);
        assert_eq!(
            name(Some(task.to_str().unwrap()), &relay_home),
            Some("checkout-without-git".into())
        );
        assert_eq!(
            name(Some("/missing/legitimate-node"), &relay_home),
            Some("legitimate-node".into())
        );
    }

    #[test]
    fn a_parent_repository_does_not_claim_a_controller_root() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".git")).unwrap();
        let relay_home = temp.path().join("relay");
        let controller = relay_home.join("test-mini-node");
        let task = controller.join("checkout-without-git");
        fs::create_dir_all(&task).unwrap();
        assert_eq!(name(Some(controller.to_str().unwrap()), &relay_home), None);
        assert_eq!(
            name(Some(task.to_str().unwrap()), &relay_home),
            Some("checkout-without-git".into())
        );
    }

    #[test]
    fn repository_inside_a_controller_is_still_real_evidence() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".git")).unwrap();
        let relay_home = temp.path().join("relay");
        let root = relay_home.join("test-mini-node/task-123");
        write(
            &root.join(".git/config"),
            "[remote \"origin\"]\nurl = https://github.com/acme/relay-desktop.git\n",
        );
        assert_eq!(
            name(Some(root.to_str().unwrap()), &relay_home),
            Some("relay-desktop".into())
        );
    }
}
