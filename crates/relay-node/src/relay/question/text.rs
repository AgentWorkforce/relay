//! What an escalated question says, and how a reply to it is read: the
//! question's direct message, the `answer <ref> ...` grammar, and the
//! answer it gives the session.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// One option of a question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    pub description: String,
}

/// One question, as Claude's `AskUserQuestion` or Codex's
/// `item/tool/requestUserInput` asks it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    /// Codex's question id; Claude's questions have none.
    pub id: String,
    pub header: String,
    pub text: String,
    pub options: Vec<Choice>,
    /// Several options may be chosen.
    pub multi: bool,
    /// An answer in the sender's own words is taken.
    pub free: bool,
}

fn string(value: &Value) -> String {
    value.as_str().unwrap_or_default().trim().to_string()
}

fn choices(question: &Value) -> Vec<Choice> {
    question["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| option["isOther"] != true)
        .map(|option| Choice {
            label: string(&option["label"]),
            description: string(&option["description"]),
        })
        .filter(|choice| !choice.label.is_empty())
        .collect()
}

/// The most questions, and options in one question, a hook's input may
/// have; more asks nothing, and the harness shows its question.
pub const MAX_QUESTIONS: usize = 10;
pub const MAX_OPTIONS: usize = 50;

/// The questions a hook hands over in its `tool_input`: Claude's
/// `AskUserQuestion` (`multiSelect`), Devin's `ask_user_question`
/// (`multi_select`) or Grok's, which share the shape `{questions: [{question,
/// header, options: [{label, description}] or [label]}]}`. Each always takes
/// an answer in the user's own words. Empty for any other shape.
pub fn hook_questions(input: &Value) -> Vec<Question> {
    // Strict: a shape none of them gives asks nothing, and the tool runs.
    let Some(asked) = input["questions"].as_array() else {
        return Vec::new();
    };
    if asked.len() > MAX_QUESTIONS {
        return Vec::new();
    }
    let known = asked.iter().all(|question| {
        question["question"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
            && question.get("options").is_none_or(|options| {
                options.as_array().is_some_and(|options| {
                    options.len() <= MAX_OPTIONS
                        && options
                            .iter()
                            .all(|option| option.is_string() || option["label"].is_string())
                })
            })
    });
    if !known {
        return Vec::new();
    }
    asked
        .iter()
        .map(|question| Question {
            id: String::new(),
            header: string(&question["header"]),
            text: string(&question["question"]),
            options: question["options"]
                .as_array()
                .into_iter()
                .flatten()
                // Claude's own free-text choice is not a choice to number.
                .filter(|option| option["isOther"] != true)
                .map(|option| match option.as_str() {
                    Some(label) => Choice {
                        label: label.trim().to_string(),
                        description: String::new(),
                    },
                    None => Choice {
                        label: string(&option["label"]),
                        description: string(&option["description"]),
                    },
                })
                .filter(|choice| !choice.label.is_empty())
                .collect(),
            multi: question["multiSelect"] == true || question["multi_select"] == true,
            free: true,
        })
        .collect()
}

/// The questions of Claude's `AskUserQuestion` `tool_input`; empty when it
/// asks none. Claude always takes an answer in the user's own words.
pub fn claude_questions(input: &Value) -> Vec<Question> {
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|question| Question {
            id: String::new(),
            header: string(&question["header"]),
            text: string(&question["question"]),
            options: choices(question),
            multi: question["multiSelect"] == true || question["multi_select"] == true,
            free: true,
        })
        .filter(|question| !question.text.is_empty())
        .collect()
}

/// The questions of Codex's `item/tool/requestUserInput` params; `None`
/// when it asks none, or one is secret (its answer must never travel over
/// Relaycast).
pub fn codex_questions(params: &Value) -> Option<Vec<Question>> {
    let asked = params["questions"].as_array()?;
    if asked.is_empty()
        || asked.len() > MAX_QUESTIONS
        || asked.iter().any(|question| {
            question["isSecret"] == true
                || question["options"]
                    .as_array()
                    .is_some_and(|options| options.len() > MAX_OPTIONS)
        })
    {
        return None;
    }
    asked
        .iter()
        .map(|question| {
            let options = choices(question);
            let other = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|option| option["isOther"] == true);
            Some(Question {
                id: question["id"].as_str()?.to_string(),
                header: string(&question["header"]),
                text: string(&question["question"]),
                free: options.is_empty() || other || question["isOther"] == true,
                options,
                multi: false,
            })
        })
        .collect()
}

/// The questions in Codex's `request_user_input` arguments, as its
/// PreToolUse hook gives them (`tool_input`): `{questions: [{id, header,
/// question, options: [{label, description}]}]}`. Codex adds a free-text
/// choice to every one itself, so each takes text. `None` for anything
/// else, so the question is shown as usual.
pub fn codex_tool_questions(input: &Value) -> Option<Vec<Question>> {
    let questions = codex_questions(input)?;
    Some(
        questions
            .into_iter()
            .map(|question| Question {
                free: true,
                ..question
            })
            .collect(),
    )
}

/// The question in Copilot's `ask_user` arguments: `{question, choices?,
/// allowFreeform?}`, `choices` a list of strings (the Copilot runtime 1.0.94
/// checks both). `None` for any other shape, so Copilot shows it.
pub fn copilot_questions(args: &Value) -> Option<Vec<Question>> {
    let text = args["question"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())?;
    let options = match args.get("choices") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(choices)) if choices.len() <= MAX_OPTIONS => choices
            .iter()
            .map(|choice| {
                choice.as_str().map(|label| Choice {
                    label: label.trim().to_string(),
                    description: String::new(),
                })
            })
            .collect::<Option<Vec<Choice>>>()?
            .into_iter()
            .filter(|choice| !choice.label.is_empty())
            .collect(),
        Some(_) => return None,
    };
    let free = match args.get("allowFreeform") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(free)) => *free,
        Some(_) => return None,
    };
    Some(vec![Question {
        id: String::new(),
        header: String::new(),
        text: text.to_string(),
        free: free || options.is_empty(),
        options,
        multi: false,
    }])
}

/// Who asked, for the message's first lines.
pub struct Asker<'a> {
    pub reference: &'a str,
    pub agent: &'a str,
    pub host: &'a str,
    pub cwd: &'a str,
    pub session: &'a str,
}

/// The direct message that escalates `questions`.
pub fn render(asker: &Asker<'_>, questions: &[Question], minutes: u64) -> String {
    let Asker {
        reference,
        agent,
        host,
        cwd,
        session,
    } = asker;
    let mut lines = vec![format!("[Question {reference} from @{agent} on {host}]")];
    let working = if cwd.is_empty() { "unknown" } else { cwd };
    lines.push(match repository(Path::new(cwd)) {
        Some((repo, branch)) => format!("Working on: {working} ({repo} @ {branch})"),
        None => format!("Working on: {working}"),
    });
    lines.push(format!("session {session}"));
    let several = questions.len() > 1;
    for (index, question) in questions.iter().enumerate() {
        let numbered = if several {
            format!("({}/{}) ", index + 1, questions.len())
        } else {
            String::new()
        };
        lines.push(match question.header.as_str() {
            "" => format!("{numbered}{}", question.text),
            header => format!("{numbered}{header}: {}", question.text),
        });
        for (number, choice) in question.options.iter().enumerate() {
            lines.push(match choice.description.as_str() {
                "" => format!("{}. {}", number + 1, choice.label),
                description => format!("{}. {} — {description}", number + 1, choice.label),
            });
        }
        lines.push(
            match (question.options.is_empty(), question.multi, question.free) {
                (true, _, _) => "free text".to_string(),
                (false, true, true) => {
                    "Choose one or more (comma-separated numbers), or answer in free text."
                        .to_string()
                }
                (false, true, false) => "Choose one or more (comma-separated numbers).".into(),
                (false, false, true) => "Choose a number, or answer in free text.".into(),
                (false, false, false) => "Choose a number.".into(),
            },
        );
    }
    let form = if several {
        let each = vec!["<n|text>"; questions.len()].join("; ");
        format!("answer {reference} {each} (one per question, in order)")
    } else {
        format!("answer {reference} <n|text>")
    };
    lines.push(format!(
        "Reply: {form}. Expires in {minutes} min; the agent continues without it."
    ));
    lines.join("\n")
}

/// Whether `word` is a question reference: `q` and 8 hex digits, any case.
pub fn is_reference(word: &str) -> bool {
    word.len() == 9
        && word.as_bytes()[0].eq_ignore_ascii_case(&b'q')
        && word[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The longest answer typed into a session, in characters.
pub const MAX_ANSWER: usize = 4096;

/// `text` made safe to type into a session: escape sequences (CSI, OSC and
/// the rest) dropped, then on one line (`policy::one_line`: control, format
/// and line-separator characters become spaces, brackets parentheses,
/// whitespace runs collapse), and at most `MAX_ANSWER` characters.
pub fn clean(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters and intermediates up to a final byte.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC, DCS, SOS, PM, APC: up to BEL or ST (ESC \).
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || c == '\u{9c}' {
                            break;
                        }
                        if c == '\u{1b}' {
                            chars.next_if_eq(&'\\');
                            break;
                        }
                    }
                }
                // Any other escape is two characters long.
                _ => {}
            },
            // C1 CSI.
            '\u{9b}' => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            c => plain.push(c),
        }
    }
    let line = crate::relay::delivery::policy::one_line(&plain);
    if line.chars().count() <= MAX_ANSWER {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_ANSWER - 1).collect();
    cut.push('…');
    cut
}

/// `answer <ref> <rest>` or `answer <ref>: <rest>` (the verb in any case):
/// the reference, lower case, and the rest, `clean`ed (empty when none).
pub fn parse_answer(text: &str) -> Option<(String, String)> {
    let text = text.trim_start();
    let (verb, rest) = text.split_once(char::is_whitespace)?;
    if !verb.eq_ignore_ascii_case("answer") {
        return None;
    }
    let rest = rest.trim_start();
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ':')
        .unwrap_or(rest.len());
    let (reference, rest) = rest.split_at(end);
    if !is_reference(reference) {
        return None;
    }
    let rest = rest.trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim();
    Some((reference.to_ascii_lowercase(), clean(rest)))
}

/// What a reply chose for one question: the labels (or the sender's own
/// words), and how the session is told it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub values: Vec<String>,
    pub shown: String,
}

/// The answers `rest` gives `questions`, one per question (`;` between
/// them when there are several); or why it cannot be read.
pub fn resolve(questions: &[Question], rest: &str) -> Result<Vec<Answer>, String> {
    if rest.is_empty() {
        return Err("give a number or text after the reference".into());
    }
    let parts: Vec<&str> = if questions.len() > 1 {
        rest.split(';').map(str::trim).collect()
    } else {
        vec![rest]
    };
    if parts.len() != questions.len() || parts.iter().any(|part| part.is_empty()) {
        return Err(format!(
            "answer each of the {} questions in order, separated by ;",
            questions.len()
        ));
    }
    questions
        .iter()
        .zip(parts)
        .map(|(question, part)| resolve_one(question, part))
        .collect()
}

fn resolve_one(question: &Question, part: &str) -> Result<Answer, String> {
    let numbers: Option<Vec<usize>> = (!question.options.is_empty())
        .then(|| {
            part.split(',')
                .map(|number| number.trim().parse::<usize>().ok())
                .collect()
        })
        .flatten();
    let choose = || format!("choose a number from 1 to {}", question.options.len());
    let text = || {
        let words = clean(part);
        Answer {
            values: vec![words.clone()],
            shown: words,
        }
    };
    let Some(numbers) = numbers else {
        if !question.free {
            return Err(choose());
        }
        return Ok(text());
    };
    // A number that names no option is free text when the question takes it.
    if question.free
        && numbers
            .iter()
            .any(|&number| number == 0 || number > question.options.len())
    {
        return Ok(text());
    }
    if numbers.len() > 1 && !question.multi {
        return Err("this question takes one choice".into());
    }
    let mut chosen: Vec<usize> = Vec::new();
    for number in numbers {
        if number == 0 || number > question.options.len() {
            return Err(choose());
        }
        if !chosen.contains(&number) {
            chosen.push(number);
        }
    }
    let values: Vec<String> = chosen
        .iter()
        .map(|number| question.options[number - 1].label.clone())
        .collect();
    let shown = chosen
        .iter()
        .zip(&values)
        .map(|(number, label)| format!("{number}. {label}"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(Answer { values, shown })
}

/// The line the session is given for `answers`.
pub fn answer_line(reference: &str, questions: &[Question], answers: &[Answer]) -> String {
    let shown = if let [answer] = answers {
        answer.shown.clone()
    } else {
        questions
            .iter()
            .zip(answers)
            .map(|(question, answer)| {
                let name = if question.header.is_empty() {
                    &question.text
                } else {
                    &question.header
                };
                format!("{name}: {}", answer.shown)
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    format!("[Answer to question {reference}] {}", clean(&shown))
}

/// The line a session that is still running is given when its question
/// expires.
pub fn expired_line(reference: &str) -> String {
    format!("[Question {reference} expired without an answer; continue without it]")
}

/// The repository `cwd` is in and its branch (or short commit), read from
/// its `.git` without running git; `None` outside a repository.
pub fn repository(cwd: &Path) -> Option<(String, String)> {
    if cwd.as_os_str().is_empty() {
        return None;
    }
    let (top, git_dir) = cwd.ancestors().find_map(|dir| {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some((dir.to_path_buf(), dot_git));
        }
        // A worktree or submodule: `gitdir: <path>`.
        let file = std::fs::read_to_string(&dot_git).ok()?;
        let target = PathBuf::from(file.trim().strip_prefix("gitdir:")?.trim());
        Some((dir.to_path_buf(), dir.join(target)))
    })?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    let branch = match head.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            reference
                .strip_prefix("refs/heads/")
                .unwrap_or(reference)
                .to_string()
        }
        None => head.chars().take(7).collect(),
    };
    // A linked worktree keeps its config in the common directory.
    let common = std::fs::read_to_string(git_dir.join("commondir"))
        .map(|common| git_dir.join(common.trim()))
        .unwrap_or(git_dir);
    let repo = std::fs::read_to_string(common.join("config"))
        .ok()
        .and_then(|config| origin_name(&config))
        .or_else(|| Some(top.file_name()?.to_string_lossy().into_owned()))?;
    (!branch.is_empty()).then_some((repo, branch))
}

/// The repository name in `origin`'s URL in a git config.
fn origin_name(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line.replace(' ', "") == "[remote\"origin\"]";
            continue;
        }
        let Some(url) = line
            .strip_prefix("url")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
            .filter(|_| in_origin)
        else {
            continue;
        };
        let url = url.trim().trim_end_matches('/');
        let name = url.rsplit(['/', ':']).next()?;
        let name = name.strip_suffix(".git").unwrap_or(name);
        return (!name.is_empty()).then(|| name.to_string());
    }
    None
}
