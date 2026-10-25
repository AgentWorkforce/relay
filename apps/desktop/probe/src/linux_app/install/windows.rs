//! The Windows install tree, and the per-user registry entries the app
//! keeps.
//!
//! A tree is an MSYS2 prefix: the app, its core and the GTK runtime it
//! links share `bin\`, so Windows finds the DLLs beside the programs.
//!
//! | Path | Is |
//! |---|---|
//! | [`APP`] `bin\agent-relay-desktop.exe` | The app |
//! | [`PROBE`] `bin\agent-relay-probe.exe` | The relay core |
//! | `bin\*.dll`, `bin\gdbus.exe` | The GTK 4 runtime, and the session bus GApplication uses to stay one instance |
//! | [`LIB`] `lib\` | GTK's modules: `gdk-pixbuf-2.0\2.10.0\loaders` (with the SVG loader) and `loaders.cache` |
//! | [`SHARE`] `share\` | `glib-2.0\schemas` (compiled), `icons\` (Adwaita, hicolor) |
//!
//! A release publishes the tree as `AgentRelay-<version>-Windows-<arch>.zip`
//! (`arch` is `x64` or `arm64`) holding one folder, [`tree_name`], with its
//! `.zip.sha256` beside it. A per-user install unpacks it at
//! `%LOCALAPPDATA%\Programs\AgentRelay\<version>\<tree>`, as the release's
//! `AgentRelay-<version>-Windows-<arch>-Setup.exe` installs it.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf, Prefix};

/// The app, in a tree.
pub const APP: &str = r"bin\agent-relay-desktop.exe";
/// The relay core, in a tree.
pub const PROBE: &str = r"bin\agent-relay-probe.exe";
/// GTK's loadable modules, in a tree.
pub const LIB: &str = "lib";
/// GLib schemas and icon themes, in a tree.
pub const SHARE: &str = "share";
/// The per-user install root, under `%LOCALAPPDATA%`.
pub const ROOT: &str = r"Programs\AgentRelay";
/// The Start menu shortcut, under `%APPDATA%`.
pub const SHORTCUT: &str = r"Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk";
/// The `agentrelay://` link handler, under `HKEY_CURRENT_USER`.
pub const PROTOCOL_KEY: &str = r"Software\Classes\agentrelay";
/// The identity Windows files the app's notifications under.
pub const APP_USER_MODEL_ID: &str = "AgentWorkforce.AgentRelay";
/// Where that identity's name and icon are registered, under `HKEY_CURRENT_USER`.
pub const APP_USER_MODEL_KEY: &str = r"Software\Classes\AppUserModelId\AgentWorkforce.AgentRelay";
/// The entry in Installed apps that the Setup program
/// (`windows/installer/AgentRelay.iss`, whose `AppId` this is) writes, under
/// `HKEY_CURRENT_USER`. A zip install has none.
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{C5377993-AE99-466F-A519-676A299A6C6D}_is1";

/// The folder a release zip holds for `arch` (`x64` or `arm64`).
pub fn tree_name(arch: &str) -> String {
    format!("AgentRelay-Windows-{arch}")
}

/// `path` without the `\\?\` prefix `canonicalize` adds, where the plain
/// form names the same file: `\\?\C:\x` is `C:\x`, `\\?\UNC\s\x` is `\\s\x`.
pub fn plain(path: &Path) -> PathBuf {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return path.to_path_buf();
    };
    let text = path.to_string_lossy();
    match prefix.kind() {
        // A plain path longer than MAX_PATH would stop working.
        _ if text.len() > 259 => path.to_path_buf(),
        Prefix::VerbatimDisk(_) => PathBuf::from(&text[4..]),
        Prefix::VerbatimUNC(..) => PathBuf::from(format!(r"\{}", &text[7..])),
        _ => path.to_path_buf(),
    }
}

/// `%LOCALAPPDATA%`, else `<home>\AppData\Local`.
pub fn local_app_data(env: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> PathBuf {
    known_folder(env, "LOCALAPPDATA").unwrap_or_else(|| home.join(r"AppData\Local"))
}

/// `%APPDATA%`, else `<home>\AppData\Roaming`.
pub fn app_data(env: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> PathBuf {
    known_folder(env, "APPDATA").unwrap_or_else(|| home.join(r"AppData\Roaming"))
}

fn known_folder(env: &dyn Fn(&str) -> Option<OsString>, name: &str) -> Option<PathBuf> {
    env(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// The `...\Programs\AgentRelay` folder `exe` runs under, if any.
pub fn per_user_root_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .skip(1)
        .find(|path| {
            let names: Vec<String> = path
                .iter()
                .rev()
                .take(2)
                .map(|name| name.to_string_lossy().to_lowercase())
                .collect();
            names == ["agentrelay", "programs"]
        })
        .map(Path::to_path_buf)
}

/// `value` with Windows' own quoting for one command-line argument (the
/// rules `CommandLineToArgvW` reverses).
pub fn quote_argument(value: &str) -> String {
    if !value.is_empty() && !value.contains([' ', '\t', '\n', '"']) {
        return value.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for c in value.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            c => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// The `HKEY_CURRENT_USER` values that make `agentrelay://` links open
/// `exe`: `(key, value name, data)`, an empty name being the key's default.
pub fn protocol_entries(exe: &Path) -> Vec<(String, String, String)> {
    let exe = exe.display().to_string();
    let key = |path: &str| {
        if path.is_empty() {
            PROTOCOL_KEY.to_owned()
        } else {
            format!(r"{PROTOCOL_KEY}\{path}")
        }
    };
    vec![
        (key(""), String::new(), "URL:Agent Relay".into()),
        (key(""), "URL Protocol".into(), String::new()),
        (key("DefaultIcon"), String::new(), format!("\"{exe}\",0")),
        (
            key(r"shell\open\command"),
            String::new(),
            format!("\"{exe}\" \"%1\""),
        ),
    ]
}

/// The program a `shell\open\command` value runs.
pub fn command_program(command: &str) -> Option<&str> {
    let command = command.trim_start();
    match command.strip_prefix('"') {
        Some(rest) => rest.split('"').next(),
        None => command.split_whitespace().next(),
    }
    .filter(|program| !program.is_empty())
}

/// Names [`APP_USER_MODEL_ID`] "Agent Relay" for Windows' notification
/// centre, which shows notifications of an unpackaged app only under an
/// identity registered this way (or by a Start menu shortcut carrying it).
pub fn register_app_user_model() -> std::io::Result<()> {
    if registry::read_string(
        registry::Root::CurrentUser,
        APP_USER_MODEL_KEY,
        "DisplayName",
    )
    .as_deref()
        == Some("Agent Relay")
    {
        return Ok(());
    }
    registry::write_string(APP_USER_MODEL_KEY, "DisplayName", "Agent Relay")
}

/// The registry, through the Win32 API.
pub mod registry {
    use std::io;
    use std::ptr;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
        HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    /// A root key.
    #[derive(Clone, Copy, Debug)]
    pub enum Root {
        CurrentUser,
        ClassesRoot,
        LocalMachine,
    }

    impl Root {
        fn handle(self) -> HKEY {
            match self {
                Root::CurrentUser => HKEY_CURRENT_USER,
                Root::ClassesRoot => HKEY_CLASSES_ROOT,
                Root::LocalMachine => HKEY_LOCAL_MACHINE,
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn error(code: u32) -> io::Error {
        io::Error::from_raw_os_error(code as i32)
    }

    /// Whether `root\path` exists.
    pub fn key_exists(root: Root, path: &str) -> bool {
        let path = wide(path);
        let mut key: HKEY = ptr::null_mut();
        // SAFETY: valid NUL-terminated strings and an out pointer.
        let status = unsafe { RegOpenKeyExW(root.handle(), path.as_ptr(), 0, KEY_READ, &mut key) };
        if status == ERROR_SUCCESS {
            // SAFETY: the key was opened above.
            unsafe { RegCloseKey(key) };
            true
        } else {
            false
        }
    }

    /// The string value `name` (empty: the default) of `root\path`.
    pub fn read_string(root: Root, path: &str, name: &str) -> Option<String> {
        let (path, name) = (wide(path), wide(name));
        let mut size: u32 = 0;
        // SAFETY: a size query with no buffer.
        let status = unsafe {
            RegGetValueW(
                root.handle(),
                path.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: `buffer` holds `size` bytes.
        let status = unsafe {
            RegGetValueW(
                root.handle(),
                path.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let length = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..length]))
    }

    /// The DWORD value `name` of `root\path`.
    pub fn read_dword(root: Root, path: &str, name: &str) -> Option<u32> {
        let (path, name) = (wide(path), wide(name));
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `value` holds `size` bytes.
        let status = unsafe {
            RegGetValueW(
                root.handle(),
                path.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    /// Sets the string value `name` (empty: the default) of
    /// `HKEY_CURRENT_USER\path`, creating the key.
    pub fn write_string(path: &str, name: &str, data: &str) -> io::Result<()> {
        let (path, name, data) = (wide(path), wide(name), wide(data));
        let mut key: HKEY = ptr::null_mut();
        // SAFETY: valid strings and an out pointer.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(error(status));
        }
        // SAFETY: `data` is NUL-terminated UTF-16 of the length given.
        let status = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        };
        // SAFETY: the key was created above.
        unsafe { RegCloseKey(key) };
        match status {
            ERROR_SUCCESS => Ok(()),
            ERROR_FILE_NOT_FOUND => Err(io::Error::from(io::ErrorKind::NotFound)),
            status => Err(error(status)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_drop_the_verbatim_prefix() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\Users\a\agent-relay-desktop.exe")),
            PathBuf::from(r"C:\Users\a\agent-relay-desktop.exe")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\server\share\agent-relay-desktop.exe")),
            PathBuf::from(r"\\server\share\agent-relay-desktop.exe")
        );
        assert_eq!(plain(Path::new(r"C:\x")), PathBuf::from(r"C:\x"));
    }

    #[test]
    fn the_per_user_root_is_found_case_insensitively() {
        assert_eq!(
            per_user_root_of(Path::new(
                r"C:\Users\a\AppData\Local\programs\agentrelay\1.0.0\AgentRelay-Windows-x64\bin\agent-relay-desktop.exe"
            )),
            Some(PathBuf::from(
                r"C:\Users\a\AppData\Local\programs\agentrelay"
            ))
        );
        assert_eq!(
            per_user_root_of(Path::new(r"C:\src\target\debug\agent-relay-desktop.exe")),
            None
        );
        let env = |name: &str| (name == "LOCALAPPDATA").then(|| OsString::from(r"D:\Local"));
        assert_eq!(
            local_app_data(&env, Path::new(r"C:\Users\a")),
            PathBuf::from(r"D:\Local")
        );
        let relative = |_: &str| Some(OsString::from("Local"));
        assert_eq!(
            app_data(&relative, Path::new(r"C:\Users\a")),
            PathBuf::from(r"C:\Users\a\AppData\Roaming")
        );
    }

    #[test]
    fn the_protocol_key_opens_links_in_the_app() {
        let exe = Path::new(
            r"C:\Users\a b\AppData\Local\Programs\AgentRelay\1.0.0\AgentRelay-Windows-x64\bin\agent-relay-desktop.exe",
        );
        let entries = protocol_entries(exe);
        assert_eq!(
            entries[0],
            (PROTOCOL_KEY.into(), String::new(), "URL:Agent Relay".into())
        );
        assert_eq!(
            entries[1],
            (PROTOCOL_KEY.into(), "URL Protocol".into(), String::new())
        );
        assert_eq!(
            entries[3],
            (
                r"Software\Classes\agentrelay\shell\open\command".into(),
                String::new(),
                format!("\"{}\" \"%1\"", exe.display())
            )
        );
        assert_eq!(command_program(&entries[3].2), Some(exe.to_str().unwrap()));
        assert_eq!(command_program(r"C:\x.exe %1"), Some(r"C:\x.exe"));
        assert_eq!(command_program(""), None);
    }

    #[test]
    fn arguments_are_quoted_as_windows_parses_them() {
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("a b"), "\"a b\"");
        assert_eq!(quote_argument(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(quote_argument(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_argument(""), "\"\"");
    }
}
