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
            // `includeIf "gitdir:"` is matched against the directory itself,
            // so `..` in a relative `gitdir:` is resolved first.
            let own = std::fs::canonicalize(&own).unwrap_or(own);
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

/// The longest `includeIf` pattern and git directory path matched; longer
/// ones fail the lookup.
const MAX_GLOB_PATTERN: usize = 1024;
const MAX_GLOB_TEXT: usize = 4096;
/// The most steps one match may take; more fails the lookup.
const MAX_GLOB_WORK: usize = 1_000_000;

/// Whether `text` matches the wildcard `pattern`: `**/` is zero or more
/// whole directories, a trailing `**` anything, `*` and `?` stay within one
/// name. `None` when the pattern or path is too long or the match takes too
/// much work: each (pattern, text) position is decided once (one byte each,
/// at most about 4 MiB) and every step counts against a fixed budget.
fn glob(pattern: &[u8], text: &[u8]) -> Option<bool> {
    if pattern.len() > MAX_GLOB_PATTERN || text.len() > MAX_GLOB_TEXT {
        return None;
    }
    let mut matcher = Glob {
        pattern,
        text,
        memo: vec![0; (pattern.len() + 1) * (text.len() + 1)],
        work: MAX_GLOB_WORK,
    };
    matcher.at(0, 0)
}

struct Glob<'a> {
    pattern: &'a [u8],
    text: &'a [u8],
    /// 0 unknown, 1 no match, 2 match, per (pattern, text) position.
    memo: Vec<u8>,
    work: usize,
}

impl Glob<'_> {
    fn step(&mut self) -> Option<()> {
        self.work = self.work.checked_sub(1)?;
        Some(())
    }

    fn at(&mut self, p: usize, t: usize) -> Option<bool> {
        let slot = p * (self.text.len() + 1) + t;
        match self.memo[slot] {
            1 => return Some(false),
            2 => return Some(true),
            _ => {}
        }
        self.step()?;
        let (pattern, text) = (self.pattern, self.text);
        let answer = match &pattern[p..] {
            [] => t == text.len(),
            [b'*', b'*', b'/', ..] => {
                let mut found = self.at(p + 3, t)?;
                let mut at = t;
                while !found && at < text.len() {
                    self.step()?;
                    if text[at] == b'/' {
                        found = self.at(p + 3, at + 1)?;
                    }
                    at += 1;
                }
                found
            }
            [b'*', b'*', ..] => {
                let mut found = false;
                for at in t..=text.len() {
                    self.step()?;
                    if self.at(p + 2, at)? {
                        found = true;
                        break;
                    }
                }
                found
            }
            [b'*', ..] => {
                let mut found = false;
                for at in t..=text.len() {
                    self.step()?;
                    if at > t && text[at - 1] == b'/' {
                        break;
                    }
                    if self.at(p + 1, at)? {
                        found = true;
                        break;
                    }
                }
                found
            }
            [b'?', ..] => t < text.len() && text[t] != b'/' && self.at(p + 1, t + 1)?,
            [c, ..] => t < text.len() && text[t] == *c && self.at(p + 1, t + 1)?,
        };
        self.memo[slot] = if answer { 2 } else { 1 };
        Some(answer)
    }
}

/// Whether an `includeIf` condition holds for the repository at `git_dir`
/// (`None` when its pattern is too long or costly to match, which fails the
/// lookup):
/// `gitdir:` and `gitdir/i:` as git reads them; any other condition
/// (`onbranch:`, `hasconfig:`) is taken as not holding.
fn include_applies(condition: &str, git_dir: Option<&Path>, including: &Path) -> Option<bool> {
    let (pattern, fold) = if let Some(p) = condition.strip_prefix("gitdir/i:") {
        (p, true)
    } else if let Some(p) = condition.strip_prefix("gitdir:") {
        (p, false)
    } else {
        return Some(false);
    };
    let Some(git_dir) = git_dir else {
        return Some(false);
    };
    let mut pattern = if let Some(rest) = pattern.strip_prefix("~/") {
        match home() {
            Some(home) => format!("{}/{rest}", home.display()),
            None => return Some(false),
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
    Some(
        glob(pattern.as_bytes(), text.as_bytes())?
            || glob(pattern.as_bytes(), text.trim_end_matches('/').as_bytes())?,
    )
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
    /// The lookup failed: a bound was passed, a file was too large or
    /// unreadable, an include looped, or a pattern took too much work.
    failed: bool,
}

impl Budget {
    /// The bound for one lookup.
    pub(crate) fn new() -> Budget {
        Budget {
            files: MAX_INCLUDE_FILES,
            bytes: MAX_INCLUDE_BYTES,
            failed: false,
        }
    }

    /// Takes one file of `len` bytes from the budget; `false` when it is spent.
    fn take(&mut self, len: usize) -> bool {
        if self.files == 0 || len > self.bytes {
            self.failed = true;
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
    let text = match read_config(path) {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(()) => {
            budget.failed = true;
            return None;
        }
    };
    if !budget.take(text.len()) {
        return None;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if chain.contains(&canonical) || depth >= MAX_INCLUDE_DEPTH {
        budget.failed = true;
        return None;
    }
    chain.push(canonical);
    let mut out = String::new();
    let mut header = String::new();
    let mut include: Option<Option<String>> = None;
    for line in logical_lines(&text) {
        out.push_str(&line);
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
            match include_applies(condition, git_dir, path) {
                Some(true) => {}
                Some(false) => continue,
                None => {
                    budget.failed = true;
                    chain.pop();
                    return None;
                }
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
        if budget.failed {
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

/// A config file as a lookup reads it: `Ok(None)` when there is none (git
/// skips a missing include), `Err` when it exists but is larger than a
/// config can be or cannot be read, which fails the lookup: a config is used
/// whole or not at all, never its prefix.
fn read_config(path: &Path) -> Result<Option<String>, ()> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let mut text = String::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(drop)?;
    if text.len() as u64 > MAX_CONFIG_BYTES {
        return Err(());
    }
    Ok(Some(text))
}

/// The text of `path`, or `None` when it cannot be read or is larger than
/// a config can be: a config is read whole or not at all, never its prefix.
fn read_small(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= MAX_CONFIG_BYTES).then_some(text)
}

/// A config's lines as git reads them: a line ending in an unescaped `\`
/// continues on the next.
fn logical_lines(config: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    // Whether the logical line so far ends inside quotes: a continued
    // value keeps its quoting on the next physical line, as git reads it.
    let mut quoted = false;
    for line in config.lines() {
        let (more, still_quoted) = continues(line, quoted);
        if more {
            current.push_str(&line[..line.len() - 1]);
            quoted = still_quoted;
            continue;
        }
        quoted = false;
        current.push_str(line);
        lines.push(std::mem::take(&mut current));
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// Whether `line` ends in a `\` that continues it (not inside a comment,
/// whole-line or after the value, and not escaped), and whether it ends
/// inside quotes; `quoted` is whether it starts inside quotes, carried from
/// the line it continues, where `#` and `;` are text, not comments.
fn continues(line: &str, quoted: bool) -> (bool, bool) {
    let trimmed = line.trim_start();
    if !quoted && (trimmed.starts_with('#') || trimmed.starts_with(';')) {
        return (false, false);
    }
    let mut quoted = quoted;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if chars.next().is_none() {
                    return (true, quoted);
                }
            }
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return (false, false),
            _ => {}
        }
    }
    (false, quoted)
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
    for line in logical_lines(config) {
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
        // A key without `=` is a boolean that is true, as git reads it.
        let (key, value) = match line.split_once('=') {
            Some((key, value)) => (key, config_value(value)),
            None => (
                line.split(['#', ';']).next().unwrap_or_default(),
                "true".to_string(),
            ),
        };
        entries.push((
            section.clone(),
            subsection.clone(),
            key.trim().to_ascii_lowercase(),
            value,
        ));
    }
    entries
}

/// The `url` of `[remote "origin"]` in git configs' texts, read in order:
/// the first one set, which is the one `git fetch` uses (more add push
/// targets).
fn origin_url(config: &str) -> Option<String> {
    config_entries(config)
        .into_iter()
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

/// Where the person's global git configs are.
fn global_paths() -> Vec<PathBuf> {
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
    .collect()
}

/// The `owner/name` of the repository `directory` is in, from its `origin`
/// remote; `None` outside a repository or without a hosted origin.
pub fn repository_of(directory: &Path) -> Option<String> {
    repository_with(directory, &global_paths())
}

/// [`repository_of`] with the person's global configs at `globals`.
fn repository_with(directory: &Path, globals: &[PathBuf]) -> Option<String> {
    // A directory reached through a link is looked up where it really is.
    let directory = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    let (own, common) = git_dirs(&directory)?;
    // In git's order, each later file overriding the earlier ones: the
    // person's, the repository's, and the work tree's own when the
    // repository enables per-work-tree config.
    // `includeIf "gitdir:"` is matched against the work tree's own git
    // directory (`.git/worktrees/<name>` for a linked one), as git does.
    let mut budget = Budget::new();
    let mut configs: Vec<String> = globals
        .iter()
        .filter_map(|path| expanded(path, Some(&own), &mut budget))
        .collect();
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
    if budget.failed {
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

    fn include_applies_is(condition: &str, git_dir: Option<&Path>, including: &Path) -> bool {
        include_applies(condition, git_dir, including).expect("within bounds")
    }

    #[test]
    fn include_if_matches_the_git_directory() {
        let including = Path::new("/home/me/.gitconfig");
        let git = Path::new("/home/me/work/acme/web/.git");
        assert!(include_applies_is(
            "gitdir:/home/me/work/",
            Some(git),
            including
        ));
        assert!(include_applies_is(
            "gitdir:work/acme/",
            Some(git),
            including
        ));
        assert!(include_applies_is(
            "gitdir/i:/HOME/ME/WORK/",
            Some(git),
            including
        ));
        assert!(!include_applies_is(
            "gitdir:/home/me/play/",
            Some(git),
            including
        ));
        assert!(!include_applies_is("onbranch:main", Some(git), including));
        // A relative pattern matches whole directories only, as in git.
        let elsewhere = Path::new("/home/me/notwork/acme/web/.git");
        assert!(!include_applies_is(
            "gitdir:work/",
            Some(elsewhere),
            including
        ));
        assert!(include_applies_is(
            "gitdir:work/",
            Some(Path::new("/work/acme/.git")),
            including
        ));
        assert!(glob_is(b"/a/**/c/", b"/a/b/x/c/"));
        assert!(glob_is(b"**/work/**", b"/home/work/x"));
        assert!(!glob_is(b"**/work/**", b"/home/notwork/x"));
        assert!(glob_is(b"/a/*/c", b"/a/b/c"));
        assert!(!glob_is(b"/a/*/c", b"/a/b/x/c"));
    }

    /// The first origin is the one git fetches; a value continued with `\`
    /// is read whole; a config too large to read whole names nothing.
    #[test]
    fn origins_are_read_whole_and_first_wins() {
        assert_eq!(
            origin_url(
                "[remote \"origin\"]\n\turl = https://host/me/web\n\turl = https://host/acme/web\n"
            )
            .as_deref(),
            Some("https://host/me/web")
        );
        assert_eq!(
            origin_url("[remote \"origin\"]\n\turl = https://github.com/\\\nacme/web.git\n")
                .as_deref(),
            Some("https://github.com/acme/web.git")
        );
        // A quoted value continued across lines keeps its quoting, so a `#`
        // or `;` on a middle line is text, not a comment.
        let config = "[include]\n\tpath = \"foo\\\n#bar\\\nbaz.inc\"\n";
        assert_eq!(
            config_entries(config),
            vec![(
                "include".into(),
                None,
                "path".into(),
                "foo#barbaz.inc".into()
            )]
        );
        // A comment ending in `\` does not continue onto the next line.
        assert_eq!(
            origin_url(
                "[remote \"origin\"]\n\t# old fork \\\n\turl = https://github.com/acme/web\n"
            )
            .as_deref(),
            Some("https://github.com/acme/web")
        );
        assert_eq!(
            origin_url("[remote \"origin\"]\n\turl = https://github.com/acme/web ; note \\\n")
                .as_deref(),
            Some("https://github.com/acme/web")
        );
        let temp = tempfile::tempdir().unwrap();
        let big = temp.path().join("big");
        std::fs::write(&big, "#".repeat(MAX_CONFIG_BYTES as usize + 1)).unwrap();
        assert_eq!(read_small(&big), None);
        // An oversized global config, include or work-tree config fails the
        // lookup, whatever the rest names.
        let checkout = temp.path().join("web");
        repo(&checkout, "https://github.com/acme/web");
        assert_eq!(repository_with(&checkout, &[]).as_deref(), Some("acme/web"));
        assert_eq!(repository_with(&checkout, std::slice::from_ref(&big)), None);
        assert_eq!(
            repository_with(&checkout, &[temp.path().join("absent")]).as_deref(),
            Some("acme/web")
        );
        let config = checkout.join(".git/config");
        let text = std::fs::read_to_string(&config).unwrap();
        std::fs::write(
            &config,
            format!("{text}[include]\n\tpath = {}\n", big.display()),
        )
        .unwrap();
        assert_eq!(repository_with(&checkout, &[]), None);
        std::fs::write(&config, format!("[extensions]\n\tworktreeConfig\n{text}")).unwrap();
        assert_eq!(repository_with(&checkout, &[]).as_deref(), Some("acme/web"));
        std::fs::copy(&big, checkout.join(".git/config.worktree")).unwrap();
        assert_eq!(repository_with(&checkout, &[]), None);
    }

    fn glob_is(pattern: &[u8], text: &[u8]) -> bool {
        glob(pattern, text).expect("within bounds")
    }

    /// A pattern built to backtrack is decided in bounded time and memory;
    /// one too long, or too costly, fails instead of answering.
    #[test]
    fn glob_work_is_bounded() {
        let pattern = "*a".repeat(40) + "b";
        let text = "a".repeat(60);
        let started = std::time::Instant::now();
        assert_eq!(glob(pattern.as_bytes(), text.as_bytes()), Some(false));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        let long = "a".repeat(MAX_GLOB_PATTERN + 1);
        assert_eq!(glob(long.as_bytes(), b"a"), None);
        let path = "a".repeat(MAX_GLOB_TEXT + 1);
        assert_eq!(glob(b"**", path.as_bytes()), None);
        let costly = "**/".repeat(300) + "x";
        let deep = "a/".repeat(2000);
        let started = std::time::Instant::now();
        assert_eq!(glob(costly.as_bytes(), deep.as_bytes()), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
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
        // A work tree with its own config, when the repository enables it
        // (a bare key is true), names its own origin; with an origin in the
        // shared config too, the first one set is the one git fetches.
        std::fs::write(main_git.join("config"), "[extensions]\n\tworktreeConfig\n").unwrap();
        std::fs::write(
            main_git.join("config.worktree"),
            "[remote \"origin\"]\n\turl = git@github.com:Acme/Web.git\n",
        )
        .unwrap();
        std::fs::write(
            admin.join("config.worktree"),
            "[remote \"origin\"]\n\turl = git@github.com:me/web-fork.git\n",
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("me/web-fork"));
        assert_eq!(repository_of(&nested).as_deref(), Some("acme/web"));
        std::fs::write(
            main_git.join("config"),
            "[extensions]\n\tworktreeConfig = true\n[remote \"origin\"]\n\turl = git@github.com:Acme/Web.git\n",
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("acme/web"));
        std::fs::remove_file(main_git.join("config.worktree")).unwrap();
        std::fs::remove_file(admin.join("config.worktree")).unwrap();
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
        let canonical = |path: &Path| std::fs::canonicalize(path).unwrap();
        std::fs::write(
            main_git.join("config"),
            format!(
                "[includeIf \"gitdir:{}/\"]\n\tpath = fork.inc\n[includeIf \"gitdir:{}/\"]\n\tpath = main.inc\n",
                canonical(&admin).display(),
                canonical(&main_git).display(),
            ),
        )
        .unwrap();
        std::fs::write(
            main_git.join("fork.inc"),
            "[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n",
        )
        .unwrap();
        std::fs::write(
            main_git.join("main.inc"),
            "[remote \"origin\"]\n\turl = git@github.com:Acme/Web.git\n",
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("me/fork"));
        assert_eq!(repository_of(&nested).as_deref(), Some("acme/web"));
        // A relative `gitdir:` with `..` is resolved before it is matched.
        std::fs::write(
            linked.join(".git"),
            "gitdir: ../web/.git/worktrees/web-feature\n",
        )
        .unwrap();
        assert_eq!(repository_of(&linked).as_deref(), Some("me/fork"));
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
