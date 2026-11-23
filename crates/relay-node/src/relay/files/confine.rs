//! Where an agent may send files from: its own project (the git repository
//! holding its working directory, or that directory) and the temporary
//! folder, and nothing hidden in them, nor anything under the places that
//! hold credentials or Agent Relay's own data. It keeps a prompt-injected
//! agent from mailing out what its harness would not otherwise show anyone.
//! A file the person sends is not confined to a project: [`PersonFiles`]
//! refuses only Agent Relay's own data.

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
    read_checked(path, |given| confine.check(given))
}

/// Where the person's own sends (`messages.send`) may read from: anywhere
/// but Agent Relay's own data, which holds the sign-in and agent tokens the
/// bridge sends with. The person picked each file in a file chooser, so
/// neither the project rule nor hidden files apply. Files received on
/// messages (`<app data>/attachments`) may be sent on.
#[derive(Clone, Debug)]
pub struct PersonFiles {
    refused: Vec<PathBuf>,
    received: PathBuf,
}

impl PersonFiles {
    /// On a computer whose home folder is `home` and whose app data is
    /// `app_data_dir`.
    pub fn new(home: &Path, app_data_dir: &Path) -> PersonFiles {
        let mut refused = vec![real(&home.join(".agentworkforce")), real(app_data_dir)];
        refused.dedup();
        PersonFiles {
            refused,
            // The folder's own name, not where it may lead: a link there to
            // a refused folder must not make that folder allowed.
            received: real(app_data_dir).join(super::ATTACHMENTS_DIR),
        }
    }

    /// The real file `given` names (links resolved), if the person may
    /// attach it; else a sentence saying why not.
    pub fn check(&self, given: &Path) -> Result<PathBuf, LocalFileError> {
        let path = std::fs::canonicalize(given).map_err(|_| {
            LocalFileError::Invalid(format!(
                "{} is not a readable regular file.",
                given.display()
            ))
        })?;
        let refused = self.refused.iter().any(|dir| path.starts_with(dir))
            && !path.starts_with(&self.received);
        if refused {
            return Err(LocalFileError::NotAllowed(format!(
                "{} is in Agent Relay's own data folder, which holds its sign-in; it cannot be attached.",
                given.display()
            )));
        }
        Ok(path)
    }
}

/// Reads `path` for the person's send: [`super::read_local_file`], with
/// links resolved and judged by where they lead ([`PersonFiles`]).
pub fn read_person_file(path: &str, files: &PersonFiles) -> Result<LocalFile, LocalFileError> {
    read_checked(path, |given| files.check(given))
}

/// Reads the absolute `path` once `check` has resolved it to the real file
/// it may send. Once the file is open, `check` judges the open file itself,
/// by the path the system holds for it, so the bytes read are from a file
/// the policy allowed, however the path was swapped meanwhile.
fn read_checked(
    path: &str,
    check: impl Fn(&Path) -> Result<PathBuf, LocalFileError>,
) -> Result<LocalFile, LocalFileError> {
    let given = Path::new(path);
    if !given.is_absolute() {
        return Err(LocalFileError::Invalid(format!(
            "{path} is not an absolute path."
        )));
    }
    let real = check(given)?;
    let changed = || {
        LocalFileError::Invalid(format!(
            "{} changed while Agent Relay was reading it; send it again.",
            given.display()
        ))
    };
    read_opened_file(&real.to_string_lossy(), |file| {
        match opened_path(file) {
            // The open file's own path is judged: allowed, and already
            // real (no link along it now).
            Some(Ok(held)) => match check(&held)? {
                again if again == held => Ok(()),
                _ => Err(changed()),
            },
            Some(Err(())) => Err(changed()),
            // Where the system cannot name an open file, checked again by
            // path: a file or folder swapped for a link since leads
            // elsewhere now, or no longer to the file that was opened.
            None => {
                let opened = file.try_clone().and_then(same_file::Handle::from_file);
                let checked = same_file::Handle::from_path(&real);
                match (check(given)?, opened, checked) {
                    (again, Ok(opened), Ok(checked)) if again == real && opened == checked => {
                        Ok(())
                    }
                    _ => Err(changed()),
                }
            }
        }
    })
}

/// The path the system holds for an open file, spelled as
/// [`std::fs::canonicalize`] spells it; `None` where it cannot say.
#[cfg(target_os = "linux")]
fn opened_path(file: &std::fs::File) -> Option<Result<PathBuf, ()>> {
    use std::os::fd::AsRawFd;
    Some(std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|_| ()))
}

#[cfg(target_os = "macos")]
fn opened_path(file: &std::fs::File) -> Option<Result<PathBuf, ()>> {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = vec![0 as libc::c_char; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes, NUL-terminated, into
    // the buffer, which is that long.
    let answer = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if answer == -1 {
        return Some(Err(()));
    }
    // SAFETY: on success the buffer holds a NUL-terminated path.
    let path = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Some(Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
        path.to_bytes(),
    ))))
}

#[cfg(windows)]
fn opened_path(file: &std::fs::File) -> Option<Result<PathBuf, ()>> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS (both 0): the `\\?\C:\…` form
    // std::fs::canonicalize also returns.
    let handle = file.as_raw_handle() as _;
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: the buffer is `buffer.len()` UTF-16 units long, as passed.
        let written = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        } as usize;
        if written == 0 {
            return Some(Err(()));
        }
        if written < buffer.len() {
            return Some(Ok(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..written],
            ))));
        }
        // Too small: `written` is the length needed, with its NUL.
        if written > 32 * 1024 {
            return Some(Err(()));
        }
        buffer.resize(written + 1, 0);
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn opened_path(_file: &std::fs::File) -> Option<Result<PathBuf, ()>> {
    None
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
    fn the_person_sends_from_anywhere_but_agent_relays_own_data() {
        let c = computer();
        let person = PersonFiles::new(&c.home, &c.app_data);
        // What an agent may not send, the person picked and may.
        for file in [
            c.home.join("notes.txt"),
            c.repo.join("src/.env"),
            c.home.join(".ssh/id_ed25519"),
        ] {
            assert!(person.check(&file).is_ok(), "{}", file.display());
        }
        std::fs::write(c.app_data.join("state.json"), b"{}").unwrap();
        let message = not_allowed(person.check(&c.app_data.join("state.json")));
        assert!(message.contains("Agent Relay's own data"), "{message}");
        let desktop = c.home.join(".agentworkforce/desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(desktop.join("token"), b"x").unwrap();
        not_allowed(person.check(&desktop.join("token")));
        // A file received on a message may be sent on.
        let received = c
            .app_data
            .join(super::super::ATTACHMENTS_DIR)
            .join("file-1");
        std::fs::create_dir_all(&received).unwrap();
        std::fs::write(received.join("shot.png"), b"png").unwrap();
        let person = PersonFiles::new(&c.home, &c.app_data);
        assert!(person.check(&received.join("shot.png")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_received_folder_that_links_elsewhere_allows_nothing_there() {
        let c = computer();
        let desktop = c.home.join(".agentworkforce/desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(desktop.join("token"), b"x").unwrap();
        std::os::unix::fs::symlink(
            c.home.join(".agentworkforce"),
            c.app_data.join(super::super::ATTACHMENTS_DIR),
        )
        .unwrap();
        let person = PersonFiles::new(&c.home, &c.app_data);
        not_allowed(person.check(&desktop.join("token")));
        let through = c
            .app_data
            .join(super::super::ATTACHMENTS_DIR)
            .join("desktop/token");
        not_allowed(person.check(&through));
    }

    #[test]
    fn the_open_file_is_judged_by_the_path_the_system_holds_for_it() {
        let c = computer();
        let file = c.home.join("notes.txt");
        let opened = std::fs::File::open(&file).unwrap();
        if let Some(held) = opened_path(&opened) {
            assert_eq!(held.unwrap(), real(&file));
        }
        let person = PersonFiles::new(&c.home, &c.app_data);
        let read = read_person_file(file.to_str().unwrap(), &person).unwrap();
        assert_eq!(read.bytes, b"x");
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
