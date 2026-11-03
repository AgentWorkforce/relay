//! Where an agent may send files from: its own project (the git repository
//! holding its working directory, or that directory) and the temporary
//! folder, and nothing hidden in them, nor anything under the places that
//! hold credentials or Agent Relay's own data. It keeps a prompt-injected
//! agent from mailing out what its harness would not otherwise show anyone.
//! A file the person sends is not confined.

use super::{read_opened_file, LocalFile, LocalFileError};
use std::path::{Component, Path, PathBuf};

/// Under the home folder: credentials, keys and other apps' settings.
const REFUSED_IN_HOME: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".config",
    ".docker",
    ".kube",
    ".netrc",
    ".agentworkforce",
    ".local/share/keyrings",
    "Library",
    "AppData",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Project,
    Temporary,
}

#[derive(Clone, Debug)]
struct Root {
    path: PathBuf,
    kind: Kind,
}

/// The folders one session's agent may send files from.
#[derive(Clone, Debug)]
pub struct AgentFiles {
    roots: Vec<Root>,
    refused: Vec<PathBuf>,
    /// Why there is no project folder, when there is none.
    no_project: Option<String>,
}

impl AgentFiles {
    /// For a session working in `directory` (when known), on a computer
    /// whose home folder is `home` and whose app data is `app_data_dir`.
    pub fn new(directory: Option<&str>, home: &Path, app_data_dir: &Path) -> AgentFiles {
        AgentFiles::with_temporary(directory, home, app_data_dir, temporary_folders())
    }

    fn with_temporary(
        directory: Option<&str>,
        home: &Path,
        app_data_dir: &Path,
        temporary: Vec<PathBuf>,
    ) -> AgentFiles {
        let home = real(home);
        let project = match directory.map(|dir| (dir, std::fs::canonicalize(dir))) {
            None | Some((_, Err(_))) => {
                Err("Agent Relay does not know this session's folder".into())
            }
            Some((_, Ok(dir))) if dir.parent().is_none() || home.starts_with(&dir) => Err(format!(
                "this session works in {}, which is not a project folder",
                dir.display()
            )),
            Some((_, Ok(dir))) => Ok(repository(&dir, &home).unwrap_or(dir)),
        };
        let mut roots = Vec::new();
        let no_project = match project {
            Ok(path) => {
                roots.push(Root {
                    path,
                    kind: Kind::Project,
                });
                None
            }
            Err(reason) => Some(reason),
        };
        for path in temporary {
            if !roots
                .iter()
                .any(|root| root.kind == Kind::Temporary && root.path == path)
            {
                roots.push(Root {
                    path,
                    kind: Kind::Temporary,
                });
            }
        }
        let mut refused: Vec<PathBuf> = REFUSED_IN_HOME
            .iter()
            .map(|name| real(&home.join(name)))
            .collect();
        refused.push(real(app_data_dir));
        if cfg!(target_os = "macos") {
            refused.push(real(Path::new("/Library/Keychains")));
        }
        AgentFiles {
            roots,
            refused,
            no_project,
        }
    }

    /// The real file `given` names (links resolved), if this agent may send
    /// it; else a sentence saying why not and what to do.
    pub fn check(&self, given: &Path) -> Result<PathBuf, LocalFileError> {
        let path = std::fs::canonicalize(given).map_err(|_| {
            LocalFileError::Invalid(format!(
                "{} is not a readable regular file.",
                given.display()
            ))
        })?;
        let matching: Vec<&Root> = self
            .roots
            .iter()
            .filter(|root| path.starts_with(&root.path))
            .collect();
        if matching.is_empty() {
            return Err(self.outside(given));
        }
        // Hidden below every folder it is in: a temporary folder inside a
        // hidden project folder (`.cache/tmp`) is still the temporary folder.
        let hidden = matching.iter().all(|root| {
            path.components()
                .skip(root.path.components().count())
                .any(|part| matches!(part, Component::Normal(name) if name.to_string_lossy().starts_with('.')))
        });
        if hidden {
            return Err(LocalFileError::NotAllowed(format!(
                "{} is a hidden file or in a hidden folder, which often hold secrets; agents cannot send those.",
                given.display()
            )));
        }
        // The temporary folder may sit inside a refused one (Windows keeps
        // it in AppData); it is still the temporary folder, even when the
        // session works in it.
        let temporary_in = |dir: &Path| {
            self.roots.iter().any(|root| {
                root.kind == Kind::Temporary
                    && path.starts_with(&root.path)
                    && root.path.starts_with(dir)
            })
        };
        let refused = self
            .refused
            .iter()
            .any(|dir| path.starts_with(dir) && !temporary_in(dir));
        if refused {
            return Err(LocalFileError::NotAllowed(format!(
                "{} is in a folder that holds credentials or Agent Relay's own data; agents cannot send files from there.",
                given.display()
            )));
        }
        Ok(path)
    }

    fn outside(&self, given: &Path) -> LocalFileError {
        let temporary = self
            .roots
            .iter()
            .filter(|root| root.kind == Kind::Temporary)
            .map(|root| root.path.display().to_string())
            .collect::<Vec<_>>()
            .join(" or ");
        let project = self.roots.iter().find(|root| root.kind == Kind::Project);
        LocalFileError::NotAllowed(match (project, &self.no_project) {
            (Some(project), _) => format!(
                "{} is outside this session's project folder ({}) and the temporary folder ({temporary}); agents can send files from those only. Copy the file into one of them first.",
                given.display(),
                project.path.display()
            ),
            (None, reason) => format!(
                "{} is not in the temporary folder ({temporary}). {}, so it can send files from the temporary folder only: copy the file there first, or start the session in a project folder.",
                given.display(),
                capitalized(reason.as_deref().unwrap_or("this session has no project folder"))
            ),
        })
    }
}

/// Reads `path` for an agent's send: [`super::read_local_file`], from where
/// `confine` allows only.
pub fn read_agent_file(path: &str, confine: &AgentFiles) -> Result<LocalFile, LocalFileError> {
    let given = Path::new(path);
    if !given.is_absolute() {
        return Err(LocalFileError::Invalid(format!(
            "{path} is not an absolute path."
        )));
    }
    let real = confine.check(given)?;
    // Checked again once open: a file or folder swapped for a link since
    // leads elsewhere now, or no longer to the file that was opened.
    read_opened_file(&real.to_string_lossy(), |file| {
        let opened = file.try_clone().and_then(same_file::Handle::from_file);
        let checked = same_file::Handle::from_path(&real);
        match (confine.check(given)?, opened, checked) {
            (again, Ok(opened), Ok(checked)) if again == real && opened == checked => Ok(()),
            _ => Err(LocalFileError::Invalid(format!(
                "{} changed while Agent Relay was reading it; send it again.",
                given.display()
            ))),
        }
    })
}

/// The nearest folder from `dir` up holding a `.git` (a repository or a
/// worktree), short of the home folder.
fn repository(dir: &Path, home: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .take_while(|folder| !home.starts_with(folder))
        .find(|folder| folder.join(".git").exists())
        .map(Path::to_path_buf)
}

fn temporary_folders() -> Vec<PathBuf> {
    let mut folders = vec![real(&std::env::temp_dir())];
    if cfg!(unix) {
        let tmp = real(Path::new("/tmp"));
        if !folders.contains(&tmp) {
            folders.push(tmp);
        }
    }
    folders
}

/// `path` with links resolved, spelled as the file system spells it. Every
/// path compared here is, so components compare exactly: a case-sensitive
/// volume can hold folders whose names differ only in case.
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Computer {
        _dir: tempfile::TempDir,
        home: PathBuf,
        app_data: PathBuf,
        repo: PathBuf,
        tmp: PathBuf,
    }

    impl Computer {
        fn files(&self, directory: Option<&str>) -> AgentFiles {
            AgentFiles::with_temporary(
                directory,
                &self.home,
                &self.app_data,
                vec![self.tmp.clone()],
            )
        }
    }

    /// A home folder and a temporary folder side by side.
    fn computer() -> Computer {
        let dir = tempfile::tempdir().unwrap();
        let home = real(dir.path()).join("home");
        let tmp = real(dir.path()).join("tmp");
        let app_data = home.join("Library/Application Support/com.agentrelay.desktop");
        let repo = home.join("code/app");
        for folder in [
            &app_data,
            &repo.join(".git"),
            &repo.join("src/.secret"),
            &tmp,
        ] {
            std::fs::create_dir_all(folder).unwrap();
        }
        for file in ["src/main.rs", "src/.env", "src/.secret/key", "README.md"] {
            std::fs::write(repo.join(file), b"x").unwrap();
        }
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), b"key").unwrap();
        std::fs::write(home.join("notes.txt"), b"x").unwrap();
        Computer {
            _dir: dir,
            home,
            app_data,
            repo,
            tmp,
        }
    }

    fn not_allowed(result: Result<PathBuf, LocalFileError>) -> String {
        match result {
            Err(LocalFileError::NotAllowed(message)) => message,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn an_agent_sends_from_its_repository_but_nothing_hidden() {
        let c = computer();
        let sub = c.repo.join("src");
        let files = c.files(sub.to_str());
        // The repository, not just the working directory.
        assert!(files.check(&c.repo.join("README.md")).is_ok());
        assert!(files.check(&c.repo.join("src/main.rs")).is_ok());
        for hidden in ["src/.env", "src/.secret/key"] {
            let message = not_allowed(files.check(&c.repo.join(hidden)));
            assert!(message.contains("hidden"), "{message}");
        }
        let message = not_allowed(files.check(&c.home.join("notes.txt")));
        assert!(
            message.contains("outside this session's project folder"),
            "{message}"
        );
        assert!(message.contains(&c.repo.display().to_string()), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn links_are_judged_by_where_they_lead() {
        let c = computer();
        let files = c.files(c.repo.to_str());
        let key = c.repo.join("key.txt");
        std::os::unix::fs::symlink(c.home.join(".ssh/id_ed25519"), &key).unwrap();
        not_allowed(files.check(&key));
        let env = c.repo.join("env.txt");
        std::os::unix::fs::symlink(c.repo.join("src/.env"), &env).unwrap();
        assert!(not_allowed(files.check(&env)).contains("hidden"));
    }

    #[test]
    fn credentials_and_app_data_are_refused_even_inside_the_project() {
        let c = computer();
        // A session working in the app's own data folder, or in ~/.config.
        let files = c.files(c.app_data.to_str());
        std::fs::write(c.app_data.join("state.json"), b"{}").unwrap();
        let message = not_allowed(files.check(&c.app_data.join("state.json")));
        assert!(message.contains("credentials"), "{message}");
        let config = c.home.join(".config/gh");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("hosts.yml"), b"token").unwrap();
        let files = c.files(config.to_str());
        assert!(not_allowed(files.check(&config.join("hosts.yml"))).contains("credentials"));
    }

    #[test]
    fn a_session_in_the_home_folder_sends_from_the_temporary_folder_only() {
        let c = computer();
        for directory in [Some(c.home.to_str().unwrap()), Some("/"), None] {
            let files = c.files(directory);
            let message = not_allowed(files.check(&c.home.join("notes.txt")));
            assert!(
                message.contains("temporary folder only"),
                "{directory:?}: {message}"
            );
        }
        let files = c.files(None);
        assert!(not_allowed(files.check(&c.home.join("notes.txt")))
            .contains("Agent Relay does not know this session's folder"));
        std::fs::write(c.tmp.join("shot.png"), b"png").unwrap();
        assert!(files.check(&c.tmp.join("shot.png")).is_ok());
    }

    #[test]
    fn the_temporary_folder_is_allowed_inside_a_refused_one() {
        // Windows keeps it in AppData, and a session may work in it.
        let c = computer();
        let temp = c.home.join("AppData/Local/Temp");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("shot.png"), b"png").unwrap();
        std::fs::write(c.home.join("AppData/Local/token"), b"x").unwrap();
        for directory in [temp.to_str(), c.repo.to_str()] {
            let files =
                AgentFiles::with_temporary(directory, &c.home, &c.app_data, vec![temp.clone()]);
            assert!(files.check(&temp.join("shot.png")).is_ok(), "{directory:?}");
            not_allowed(files.check(&c.home.join("AppData/Local/token")));
        }
    }

    #[test]
    fn a_temporary_folder_in_a_hidden_project_folder_is_not_hidden() {
        let c = computer();
        let temp = c.repo.join(".cache/tmp");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("shot.png"), b"png").unwrap();
        std::fs::write(c.repo.join(".cache/token"), b"x").unwrap();
        let files =
            AgentFiles::with_temporary(c.repo.to_str(), &c.home, &c.app_data, vec![temp.clone()]);
        assert!(files.check(&temp.join("shot.png")).is_ok());
        assert!(not_allowed(files.check(&c.repo.join(".cache/token"))).contains("hidden"));
    }

    #[test]
    fn a_relative_or_missing_path_is_invalid() {
        let c = computer();
        let files = c.files(c.repo.to_str());
        assert!(matches!(
            read_agent_file("src/main.rs", &files),
            Err(LocalFileError::Invalid(_))
        ));
        assert!(matches!(
            read_agent_file(c.repo.join("gone").to_str().unwrap(), &files),
            Err(LocalFileError::Invalid(_))
        ));
        let file = read_agent_file(c.repo.join("src/main.rs").to_str().unwrap(), &files).unwrap();
        assert_eq!(
            (file.filename.as_str(), file.bytes.as_slice()),
            ("main.rs", &b"x"[..])
        );
    }
}
