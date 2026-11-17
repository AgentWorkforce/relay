//! The repositories whose sessions join the relay by themselves
//! (`auto_join_repositories`): which repository a session works in, read
//! from its directory's git `origin` remote, and whether a list names it.
//!
//! A repository is named `owner/name`, lower-cased, from the `origin` URL in
//! any form git takes (`https://host/owner/name.git`,
//! `git@host:owner/name.git`, `ssh://git@host:22/owner/name`): the host is
//! dropped and so is a trailing `.git`. An entry is `owner/name` or `owner/*`
//! for every repository of that owner. Only the remote is compared: a local
//! path never matches, and the full URL, host and directory never leave this
//! computer; only the matched `owner/name` does.

use std::path::{Path, PathBuf};

/// The setting: the list of `owner/name` and `owner/*` entries.
pub const SETTING: &str = "auto_join_repositories";

/// The most entries a list keeps.
pub const MAX_ENTRIES: usize = 200;

/// The largest git config read; a real one is far smaller.
const MAX_CONFIG_BYTES: u64 = 256 * 1024;

/// How many directories up a session's directory is searched for `.git`.
const MAX_DEPTH: usize = 64;

/// Whether `part` is an owner or repository name an entry may hold.
fn valid_part(part: &str) -> bool {
    (1..=100).contains(&part.len())
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        && part != "."
        && part != ".."
}

/// `entry` as the list keeps it (`owner/name` or `owner/*`, lower-cased), or
/// `None` when it is neither.
pub fn entry(entry: &str) -> Option<String> {
    let entry = entry.trim().to_ascii_lowercase();
    let (owner, name) = entry.split_once('/')?;
    (valid_part(owner) && (name == "*" || valid_part(name))).then_some(entry)
}

/// The list `entries` would be saved as: each entry normalized, duplicates
/// collapsed, in the order given; an error names the first entry that is
/// not `owner/name` or `owner/*`, or a list that is too long.
pub fn list(entries: &[String]) -> Result<Vec<String>, String> {
    if entries.len() > MAX_ENTRIES {
        return Err(format!("{SETTING} holds at most {MAX_ENTRIES} entries."));
    }
    let mut kept: Vec<String> = Vec::new();
    for raw in entries {
        let Some(entry) = entry(raw) else {
            return Err(format!(
                "{SETTING} entries are owner/name or owner/*, not {raw:?}."
            ));
        };
        if !kept.contains(&entry) {
            kept.push(entry);
        }
    }
    Ok(kept)
}

/// The `owner/name` a remote URL names, lower-cased; `None` for a local
/// path or a URL that does not end in an owner and a name.
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") || scheme.is_empty() {
            return None;
        }
        // Drop the authority (user, host, port); keep the path.
        let (_, path) = rest.split_once('/')?;
        path
    } else {
        // scp-like `[user@]host:path`, which needs a colon before any slash.
        let colon = url.find(':')?;
        if url[..colon].contains('/') || colon == 0 {
            return None;
        }
        // A Windows drive (`C:\…`, or `C:/…` on Windows) is a local path;
        // elsewhere a one-letter host is an SSH alias (`g:acme/web`).
        let drive = colon == 1
            && url[..1].chars().all(|c| c.is_ascii_alphabetic())
            && (cfg!(windows) || url[2..].starts_with('\\'));
        if drive {
            return None;
        }
        &url[colon + 1..]
    };
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    let mut parts = path.rsplit('/');
    let name = parts.next()?;
    let owner = parts.next()?;
    let name = name.to_ascii_lowercase();
    let owner = owner.to_ascii_lowercase();
    (valid_part(&owner) && valid_part(&name)).then(|| format!("{owner}/{name}"))
}

/// The git directories of the work tree that contains `directory`: its own
/// (`.git`, or a linked work tree's `.git/worktrees/<name>`) and the one
/// holding the shared config (the main repository's, through `commondir`).
fn git_dirs(directory: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = Some(directory);
    for _ in 0..MAX_DEPTH {
        let here = current?;
        let dot_git = here.join(".git");
        if dot_git.is_dir() {
            return Some((dot_git.clone(), dot_git));
        }
        if dot_git.is_file() {
            let text = read_small(&dot_git)?;
            let pointed = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
            let own = here.join(pointed);
            let common = read_small(&own.join("commondir"))
                .map(|c| own.join(c.trim()))
                .unwrap_or_else(|| own.clone());
            return Some((own, common));
        }
        current = here.parent();
    }
    None
}

/// How deep `include` and `includeIf` files are followed, as git limits it.
const MAX_INCLUDE_DEPTH: usize = 10;

/// The person's home directory.
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Whether `text` matches the wildcard `pattern`: `**` crosses `/`, `*` and
/// `?` do not.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match pattern {
        [] => text.is_empty(),
        // `**/` is zero or more whole directories: what follows starts at
        // the beginning or right after a `/`, never inside a name.
        [b'*', b'*', b'/', rest @ ..] => {
            glob(rest, text)
                || (0..text.len()).any(|at| text[at] == b'/' && glob(rest, &text[at + 1..]))
        }
        // A `**` that ends the pattern (or a `/**`) is anything.
        [b'*', b'*', rest @ ..] => (0..=text.len()).any(|at| glob(rest, &text[at..])),
        [b'*', rest @ ..] => (0..=text.len())
            .take_while(|&at| at == 0 || text[at - 1] != b'/')
            .any(|at| glob(rest, &text[at..])),
        [b'?', rest @ ..] => text.first().is_some_and(|c| *c != b'/') && glob(rest, &text[1..]),
        [c, rest @ ..] => text.first() == Some(c) && glob(rest, &text[1..]),
    }
}

/// Whether an `includeIf` condition holds for the repository at `git_dir`:
/// `gitdir:` and `gitdir/i:` as git reads them; any other condition
/// (`onbranch:`, `hasconfig:`) is taken as not holding.
fn include_applies(condition: &str, git_dir: Option<&Path>, including: &Path) -> bool {
    let (pattern, fold) = if let Some(p) = condition.strip_prefix("gitdir/i:") {
        (p, true)
    } else if let Some(p) = condition.strip_prefix("gitdir:") {
        (p, false)
    } else {
        return false;
    };
    let Some(git_dir) = git_dir else {
        return false;
    };
    let mut pattern = if let Some(rest) = pattern.strip_prefix("~/") {
        match home() {
            Some(home) => format!("{}/{rest}", home.display()),
            None => return false,
        }
    } else if let Some(rest) = pattern.strip_prefix("./") {
        format!(
            "{}/{rest}",
            including.parent().unwrap_or(Path::new("")).display()
        )
    } else if pattern.starts_with('/') {
        pattern.to_string()
    } else {
        format!("**/{pattern}")
    };
    if pattern.ends_with('/') {
        pattern.push_str("**");
    }
    let mut text = git_dir.display().to_string();
    if !text.ends_with('/') {
        text.push('/');
    }
    let (pattern, text) = if fold {
        (pattern.to_lowercase(), text.to_lowercase())
    } else {
        (pattern, text)
    };
    glob(pattern.as_bytes(), text.as_bytes())
        || glob(pattern.as_bytes(), text.trim_end_matches('/').as_bytes())
}

/// The config at `path` with its `include` and applicable `includeIf` files
/// put in where git reads them, as one text.
/// What one repository lookup may read through `include` files: a bound on
/// files and bytes shared by every config of the lookup, so a config that
/// includes itself or fans out cannot stall it. Spending past it fails the
/// lookup (no repository, so nothing is forced or labelled).
pub(crate) struct Budget {
    files: usize,
    bytes: usize,
}

impl Budget {
    /// The bound for one lookup.
    pub(crate) fn new() -> Budget {
        Budget {
            files: MAX_INCLUDE_FILES,
            bytes: MAX_INCLUDE_BYTES,
        }
    }

    /// Takes one file of `len` bytes from the budget; `false` when it is spent.
    fn take(&mut self, len: usize) -> bool {
        if self.files == 0 || len > self.bytes {
            self.files = 0;
            return false;
        }
        self.files -= 1;
        self.bytes -= len;
        true
    }
}

/// The most config files one lookup reads, includes counted.
const MAX_INCLUDE_FILES: usize = 64;
/// The most config text one lookup reads, includes counted.
const MAX_INCLUDE_BYTES: usize = 1024 * 1024;

fn expanded(path: &Path, git_dir: Option<&Path>, budget: &mut Budget) -> Option<String> {
    let mut chain = Vec::new();
    expanded_in(path, git_dir, budget, &mut chain, 0)
}

/// [`expanded`], within the files already being expanded (`chain`): a file
/// that includes itself, directly or through others, fails the lookup.
fn expanded_in(
    path: &Path,
    git_dir: Option<&Path>,
    budget: &mut Budget,
    chain: &mut Vec<PathBuf>,
    depth: usize,
) -> Option<String> {
    let text = read_small(path)?;
    if !budget.take(text.len()) {
        return None;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if chain.contains(&canonical) || depth >= MAX_INCLUDE_DEPTH {
        budget.files = 0;
        return None;
    }
    chain.push(canonical);
    let mut out = String::new();
    let mut header = String::new();
    let mut include: Option<Option<String>> = None;
    for line in text.lines() {
        out.push_str(line);
        out.push('\n');
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            header = trimmed.to_string();
            include = None;
            if let Some((section, sub, _, _)) = config_entries(&format!("{trimmed}\nx=y\n"))
                .into_iter()
                .next()
            {
                if section == "include" && sub.is_none() {
                    include = Some(None);
                } else if section == "includeif" {
                    include = Some(sub);
                }
            }
            continue;
        }
        let Some(condition) = include.as_ref() else {
            continue;
        };
        let Some((_, _, key, value)) = config_entries(&format!("[x]\n{trimmed}\n"))
            .into_iter()
            .next()
        else {
            continue;
        };
        if key != "path" {
            continue;
        }
        if let Some(condition) = condition {
            if !include_applies(condition, git_dir, path) {
                continue;
            }
        }
        let target = match value.strip_prefix("~/") {
            Some(rest) => match home() {
                Some(home) => home.join(rest),
                None => continue,
            },
            None => path.parent().unwrap_or(Path::new("")).join(&value),
        };
        let included = expanded_in(&target, git_dir, budget, chain, depth + 1);
        if budget.files == 0 {
            chain.pop();
            return None;
        }
        if let Some(included) = included {
            out.push_str(&included);
            out.push('\n');
            // What follows the include line is still in this section.
            out.push_str(&header);
            out.push('\n');
        }
    }
    chain.pop();
    Some(out)
}

fn read_small(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(MAX_CONFIG_BYTES).read_to_string(&mut text).ok()?;
    Some(text)
}

/// A git config value as git reads it: quotes removed, a `#` or `;`
/// outside quotes starts a comment, and `\"` / `\\` are escapes.
fn config_value(raw: &str) -> String {
    let mut value = String::new();
    let mut quoted = false;
    let mut chars = raw.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' => {
                if let Some(next) = chars.next() {
                    value.push(match next {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                }
            }
            '#' | ';' if !quoted => break,
            other => value.push(other),
        }
    }
    value.trim_end().to_string()
}

/// Each `key = value` of a git config's text, with its section and
/// subsection (`[remote "origin"]` is `("remote", Some("origin"))`); keys and
/// section names lower-cased, as git compares them.
fn config_entries(config: &str) -> Vec<(String, Option<String>, String, String)> {
    let mut entries = Vec::new();
    let (mut section, mut subsection) = (String::new(), None::<String>);
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[') {
            let header = header.split(']').next().unwrap_or_default().trim();
            match header.split_once(char::is_whitespace) {
                Some((name, sub)) => {
                    section = name.to_ascii_lowercase();
                    subsection = Some(sub.trim().trim_matches('"').to_string());
                }
                None => {
                    // `[remote.origin]` is the old spelling of a subsection.
                    match header.split_once('.') {
                        Some((name, sub)) => {
                            section = name.to_ascii_lowercase();
                            subsection = Some(sub.to_string());
                        }
                        None => {
                            section = header.to_ascii_lowercase();
                            subsection = None;
                        }
                    }
                }
            }
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            entries.push((
                section.clone(),
                subsection.clone(),
                key.trim().to_ascii_lowercase(),
                config_value(value),
            ));
        }
    }
    entries
}

/// The `url` of `[remote "origin"]` in git configs' texts, read in order:
/// the last one set wins, as in git.
fn origin_url(config: &str) -> Option<String> {
    config_entries(config)
        .into_iter()
        .rev()
        .find(|(section, sub, key, _)| {
            section == "remote" && sub.as_deref() == Some("origin") && key == "url"
        })
        .map(|(_, _, _, value)| value)
}

/// `url` after git's `url.<base>.insteadOf` rewrites in `configs`: the
/// longest matching prefix is replaced by its base, as git does.
fn rewritten(url: &str, configs: &[String]) -> String {
    let mut best: Option<(String, String)> = None;
    for config in configs {
        for (section, base, key, prefix) in config_entries(config) {
            let Some(base) = base else { continue };
            if section != "url" || key != "insteadof" || prefix.is_empty() {
                continue;
            }
            if url.starts_with(&prefix) && best.as_ref().is_none_or(|(p, _)| prefix.len() > p.len())
            {
                best = Some((prefix, base));
            }
        }
    }
    match best {
        Some((prefix, base)) => format!("{base}{}", &url[prefix.len()..]),
        None => url.to_string(),
    }
}

/// The person's own git configs, which hold `insteadOf` rewrites as often as
/// a repository's does: `$XDG_CONFIG_HOME/git/config` (or
/// `~/.config/git/config`) and `~/.gitconfig`.
fn global_configs(git_dir: Option<&Path>, budget: &mut Budget) -> Vec<String> {
    let home = home();
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".config")));
    [
        xdg.map(|x| x.join("git/config")),
        home.map(|h| h.join(".gitconfig")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|path| expanded(&path, git_dir, budget))
    .collect()
}

/// The `owner/name` of the repository `directory` is in, from its `origin`
/// remote; `None` outside a repository or without a hosted origin.
pub fn repository_of(directory: &Path) -> Option<String> {
    // A directory reached through a link is looked up where it really is.
    let directory = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    let (own, common) = git_dirs(&directory)?;
    // In git's order, each later file overriding the earlier ones: the
    // person's, the repository's, and the work tree's own when the
    // repository enables per-work-tree config.
    // `includeIf "gitdir:"` is matched against the work tree's own git
    // directory (`.git/worktrees/<name>` for a linked one), as git does.
    let mut budget = Budget::new();
    let mut configs = global_configs(Some(&own), &mut budget);
    let shared = expanded(&common.join("config"), Some(&own), &mut budget)?;
    let per_tree = config_entries(&shared)
        .into_iter()
        .any(|(section, sub, key, value)| {
            section == "extensions"
                && sub.is_none()
                && key == "worktreeconfig"
                && matches!(
                    value.to_ascii_lowercase().as_str(),
                    "true" | "yes" | "on" | "1"
                )
        });
    configs.push(shared);
    if per_tree {
        if let Some(tree) = expanded(&own.join("config.worktree"), Some(&own), &mut budget) {
            configs.push(tree);
        }
    }
    if budget.files == 0 {
        return None;
    }
    let origin = origin_url(&configs.concat())?;
    normalize_remote(&rewritten(&origin, &configs))
}

/// The entry of `entries` that names `repository`, if one does.
pub fn matches(entries: &[String], repository: &str) -> bool {
    let Some((owner, _)) = repository.split_once('/') else {
        return false;
    };
    entries.iter().any(|entry| {
        entry == repository || entry.strip_suffix("/*").is_some_and(|wild| wild == owner)
    })
}

/// The `owner/name` of the repository `directory` is in, when `entries`
/// names it.
pub fn matched(entries: &[String], directory: Option<&str>) -> Option<String> {
    if entries.is_empty() {
        return None;
    }
    let repository = repository_of(Path::new(directory?))?;
    matches(entries, &repository).then_some(repository)
}

/// The list a policy locks `auto_join_repositories` to, as the setting saves
/// it; `None` when it locks none, or a value that is not a valid list (which
/// then forces nothing).
pub(crate) fn locked_list(
    policy: &crate::relay::settings_policy::SettingsPolicy,
) -> Option<Vec<String>> {
    let value = policy.locked.get(SETTING)?;
    let entries: Vec<String> = serde_json::from_value(value.clone()).ok()?;
    list(&entries).ok()
}

impl crate::relay::daemon::Core {
    /// The person's `auto_join_repositories`, as saved.
    pub fn auto_join_repositories(&self) -> Vec<String> {
        self.store
            .read(|store| store.auto_join_repositories.clone())
            .unwrap_or_default()
    }

    /// The repositories whose sessions join the relay even with automatic
    /// activation off: the list, while the organization locks it
    /// (`settings_policy`). A list the person holds, given or defaulted,
    /// adds no activation: its sessions follow automatic activation.
    pub fn forced_repositories(&self) -> Vec<String> {
        self.settings_policy()
            .and_then(|policy| locked_list(&policy))
            .unwrap_or_default()
    }

    /// The `owner/name` a session in `directory` names in its registration:
    /// the repository it is in, when the list names it.
    pub fn repository_label(&self, directory: Option<&str>) -> Option<String> {
        matched(&self.auto_join_repositories(), directory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_in_every_form_name_owner_and_repository() {
        for url in [
            "https://github.com/Acme/Web.git",
            "https://github.com/acme/web",
            "https://user:pw@git.example.com:8443/acme/web.git/",
            "git@github.com:acme/web.git",
            "ssh://git@github.com:22/acme/web",
            "git://example.com/acme/web.git",
            "https://gitlab.example.com/group/acme/web.git",
        ] {
            assert_eq!(normalize_remote(url).as_deref(), Some("acme/web"), "{url}");
        }
        for url in [
            "/home/me/src/web",
            "../web",
            "file:///srv/git/acme/web.git",
            "C:\\src\\acme\\web",
            "https://github.com/web",
            "",
        ] {
            assert_eq!(normalize_remote(url), None, "{url}");
        }
        // On Windows a drive with a forward slash is a local path too.
        #[cfg(windows)]
        assert_eq!(normalize_remote("C:/src/acme/web"), None);
    }

    #[test]
    fn include_if_matches_the_git_directory() {
        let including = Path::new("/home/me/.gitconfig");
        let git = Path::new("/home/me/work/acme/web/.git");
        assert!(include_applies(
            "gitdir:/home/me/work/",
            Some(git),
            including
        ));
        assert!(include_applies("gitdir:work/acme/", Some(git), including));
        assert!(include_applies(
            "gitdir/i:/HOME/ME/WORK/",
            Some(git),
            including
        ));
        assert!(!include_applies(
            "gitdir:/home/me/play/",
            Some(git),
            including
        ));
        assert!(!include_applies("onbranch:main", Some(git), including));
        // A relative pattern matches whole directories only, as in git.
        let elsewhere = Path::new("/home/me/notwork/acme/web/.git");
        assert!(!include_applies("gitdir:work/", Some(elsewhere), including));
        assert!(include_applies(
            "gitdir:work/",
            Some(Path::new("/work/acme/.git")),
            including
        ));
        assert!(glob(b"/a/**/c/", b"/a/b/x/c/"));
        assert!(glob(b"**/work/**", b"/home/work/x"));
        assert!(!glob(b"**/work/**", b"/home/notwork/x"));
        assert!(glob(b"/a/*/c", b"/a/b/c"));
        assert!(!glob(b"/a/*/c", b"/a/b/x/c"));
    }

    /// Git's own reading of a config: comments, quotes, the old subsection
    /// spelling, and `insteadOf` rewrites.
    #[test]
    fn the_origin_is_read_as_git_reads_it() {
        assert_eq!(
            origin_url(
                "[remote \"origin\"]\n\turl = https://github.com/acme/web.git # company repo\n"
            )
            .as_deref(),
            Some("https://github.com/acme/web.git")
        );
        assert_eq!(
            origin_url("[remote \"origin\"]\n\turl = \"git@github.com:acme/web#1.git\" ; note\n")
                .as_deref(),
            Some("git@github.com:acme/web#1.git")
        );
        assert_eq!(
            origin_url("[remote.origin]\nurl=gh:acme/web\n").as_deref(),
            Some("gh:acme/web")
        );
        let global = "[url \"https://github.com/\"]\n\tinsteadOf = gh:\n[url \"https://git.example.com/\"]\n\tinsteadOf = g\n".to_string();
        assert_eq!(
            rewritten("gh:Acme/Web", std::slice::from_ref(&global)),
            "https://github.com/Acme/Web"
        );
        assert_eq!(rewritten("other:acme/web", &[global]), "other:acme/web");
        // A one-letter SSH alias is a host, not a drive, outside Windows.
        #[cfg(not(windows))]
        assert_eq!(
            normalize_remote("g:acme/web.git").as_deref(),
            Some("acme/web")
        );
    }

    #[test]
    fn entries_are_owner_and_name_or_owner_wildcard() {
        assert_eq!(entry(" Acme/Web ").as_deref(), Some("acme/web"));
        assert_eq!(entry("acme/*").as_deref(), Some("acme/*"));
        for bad in [
            "acme",
            "acme/",
            "/web",
            "*/web",
            "acme/web/x",
            "ac me/web",
            "../web",
        ] {
            assert_eq!(entry(bad), None, "{bad}");
        }
        let kept = list(&["Acme/Web".into(), "acme/web".into(), "acme/*".into()]).unwrap();
        assert_eq!(kept, vec!["acme/web", "acme/*"]);
        assert!(list(&["acme".into()]).is_err());
        assert!(list(&vec!["a/b".to_string(); MAX_ENTRIES + 1]).is_err());
    }

    #[test]
    fn a_list_matches_by_name_or_owner() {
        let entries = vec!["acme/web".to_string(), "tools/*".to_string()];
        assert!(matches(&entries, "acme/web"));
        assert!(matches(&entries, "tools/anything"));
        assert!(!matches(&entries, "acme/api"));
        assert!(!matches(&entries, "toolsx/web"));
    }

    fn repo(root: &Path, url: &str) {
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(
            root.join(".git/config"),
            format!("[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@x:other/thing\n[remote \"origin\"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"),
        )
        .unwrap();
    }

    #[test]
    fn a_directory_is_read_from_its_origin_remote() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("web");
        repo(&root, "git@github.com:Acme/Web.git");
        let nested = root.join("src/app");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(repository_of(&nested).as_deref(), Some("acme/web"));
        let entries = vec!["acme/*".to_string()];
        assert_eq!(
            matched(&entries, nested.to_str()).as_deref(),
            Some("acme/web")
        );
        assert_eq!(matched(&[], nested.to_str()), None);
        assert_eq!(matched(&entries, temp.path().to_str()), None);
        // A linked work tree reads the main repository's config.
        let main_git = root.join(".git");
        let linked = temp.path().join("web-feature");
        let admin = main_git.join("worktrees/web-feature");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("acme/web"));
        // A directory reached through a link is read where it really is.
        #[cfg(unix)]
        {
            let link = temp.path().join("link-to-app");
            std::os::unix::fs::symlink(&nested, &link).unwrap();
            assert_eq!(repository_of(&link).as_deref(), Some("acme/web"));
        }
        // A work tree with its own config, when the repository enables it,
        // names its own origin.
        std::fs::write(
            main_git.join("config"),
            "[extensions]\n\tworktreeConfig = true\n[remote \"origin\"]\n\turl = git@github.com:Acme/Web.git\n",
        )
        .unwrap();
        std::fs::write(
            admin.join("config.worktree"),
            "[remote \"origin\"]\n\turl = git@github.com:me/web-fork.git\n",
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("me/web-fork"));
        assert_eq!(repository_of(&nested).as_deref(), Some("acme/web"));
        // An included file can name the origin.
        let included = temp.path().join("inc");
        repo(&included, "unused");
        std::fs::write(
            included.join(".git/remote.inc"),
            "[remote \"origin\"]\n\turl = https://github.com/acme/api\n",
        )
        .unwrap();
        std::fs::write(
            included.join(".git/config"),
            "[include]\n\tpath = remote.inc\n",
        )
        .unwrap();
        assert_eq!(repository_of(&included).as_deref(), Some("acme/api"));
        // An includeIf scoped to a linked work tree's own git directory
        // applies to that work tree only.
        std::fs::write(
            main_git.join("config"),
            format!(
                "[remote \"origin\"]\n\turl = git@github.com:Acme/Web.git\n[includeIf \"gitdir:{}/\"]\n\tpath = fork.inc\n",
                admin.display()
            ),
        )
        .unwrap();
        std::fs::write(
            main_git.join("fork.inc"),
            "[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n",
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("me/fork"));
        assert_eq!(repository_of(&nested).as_deref(), Some("acme/web"));
        // A config that includes itself, or fans out past the budget, names
        // no repository rather than stalling the lookup.
        let looping = temp.path().join("loop");
        repo(&looping, "https://github.com/acme/loop");
        let config = looping.join(".git/config");
        let text = std::fs::read_to_string(&config).unwrap();
        std::fs::write(&config, format!("{text}[include]\n\tpath = config\n")).unwrap();
        assert_eq!(repository_of(&looping), None);
        let fanning = temp.path().join("fan");
        repo(&fanning, "https://github.com/acme/fan");
        std::fs::write(
            fanning.join(".git/a.inc"),
            "[include]\n".to_string() + &"\tpath = b.inc\n".repeat(10),
        )
        .unwrap();
        std::fs::write(
            fanning.join(".git/b.inc"),
            "[include]\n".to_string() + &"\tpath = c.inc\n".repeat(10),
        )
        .unwrap();
        std::fs::write(fanning.join(".git/c.inc"), "[x]\n\ty = 1\n").unwrap();
        let config = fanning.join(".git/config");
        let text = std::fs::read_to_string(&config).unwrap();
        std::fs::write(&config, format!("{text}[include]\n\tpath = a.inc\n")).unwrap();
        assert_eq!(repository_of(&fanning), None);
        // A local-path origin names no repository.
        let local = temp.path().join("local");
        repo(&local, "/srv/git/web.git");
        assert_eq!(repository_of(&local), None);
    }
}
