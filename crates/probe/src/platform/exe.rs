//! Finding a command the way a shell would.
//!
//! On Unix a command is a file named exactly `name` with an execute bit. On
//! Windows it is `name` plus one of the `PATHEXT` extensions: npm installs
//! its command-line tools as `claude.cmd` and `codex.cmd` beside a
//! POSIX-shell script of the bare name, which Windows cannot run, so the
//! bare name is never taken there. Rust runs a `.cmd` or `.bat` through
//! `cmd.exe` with its arguments escaped for it, and refuses arguments it
//! cannot escape safely.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// `PATHEXT` when the environment does not set it: Windows' own default
/// minus the scripting hosts nothing here runs.
#[cfg_attr(not(windows), allow(dead_code))]
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// The extensions Windows runs, lowercased with their dot, from `pathext`
/// (the `PATHEXT` value, `None` for the default).
#[cfg_attr(not(windows), allow(dead_code))]
fn extensions(pathext: Option<&str>) -> Vec<String> {
    let found: Vec<String> = pathext
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(str::trim)
        .filter(|extension| extension.len() > 1 && extension.starts_with('.'))
        .map(str::to_ascii_lowercase)
        .collect();
    if found.is_empty() {
        extensions(Some(DEFAULT_PATHEXT))
    } else {
        found
    }
}

/// The file names `name` may have on disk, in the order a shell tries them:
/// `name` itself on Unix; on Windows `name` when it already ends in a
/// `PATHEXT` extension, else `name` plus each extension.
pub fn command_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        command_names_with(name, std::env::var("PATHEXT").ok().as_deref())
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

/// `command_names` on Windows with `pathext` as `PATHEXT`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn command_names_with(name: &str, pathext: Option<&str>) -> Vec<String> {
    let extensions = extensions(pathext);
    let lowered = name.to_ascii_lowercase();
    if extensions
        .iter()
        .any(|extension| lowered.ends_with(extension.as_str()))
    {
        return vec![name.to_string()];
    }
    extensions
        .iter()
        .map(|extension| format!("{name}{extension}"))
        .collect()
}

/// Whether `path` is a file this user can run: an execute bit on Unix; on
/// Windows a `PATHEXT` extension.
pub fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        has_run_extension(path, std::env::var("PATHEXT").ok().as_deref())
    }
}

/// Whether `path` ends in one of `pathext`'s extensions.
#[cfg_attr(not(windows), allow(dead_code))]
fn has_run_extension(path: &Path, pathext: Option<&str>) -> bool {
    path.extension().is_some_and(|extension| {
        let extension = format!(".{}", extension.to_string_lossy().to_ascii_lowercase());
        extensions(pathext).contains(&extension)
    })
}

/// The first runnable `name` in `directories`, trying each of
/// `command_names` in each directory before the next.
pub fn find_in<I, P>(directories: I, name: &str) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let names = command_names(name);
    directories.into_iter().find_map(|directory| {
        names
            .iter()
            .map(|candidate| directory.as_ref().join(candidate))
            .find(|candidate| is_executable(candidate))
    })
}

/// The first runnable `name` on `path` (a `PATH` value).
pub fn find_on(path: &OsStr, name: &str) -> Option<PathBuf> {
    find_in(std::env::split_paths(path), name)
}

/// The first runnable `name` on this process's `PATH`.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    find_on(&std::env::var_os("PATH")?, name)
}

/// `path` as a runnable file: itself when it is one, else on Windows the
/// first of `command_names` beside it (`~/.local/bin/claude` names
/// `claude.exe` there).
pub fn runnable(path: &Path) -> Option<PathBuf> {
    if is_executable(path) {
        return Some(path.to_path_buf());
    }
    let name = path.file_name()?.to_str()?;
    let directory = path.parent()?;
    command_names(name)
        .into_iter()
        .map(|candidate| directory.join(candidate))
        .find(|candidate| is_executable(candidate))
}

/// Whether `path` names the command `name` (`codex`, `claude`): its file
/// name is `name`, or on Windows `name` plus a `PATHEXT` extension, in any
/// case.
pub fn names_command(path: &Path, name: &str) -> bool {
    let Some(file) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    #[cfg(windows)]
    {
        command_names(name)
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(file))
    }
    #[cfg(not(windows))]
    {
        file == name
    }
}

/// What an npm command shim (`claude.cmd`, written by npm's `cmd-shim`)
/// runs: the program and the arguments it puts before the caller's (`%*`).
/// `node` comes from `node.exe` beside the shim, as the shim prefers, else
/// from `path` (the `PATH` the program will run with). `None` when `shim`
/// is not a `.cmd` or `.bat` file or not one npm wrote.
///
/// Started through its shim, a program runs as a child of `cmd.exe`, whose
/// pid is the one the launch reports; started this way it is the program
/// itself, as on Unix.
pub fn shim_target(shim: &Path, path: Option<&OsStr>) -> Option<(PathBuf, Vec<String>)> {
    let extension = shim.extension()?.to_str()?.to_ascii_lowercase();
    if extension != "cmd" && extension != "bat" {
        return None;
    }
    let text = std::fs::read_to_string(shim).ok()?;
    let directory = shim.parent()?;
    let line = text.lines().rev().find(|line| line.contains("%*"))?;
    let line = &line[..line.find("%*")?];
    // The quoted words before `%*`, in order.
    let words: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
    let expand = |word: &str| -> Option<PathBuf> {
        let rest = word
            .strip_prefix("%dp0%")
            .or_else(|| word.strip_prefix("%~dp0"))?;
        let mut target = directory.to_path_buf();
        for part in rest.split(['\\', '/']).filter(|part| !part.is_empty()) {
            target.push(part);
        }
        Some(target)
    };
    let (program, rest) = match words.iter().position(|word| *word == "%_prog%") {
        Some(at) => {
            let beside = directory.join("node.exe");
            let node = if beside.is_file() {
                beside
            } else {
                find_in(std::env::split_paths(path?), "node")?
            };
            (node, &words[at + 1..])
        }
        None => {
            let (first, rest) = words.split_first()?;
            (expand(first)?, rest)
        }
    };
    if !program.is_file() {
        return None;
    }
    let arguments = rest
        .iter()
        .map(|word| expand(word).map(|path| path.to_string_lossy().into_owned()))
        .collect::<Option<Vec<String>>>()?;
    if arguments
        .iter()
        .any(|argument| !Path::new(argument).is_file())
    {
        return None;
    }
    Some((program, arguments))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// npm's `cmd-shim` output for a JavaScript entry point.
    const NODE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";

    // The shim and its paths are Windows' own.
    #[cfg(windows)]
    #[test]
    fn an_npm_shim_runs_its_script_with_node() {
        let folder = tempfile::tempdir().unwrap();
        let npm = folder.path().join("npm");
        let script = npm.join(r"node_modules\@anthropic-ai\claude-code\cli.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "").unwrap();
        let shim = npm.join("claude.cmd");
        std::fs::write(&shim, NODE_SHIM).unwrap();
        let tools = folder.path().join("nodejs");
        std::fs::create_dir_all(&tools).unwrap();
        let node = tools.join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = std::env::join_paths([&tools]).unwrap();
        let (program, arguments) = shim_target(&shim, Some(&path)).unwrap();
        assert_eq!(program, node);
        assert_eq!(arguments, [script.to_string_lossy().into_owned()]);
        // Without node anywhere it cannot be resolved.
        assert_eq!(shim_target(&shim, None), None);
        // node.exe beside the shim comes first.
        std::fs::write(npm.join("node.exe"), "").unwrap();
        assert_eq!(
            shim_target(&shim, Some(&path)).unwrap().0,
            npm.join("node.exe")
        );
        // A script that is gone, or a file that is no shim, is not resolved.
        std::fs::remove_file(&script).unwrap();
        assert_eq!(shim_target(&shim, Some(&path)), None);
        std::fs::write(npm.join("other.cmd"), "@echo off\r\necho hi\r\n").unwrap();
        assert_eq!(shim_target(&npm.join("other.cmd"), Some(&path)), None);
        assert_eq!(shim_target(&script, Some(&path)), None);
    }

    // The shim and its paths are Windows' own.
    #[cfg(windows)]
    #[test]
    fn an_npm_shim_of_a_native_program_runs_it_directly() {
        let folder = tempfile::tempdir().unwrap();
        let exe = folder
            .path()
            .join(r"node_modules\@anthropic-ai\claude-code\bin\claude.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "MZ").unwrap();
        let shim = folder.path().join("claude.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n",
        )
        .unwrap();
        assert_eq!(shim_target(&shim, None), Some((exe, Vec::new())));
    }

    #[test]
    fn pathext_names_follow_the_shell_order() {
        assert_eq!(
            command_names_with("claude", Some(".COM;.EXE;.BAT;.CMD;.VBS")),
            [
                "claude.com",
                "claude.exe",
                "claude.bat",
                "claude.cmd",
                "claude.vbs"
            ]
        );
        assert_eq!(
            command_names_with("codex", None),
            ["codex.com", "codex.exe", "codex.bat", "codex.cmd"]
        );
        // A name that already has a runnable extension is taken as is.
        assert_eq!(command_names_with("codex.CMD", None), ["codex.CMD"]);
        // An empty or malformed PATHEXT falls back to the default.
        assert_eq!(command_names_with("pi", Some(";;exe")).len(), 4);
    }

    #[test]
    fn a_run_extension_is_matched_in_any_case() {
        assert!(has_run_extension(Path::new(r"C:\npm\claude.CMD"), None));
        assert!(has_run_extension(Path::new("codex.exe"), Some(".EXE")));
        assert!(!has_run_extension(Path::new("codex"), None));
        assert!(!has_run_extension(Path::new("codex.ps1"), None));
    }

    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_is_found_and_its_bare_script_is_not() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join("codex"), "#!/bin/sh\n").unwrap();
        std::fs::write(folder.path().join("codex.cmd"), "@echo off\r\n").unwrap();
        let found = find_in([folder.path()], "codex").unwrap();
        assert!(found
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with("codex.cmd"));
        assert_eq!(runnable(&folder.path().join("codex")), Some(found.clone()));
        assert!(names_command(&found, "codex"));
        assert!(!names_command(
            &folder.path().join("codex-helper.exe"),
            "codex"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_unix_command_needs_its_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let script = folder.path().join("codex");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        assert_eq!(find_in([folder.path()], "codex"), None);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_in([folder.path()], "codex"), Some(script.clone()));
        assert!(names_command(&script, "codex"));
    }
}
