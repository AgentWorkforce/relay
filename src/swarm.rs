use crate::helpers;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use clap::Parser;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{timeout, Instant};

const PROTOCOL_VERSION: u32 = 1;
const DEFAULT_PATTERN: &str = "fan-out";
const DEFAULT_TEAMS: usize = 2;
const DEFAULT_TIMEOUT: &str = "300s";
const DEFAULT_CLI: &str = "codex";
const DEFAULT_BROKER_NAME: &str = "swarm-orchestrator";
const DEFAULT_SWARM_TOKEN_LIMIT: u64 = 120_000;

fn default_broker_bin() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "agent-relay-broker".to_string())
}

struct PatternDef {
    id: &'static str,
    description: &'static str,
}

const PATTERNS: &[PatternDef] = &[
    PatternDef {
        id: "fan-out",
        description: "Parallel execution across multiple workers",
    },
    PatternDef {
        id: "pipeline",
        description: "Sequential stages where each step builds on prior output",
    },
    PatternDef {
        id: "competitive",
        description: "Independent teams compete to produce the best answer",
    },
    PatternDef {
        id: "hub-spoke",
        description: "Central coordinator with worker spokes",
    },
    PatternDef {
        id: "consensus",
        description: "Teams collaborate to reach agreement",
    },
    PatternDef {
        id: "mesh",
        description: "Fully connected peer communication",
    },
    PatternDef {
        id: "handoff",
        description: "Sequential handoff between teams",
    },
    PatternDef {
        id: "cascade",
        description: "Progressive delegation down a chain",
    },
    PatternDef {
        id: "dag",
        description: "Dependency-aware directed graph execution",
    },
    PatternDef {
        id: "debate",
        description: "Structured argument and rebuttal between teams",
    },
    PatternDef {
        id: "hierarchical",
        description: "Tree-structured orchestration",
    },
    PatternDef {
        id: "map-reduce",
        description: "Parallel mapping with reducer aggregation",
    },
    PatternDef {
        id: "scatter-gather",
        description: "Scatter requests, gather responses",
    },
    PatternDef {
        id: "supervisor",
        description: "Supervisor-led execution and correction",
    },
    PatternDef {
        id: "reflection",
        description: "Self-critique and iterative refinement",
    },
    PatternDef {
        id: "red-team",
        description: "Adversarial attacker/defender workflow",
    },
    PatternDef {
        id: "verifier",
        description: "Generation with explicit verification",
    },
    PatternDef {
        id: "auction",
        description: "Task bidding and winner execution",
    },
    PatternDef {
        id: "escalation",
        description: "Tiered escalation from lower to higher expertise",
    },
    PatternDef {
        id: "saga",
        description: "Compensating transactions for multi-step workflows",
    },
    PatternDef {
        id: "circuit-breaker",
        description: "Fallback orchestration under failure conditions",
    },
    PatternDef {
        id: "blackboard",
        description: "Shared-state blackboard collaboration",
    },
    PatternDef {
        id: "swarm",
        description: "Emergent neighborhood swarm behavior",
    },
    PatternDef {
        id: "review-loop",
        description: "Implementation/review feedback loop",
    },
];

#[derive(Debug, Parser)]
#[command(name = "swarm")]
#[command(about = "Run ad-hoc swarm execution via the relay broker")]
pub struct SwarmArgs {
    /// Swarm pattern (e.g. competitive, pipeline, fan-out)
    #[arg(long, default_value = DEFAULT_PATTERN)]
    pattern: String,

    /// Task description for the swarm
    #[arg(long)]
    task: Option<String>,

    /// Number of teams/stages to run
    #[arg(long, default_value_t = DEFAULT_TEAMS)]
    teams: usize,

    /// Overall timeout for synchronous execution (seconds or suffixed: 30s, 5m, 1h)
    #[arg(long, default_value = DEFAULT_TIMEOUT)]
    timeout: String,

    /// List available swarm patterns and exit
    #[arg(long)]
    list: bool,

    /// CLI used when spawning team workers
    #[arg(long, default_value = DEFAULT_CLI)]
    cli: String,

    /// Broker binary path
    #[arg(long, default_value_t = default_broker_bin(), hide = true)]
    broker_bin: String,

    /// Broker identity name
    #[arg(long, default_value = DEFAULT_BROKER_NAME, hide = true)]
    broker_name: String,

    /// Channels the broker should join on startup
    #[arg(long, default_value = "general", hide = true)]
    channels: String,

    /// Working directory for spawned worker agents (defaults to current dir)
    #[arg(long, hide = true)]
    project_dir: Option<String>,

    /// Runtime directory for broker lock/state (defaults to project dir)
    #[arg(long, hide = true)]
    broker_runtime_dir: Option<String>,
}

#[derive(Debug)]
struct SwarmSummary {
    pattern: String,
    teams: usize,
    timeout_secs: u64,
    elapsed: Duration,
    results: Vec<(String, String)>,
    timed_out: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmOutputEnvelope {
    run_id: String,
    mode: String,
    status: String,
    pattern: String,
    started_at: String,
    finished_at: String,
    summary: Option<String>,
    results: Vec<SwarmResultUnit>,
    errors: Vec<SwarmErrorUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    continuation: Option<SwarmContinuation>,
    governance: SwarmGovernance,
    #[serde(skip_serializing_if = "Option::is_none")]
    winner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rationale: Option<String>,
    solutions: Vec<SwarmSolution>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmResultUnit {
    unit_id: String,
    agent: String,
    status: String,
    output: String,
    tokens: SwarmTokenUsage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmTokenUsage {
    input: u64,
    output: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmErrorUnit {
    unit_id: String,
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmContinuation {
    hint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmGovernance {
    depth: u8,
    budgets: SwarmBudgetUsage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmBudgetUsage {
    used: u64,
    limit: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwarmSolution {
    team: String,
    status: String,
    output: String,
}

pub async fn run_swarm(args: SwarmArgs) -> Result<()> {
    if args.list {
        print_available_patterns();
        return Ok(());
    }

    if args.teams == 0 {
        bail!("--teams must be at least 1");
    }

    let task = args
        .task
        .clone()
        .filter(|value| !value.trim().is_empty())
        .context("--task is required unless --list is used")?;
    let timeout_secs = parse_timeout_secs(&args.timeout)?;
    let pattern = normalize_pattern(&args.pattern)?;
    let project_dir = resolve_project_dir(args.project_dir.as_deref())?;

    let has_custom_runtime = args.broker_runtime_dir.is_some();
    let mut runtime_dir = if let Some(dir) = args.broker_runtime_dir.as_deref() {
        let path = PathBuf::from(dir);
        std::fs::create_dir_all(&path)
            .with_context(|| format!("failed to create broker runtime dir {}", path.display()))?;
        path
    } else {
        project_dir.clone()
    };
    let mut runtime_is_temporary = false;

    let run_id = swarm_run_id();
    let worker_names = build_worker_names(&pattern, args.teams, &run_id);

    eprintln!(
        "[swarm] pattern={} teams={} timeout={}s cli={}",
        pattern, args.teams, timeout_secs, args.cli
    );
    eprintln!("[swarm] starting broker...");

    let mut broker = match start_broker_ready(
        &args.broker_bin,
        &args.broker_name,
        &args.channels,
        &runtime_dir,
    )
    .await
    {
        Ok(client) => client,
        Err(error) if !has_custom_runtime && is_broker_lock_error(&error) => {
            runtime_dir = create_temporary_runtime_dir()?;
            runtime_is_temporary = true;
            eprintln!(
                "[swarm] project broker runtime is busy; using temporary runtime at {}",
                runtime_dir.display()
            );
            start_broker_ready(
                &args.broker_bin,
                &args.broker_name,
                &args.channels,
                &runtime_dir,
            )
            .await?
        }
        Err(error) => return Err(error),
    };

    eprintln!("[swarm] broker ready");

    let started_wall = SystemTime::now();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(timeout_secs);
    let mut spawned_workers: Vec<String> = Vec::new();

    let execution = execute_swarm(
        &mut broker,
        &pattern,
        &task,
        &args.cli,
        &project_dir,
        &worker_names,
        deadline,
        &mut spawned_workers,
    )
    .await;

    eprintln!("[swarm] cleaning up workers...");
    cleanup_workers_and_broker(&mut broker, &spawned_workers).await;

    if runtime_is_temporary {
        let _ = std::fs::remove_dir_all(&runtime_dir);
    }

    let finished_wall = SystemTime::now();
    let mut summary = execution?;
    summary.timeout_secs = timeout_secs;
    summary.elapsed = started.elapsed();

    let completed = summary.results.len();
    let timed_out_count = summary.timed_out.len();
    eprintln!(
        "[swarm] done in {:.1}s — {} completed, {} timed out",
        summary.elapsed.as_secs_f64(),
        completed,
        timed_out_count
    );

    print_structured_output(&summary, &run_id, started_wall, finished_wall)?;
    Ok(())
}

fn parse_timeout_secs(raw: &str) -> Result<u64> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        bail!("--timeout cannot be empty");
    }

    if let Ok(seconds) = trimmed.parse::<u64>() {
        if seconds == 0 {
            bail!("--timeout must be greater than zero");
        }
        return Ok(seconds);
    }

    if trimmed.len() < 2 {
        bail!(
            "invalid --timeout value '{}'. Use seconds (e.g. 300) or suffixed units like 30s/5m/1h",
            raw
        );
    }

    let unit = &trimmed[trimmed.len() - 1..];
    let amount_raw = &trimmed[..trimmed.len() - 1];
    let amount: u64 = amount_raw.parse().with_context(|| {
        format!(
            "invalid --timeout value '{}'. Use seconds (e.g. 300) or suffixed units like 30s/5m/1h",
            raw
        )
    })?;
    if amount == 0 {
        bail!("--timeout must be greater than zero");
    }

    let seconds = match unit {
        "s" => amount,
        "m" => amount
            .checked_mul(60)
            .context("--timeout value is too large")?,
        "h" => amount
            .checked_mul(3600)
            .context("--timeout value is too large")?,
        _ => bail!(
            "unsupported --timeout unit '{}'. Use s, m, or h (example: 30m)",
            unit
        ),
    };

    Ok(seconds)
}

fn print_available_patterns() {
    println!("Available swarm patterns:");
    for pattern in PATTERNS {
        println!("- {:<15} {}", pattern.id, pattern.description);
    }
}

fn normalize_pattern(input: &str) -> Result<String> {
    let normalized = input.trim().to_ascii_lowercase();
    if PATTERNS.iter().any(|pattern| pattern.id == normalized) {
        return Ok(normalized);
    }

    let available: Vec<&str> = PATTERNS.iter().map(|pattern| pattern.id).collect();
    bail!(
        "unsupported pattern '{}'. Use --list to view valid patterns: {}",
        input,
        available.join(", ")
    )
}

fn resolve_project_dir(project_dir: Option<&str>) -> Result<PathBuf> {
    let path = if let Some(value) = project_dir {
        PathBuf::from(value)
    } else {
        std::env::current_dir().context("failed to resolve current directory")?
    };

    let canonical = std::fs::canonicalize(&path)
        .with_context(|| format!("failed to resolve project directory {}", path.display()))?;
    Ok(canonical)
}

fn create_temporary_runtime_dir() -> Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut path = std::env::temp_dir();
    path.push(format!(
        "agent-relay-swarm-{}-{}",
        std::process::id(),
        timestamp
    ));
    std::fs::create_dir_all(&path)
        .with_context(|| format!("failed to create runtime directory {}", path.display()))?;
    Ok(path)
}

async fn start_broker_ready(
    broker_bin: &str,
    broker_name: &str,
    channels: &str,
    runtime_dir: &Path,
) -> Result<BrokerClient> {
    let mut broker = BrokerClient::start(broker_bin, broker_name, channels, runtime_dir).await?;
    broker.hello().await?;
    Ok(broker)
}

fn is_broker_lock_error(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("another broker instance is already running in this directory")
        || text.contains("broker lock")
}

fn swarm_run_id() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}-{}", std::process::id(), secs)
}

fn build_worker_names(pattern: &str, teams: usize, run_id: &str) -> Vec<String> {
    let prefix = if pattern == "pipeline" {
        "swarm-stage"
    } else {
        "swarm-team"
    };

    (1..=teams)
        .map(|idx| format!("{}-{}-{}", prefix, idx, run_id))
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn execute_swarm(
    broker: &mut BrokerClient,
    pattern: &str,
    task: &str,
    cli: &str,
    project_dir: &Path,
    worker_names: &[String],
    deadline: Instant,
    spawned_workers: &mut Vec<String>,
) -> Result<SwarmSummary> {
    let mut timed_out: Vec<String> = Vec::new();
    let mut result_map: BTreeMap<String, String> = BTreeMap::new();

    if pattern == "pipeline" {
        let mut previous_output: Option<String> = None;
        for (index, worker_name) in worker_names.iter().enumerate() {
            if Instant::now() >= deadline {
                timed_out.extend(worker_names[index..].iter().cloned());
                break;
            }

            let stage_task = build_stage_task(
                pattern,
                task,
                index,
                worker_names.len(),
                previous_output.as_deref(),
            );
            eprintln!(
                "[swarm] spawning stage {}/{}: {}",
                index + 1,
                worker_names.len(),
                worker_name
            );
            broker
                .spawn_worker(worker_name, cli, project_dir, &stage_task)
                .await
                .with_context(|| format!("failed to spawn worker {}", worker_name))?;
            spawned_workers.push(worker_name.clone());

            eprintln!("[swarm] waiting for {} to complete...", worker_name);
            let stage_result =
                wait_for_specific_worker_result(broker, worker_name, deadline).await?;
            match stage_result {
                Some(result) => {
                    eprintln!("[swarm] {} completed ({} chars)", worker_name, result.len());
                    previous_output = Some(result.clone());
                    result_map.insert(worker_name.clone(), result);
                }
                None => {
                    eprintln!("[swarm] {} timed out", worker_name);
                    timed_out.extend(worker_names[index..].iter().cloned());
                    break;
                }
            }
        }
    } else {
        for (index, worker_name) in worker_names.iter().enumerate() {
            let worker_task = build_stage_task(pattern, task, index, worker_names.len(), None);
            eprintln!(
                "[swarm] spawning team {}/{}: {}",
                index + 1,
                worker_names.len(),
                worker_name
            );
            broker
                .spawn_worker(worker_name, cli, project_dir, &worker_task)
                .await
                .with_context(|| format!("failed to spawn worker {}", worker_name))?;
            spawned_workers.push(worker_name.clone());
        }

        eprintln!(
            "[swarm] all {} workers spawned, waiting for results...",
            worker_names.len()
        );
        let pending: HashSet<String> = worker_names.iter().cloned().collect();
        let results = wait_for_worker_results(broker, pending, deadline).await?;

        for (worker, result) in results {
            result_map.insert(worker, result);
        }

        for worker in worker_names {
            if !result_map.contains_key(worker) {
                timed_out.push(worker.clone());
            }
        }
    }

    Ok(SwarmSummary {
        pattern: pattern.to_string(),
        teams: worker_names.len(),
        timeout_secs: 0,
        elapsed: Duration::from_secs(0),
        results: result_map.into_iter().collect(),
        timed_out,
    })
}

fn build_stage_task(
    pattern: &str,
    base_task: &str,
    index: usize,
    total: usize,
    previous_output: Option<&str>,
) -> String {
    let header = match pattern {
        "competitive" => format!(
            "You are team {}/{} in a competitive swarm. Produce the strongest independent solution.",
            index + 1,
            total
        ),
        "pipeline" => format!(
            "You are pipeline stage {}/{}. Build on previous stage output when present.",
            index + 1,
            total
        ),
        _ => format!(
            "You are team {}/{} in a {} swarm pattern.",
            index + 1,
            total,
            pattern
        ),
    };

    let mut body = format!("{}\n\nPrimary task:\n{}", header, base_task);

    if let Some(output) = previous_output {
        body.push_str("\n\nPrevious stage result:\n");
        body.push_str(output);
    }

    // Tell the agent how to signal completion. The swarm orchestrator
    // watches for agent_exited / agent_released events, so the agent
    // just needs to finish and exit normally.
    body.push_str(
        "\n\nWhen you are done, use the `relay_release` MCP tool to release yourself, \
         or simply exit. The orchestrator will collect your output automatically.",
    );

    body
}

async fn wait_for_specific_worker_result(
    broker: &mut BrokerClient,
    worker_name: &str,
    deadline: Instant,
) -> Result<Option<String>> {
    let mut pending = HashSet::new();
    pending.insert(worker_name.to_string());
    let results = wait_for_worker_results(broker, pending, deadline).await?;
    Ok(results.get(worker_name).cloned())
}

async fn wait_for_worker_results(
    broker: &mut BrokerClient,
    mut pending: HashSet<String>,
    deadline: Instant,
) -> Result<BTreeMap<String, String>> {
    let mut results = BTreeMap::new();
    // Accumulate worker_stream output per worker so we have a complete
    // picture when the agent exits (rather than checking each chunk in
    // isolation which misses results that span multiple chunks).
    let mut stream_buffers: BTreeMap<String, String> = BTreeMap::new();

    while !pending.is_empty() {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline - now;

        let Some(event) = broker.next_event(remaining).await? else {
            break;
        };

        let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");

        match kind {
            // Relay message from the worker — highest priority signal.
            "relay_inbound" => {
                if let Some((worker, body)) = extract_relay_inbound_result(&event, &pending) {
                    log_result_received(&worker, "relay", &body, pending.len() - 1);
                    pending.remove(&worker);
                    results.insert(worker, body);
                }
            }
            // PTY output chunk — accumulate it, stream activity to stderr,
            // and check for an explicit RESULT: marker.
            "worker_stream" => {
                let name = event
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !pending.contains(&name) {
                    continue;
                }
                let chunk = event
                    .get("chunk")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let clean = helpers::strip_ansi(chunk);
                stream_buffers
                    .entry(name.clone())
                    .or_default()
                    .push_str(&clean);

                // Show meaningful output lines so the user can see what agents
                // are doing in real time.
                log_worker_activity(&name, &clean);

                // Check for explicit RESULT: marker in accumulated output
                // (but reject prompt echoes).
                if let Some(result) = extract_result_from_stream(&clean) {
                    log_result_received(&name, "stream", &result, pending.len() - 1);
                    pending.remove(&name);
                    results.insert(name, result);
                }
            }
            // Agent process exited or self-released — use accumulated
            // stream output as result. Covers:
            //   - agent_exited: PTY child process exited (e.g. codex finished)
            //   - agent_exit:   agent requested exit via /exit command
            //   - agent_released: agent released itself via relay_release MCP tool
            "agent_exited" | "agent_exit" | "agent_released" => {
                let name = event
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !pending.contains(&name) {
                    continue;
                }
                pending.remove(&name);

                // Use the last_output from the exit event if available,
                // otherwise fall back to what we accumulated from worker_stream.
                let last_output = event
                    .get("last_output")
                    .and_then(Value::as_str)
                    .map(|s| helpers::strip_ansi(s))
                    .unwrap_or_default();

                let accumulated = stream_buffers.remove(&name).unwrap_or_default();
                let output = if !last_output.is_empty() {
                    last_output
                } else {
                    accumulated
                };

                // Try to extract a RESULT: section; otherwise use the full output.
                let result = extract_result_from_stream(&output)
                    .unwrap_or_else(|| summarize_agent_output(&output));
                log_result_received(&name, kind, &result, pending.len());
                results.insert(name, result);
            }
            "worker_ready" => {
                let name = event.get("name").and_then(Value::as_str).unwrap_or("?");
                eprintln!("[swarm] {} is running", name);
            }
            "agent_spawned" => {
                let name = event.get("name").and_then(Value::as_str).unwrap_or("?");
                let cli = event.get("cli").and_then(Value::as_str).unwrap_or("?");
                eprintln!("[swarm] {} spawned (cli={})", name, cli);
            }
            "worker_error" => {
                let name = event.get("name").and_then(Value::as_str).unwrap_or("?");
                let error = event
                    .get("error")
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "unknown error".to_string());
                eprintln!("[swarm] {} ERROR: {}", short_worker_name(name), error);
            }
            _ => {}
        }
    }

    Ok(results)
}

/// Extract a short display name from a full worker name like
/// "swarm-team-1-41675-1772026298" → "swarm-team-1".
fn short_worker_name(full: &str) -> &str {
    // Strip the last two segments (PID and timestamp)
    full.strip_suffix(full.rfind('-').map_or("", |i| &full[i..]))
        .and_then(|s| s.strip_suffix(s.rfind('-').map_or("", |i| &s[i..])))
        .unwrap_or(full)
}

/// Log worker PTY output so the user can see what agents are doing.
/// Filters out noise (blank lines, spinner chars, cursor movement, etc.)
/// and prints meaningful lines prefixed with the worker name.
fn log_worker_activity(name: &str, clean: &str) {
    let short = short_worker_name(name);
    for line in clean.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip common CLI UI noise
        if is_cli_noise(trimmed) {
            continue;
        }
        // Truncate long lines
        let display = if trimmed.len() > 160 {
            let boundary = helpers::floor_char_boundary(trimmed, 157);
            format!("{}...", &trimmed[..boundary])
        } else {
            trimmed.to_string()
        };
        eprintln!("[{}] {}", short, display);
    }
}

/// Returns true if the line is CLI chrome / noise that shouldn't be shown.
fn is_cli_noise(line: &str) -> bool {
    // Spinner characters
    if line.starts_with('⠋')
        || line.starts_with('⠙')
        || line.starts_with('⠹')
        || line.starts_with('⠸')
        || line.starts_with('⠼')
        || line.starts_with('⠴')
        || line.starts_with('⠦')
        || line.starts_with('⠧')
        || line.starts_with('⠇')
        || line.starts_with('⠏')
    {
        return true;
    }
    // Common codex/claude UI elements
    if line.starts_with("? for shortcuts")
        || line.contains("context left")
        || line.starts_with("Thinking")
        || line == "›"
        || line.starts_with("Find and fix a bug")
    {
        return true;
    }
    false
}

/// Log a received result with a preview of the content.
fn log_result_received(worker: &str, via: &str, result: &str, remaining: usize) {
    let short = short_worker_name(worker);
    let preview = result_preview(result, 120);
    eprintln!("[swarm] {} completed via {} ({} remaining)", short, via, remaining);
    eprintln!("[swarm]   ↳ {}", preview);
}

/// Truncate a result to a readable single-line preview.
fn result_preview(text: &str, max_chars: usize) -> String {
    let oneline: String = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if oneline.len() <= max_chars {
        oneline
    } else {
        let boundary = helpers::floor_char_boundary(&oneline, max_chars.saturating_sub(3));
        format!("{}...", &oneline[..boundary])
    }
}

/// Extract a result from a `relay_inbound` event.
fn extract_relay_inbound_result(
    event: &Value,
    pending: &HashSet<String>,
) -> Option<(String, String)> {
    let from = event.get("from")?.as_str()?.to_string();
    if !pending.contains(&from) {
        return None;
    }
    let body = event
        .get("body")
        .and_then(Value::as_str)
        .map(sanitize_result)
        .filter(|value| !value.is_empty())?;
    Some((from, body))
}

/// Look for an explicit `RESULT:` marker in ANSI-stripped stream output.
/// Returns `None` if it looks like a prompt echo.
fn extract_result_from_stream(clean: &str) -> Option<String> {
    if !clean.contains("RESULT:") {
        return None;
    }
    // Reject prompt echoes
    if clean.contains("send exactly one relay") || clean.contains("Example relay output") {
        return None;
    }
    Some(sanitize_result(clean))
}

/// Condense accumulated agent output into a usable result string.
/// Strips common CLI chrome (spinners, progress bars, etc.) and trims
/// to a reasonable length.
fn summarize_agent_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "(agent exited with no output)".to_string();
    }

    // Take the last meaningful portion — CLIs often have startup noise at
    // the top and the actual result near the bottom.
    let lines: Vec<&str> = trimmed
        .lines()
        .filter(|line| {
            let l = line.trim();
            // Skip blank lines and common CLI UI elements
            !l.is_empty()
                && !l.starts_with("? for shortcuts")
                && !l.contains("context left")
                && !l.starts_with("Thinking")
                && !l.starts_with("⠋")
                && !l.starts_with("⠙")
                && !l.starts_with("⠹")
                && !l.starts_with("⠸")
                && !l.starts_with("⠼")
                && !l.starts_with("⠴")
                && !l.starts_with("⠦")
                && !l.starts_with("⠧")
                && !l.starts_with("⠇")
                && !l.starts_with("⠏")
        })
        .collect();

    if lines.is_empty() {
        return "(agent exited with no output)".to_string();
    }

    // Return the last ~50 lines to capture the result, not startup noise.
    let tail = if lines.len() > 50 {
        &lines[lines.len() - 50..]
    } else {
        &lines
    };
    tail.join("\n")
}

fn sanitize_result(raw: &str) -> String {
    let clean = helpers::strip_ansi(raw);
    let trimmed = clean.trim();

    // Handle <<<RESULT: ...>>> wrapper
    if let Some(start) = trimmed.find("<<<RESULT:") {
        let after = &trimmed[start + "<<<RESULT:".len()..];
        if let Some(end) = after.find(">>>") {
            return after[..end].trim().to_string();
        }
        return after.trim().trim_end_matches(">>>").trim().to_string();
    }

    if let Some(result) = trimmed.strip_prefix("RESULT:") {
        return result.trim().to_string();
    }
    if let Some(position) = trimmed.find("RESULT:") {
        return trimmed[position + "RESULT:".len()..].trim().to_string();
    }
    trimmed.to_string()
}

async fn cleanup_workers_and_broker(broker: &mut BrokerClient, spawned_workers: &[String]) {
    for worker_name in spawned_workers {
        if let Err(error) = broker.release_worker(worker_name).await {
            eprintln!(
                "[swarm] warning: failed to release {}: {}",
                worker_name, error
            );
        }
    }

    if let Err(error) = broker.shutdown().await {
        eprintln!(
            "[swarm] warning: failed to shutdown broker cleanly: {}",
            error
        );
    }
}

fn print_structured_output(
    summary: &SwarmSummary,
    run_id: &str,
    started_at: SystemTime,
    finished_at: SystemTime,
) -> Result<()> {
    let envelope = build_structured_output(summary, run_id, started_at, finished_at);
    println!("{}", serde_json::to_string_pretty(&envelope)?);
    Ok(())
}

fn build_structured_output(
    summary: &SwarmSummary,
    run_id: &str,
    started_at: SystemTime,
    finished_at: SystemTime,
) -> SwarmOutputEnvelope {
    let results: Vec<SwarmResultUnit> = summary
        .results
        .iter()
        .map(|(worker, output)| SwarmResultUnit {
            unit_id: worker.clone(),
            agent: worker.clone(),
            status: "completed".to_string(),
            output: output.clone(),
            tokens: SwarmTokenUsage {
                input: 0,
                output: rough_token_estimate(output),
            },
        })
        .collect();

    let errors: Vec<SwarmErrorUnit> = summary
        .timed_out
        .iter()
        .map(|worker| SwarmErrorUnit {
            unit_id: worker.clone(),
            code: "timeout".to_string(),
            message: format!("Team '{}' exceeded swarm timeout", worker),
            retryable: true,
        })
        .collect();

    let status = if errors.is_empty() {
        "completed"
    } else if !results.is_empty() {
        "partial"
    } else {
        "failed"
    }
    .to_string();

    let summary_text = if results.is_empty() {
        Some(format!(
            "No team produced a result before timeout ({}s).",
            summary.timeout_secs
        ))
    } else if errors.is_empty() {
        Some(format!(
            "Collected {} result(s) from {} team(s) using {} pattern.",
            results.len(),
            summary.teams,
            summary.pattern
        ))
    } else {
        Some(format!(
            "Collected {} result(s); {} team(s) timed out.",
            results.len(),
            errors.len()
        ))
    };

    let mut solutions: Vec<SwarmSolution> = summary
        .results
        .iter()
        .map(|(worker, output)| SwarmSolution {
            team: worker.clone(),
            status: "completed".to_string(),
            output: output.clone(),
        })
        .collect();
    solutions.extend(summary.timed_out.iter().map(|worker| SwarmSolution {
        team: worker.clone(),
        status: "timed_out".to_string(),
        output: String::new(),
    }));

    let (winner, rationale) = derive_winner(summary);
    let continuation = if status == "partial" {
        Some(SwarmContinuation {
            hint: format!(
                "Re-run with a larger --timeout (current {}s) to collect all team outputs.",
                summary.timeout_secs
            ),
        })
    } else {
        None
    };
    let used_tokens = summary
        .results
        .iter()
        .map(|(_, output)| rough_token_estimate(output))
        .sum();

    SwarmOutputEnvelope {
        run_id: run_id.to_string(),
        mode: "sync".to_string(),
        status,
        pattern: summary.pattern.clone(),
        started_at: iso_timestamp(started_at),
        finished_at: iso_timestamp(finished_at),
        summary: summary_text,
        results,
        errors,
        continuation,
        governance: SwarmGovernance {
            depth: 0,
            budgets: SwarmBudgetUsage {
                used: used_tokens,
                limit: DEFAULT_SWARM_TOKEN_LIMIT,
            },
        },
        winner,
        rationale,
        solutions,
    }
}

fn rough_token_estimate(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    if chars == 0 {
        0
    } else {
        (chars / 4).max(1)
    }
}

fn iso_timestamp(value: SystemTime) -> String {
    let datetime: DateTime<Utc> = value.into();
    datetime.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn derive_winner(summary: &SwarmSummary) -> (Option<String>, Option<String>) {
    if summary.pattern != "competitive" {
        return (None, None);
    }

    let Some((winner, output)) = summary
        .results
        .iter()
        .max_by_key(|(_, output)| output.trim().len())
    else {
        return (None, None);
    };

    let rationale = format!(
        "Selected '{}' as winner using longest completed output heuristic ({} chars).",
        winner,
        output.trim().len()
    );
    (Some(winner.clone()), Some(rationale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_timeout_supports_seconds_and_units() {
        assert_eq!(parse_timeout_secs("300").unwrap(), 300);
        assert_eq!(parse_timeout_secs("45s").unwrap(), 45);
        assert_eq!(parse_timeout_secs("5m").unwrap(), 300);
        assert_eq!(parse_timeout_secs("1h").unwrap(), 3600);
    }

    #[test]
    fn parse_timeout_rejects_invalid_values() {
        assert!(parse_timeout_secs("0").is_err());
        assert!(parse_timeout_secs("abc").is_err());
        assert!(parse_timeout_secs("10d").is_err());
    }

    #[test]
    fn structured_output_marks_partial_with_continuation() {
        let now = SystemTime::now();
        let summary = SwarmSummary {
            pattern: "fan-out".to_string(),
            teams: 2,
            timeout_secs: 300,
            elapsed: Duration::from_secs(1),
            results: vec![("swarm-team-1".to_string(), "done".to_string())],
            timed_out: vec!["swarm-team-2".to_string()],
        };

        let envelope = build_structured_output(&summary, "run_1", now, now);
        assert_eq!(envelope.status, "partial");
        assert!(envelope.continuation.is_some());
        assert_eq!(envelope.results.len(), 1);
        assert_eq!(envelope.errors.len(), 1);
    }

    #[test]
    fn structured_output_serializes_required_top_level_keys() {
        let now = SystemTime::now();
        let summary = SwarmSummary {
            pattern: "fan-out".to_string(),
            teams: 2,
            timeout_secs: 300,
            elapsed: Duration::from_secs(1),
            results: vec![("swarm-team-1".to_string(), "done".to_string())],
            timed_out: vec![],
        };

        let envelope = build_structured_output(&summary, "run_1", now, now);
        let json = serde_json::to_value(envelope).unwrap();
        let object = json.as_object().unwrap();

        assert!(object.contains_key("runId"));
        assert!(object.contains_key("mode"));
        assert!(object.contains_key("status"));
        assert!(object.contains_key("results"));
        assert!(object.contains_key("errors"));
        assert!(object.contains_key("governance"));
    }
}

struct BrokerClient {
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
    pending_events: VecDeque<Value>,
    request_seq: u64,
    stderr_last_line: Arc<Mutex<Option<String>>>,
}

impl BrokerClient {
    async fn start(
        broker_bin: &str,
        broker_name: &str,
        channels: &str,
        cwd: &Path,
    ) -> Result<Self> {
        let mut command = Command::new(broker_bin);
        command
            .arg("init")
            .arg("--name")
            .arg(broker_name)
            .arg("--channels")
            .arg(channels)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start broker binary '{}'", broker_bin))?;

        let stdin = child.stdin.take().context("broker stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("broker stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("broker stderr is unavailable")?;

        let stderr_last_line = Arc::new(Mutex::new(None));
        let stderr_sink = Arc::clone(&stderr_last_line);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(mut slot) = stderr_sink.lock() {
                    *slot = Some(line);
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_lines: BufReader::new(stdout).lines(),
            pending_events: VecDeque::new(),
            request_seq: 0,
            stderr_last_line,
        })
    }

    async fn hello(&mut self) -> Result<()> {
        let _ = self
            .request(
                "hello",
                json!({
                    "client_name": "broker-swarm",
                    "client_version": env!("CARGO_PKG_VERSION"),
                }),
            )
            .await?;
        Ok(())
    }

    async fn spawn_worker(
        &mut self,
        name: &str,
        cli: &str,
        cwd: &Path,
        initial_task: &str,
    ) -> Result<()> {
        let _ = self
            .request(
                "spawn_agent",
                json!({
                    "agent": {
                        "name": name,
                        "runtime": "pty",
                        "cli": cli,
                        "args": [],
                        "channels": ["general"],
                        "cwd": cwd.display().to_string(),
                    },
                    "initial_task": initial_task,
                }),
            )
            .await?;
        Ok(())
    }

    async fn release_worker(&mut self, name: &str) -> Result<()> {
        let _ = self
            .request(
                "release_agent",
                json!({
                    "name": name,
                    "reason": "swarm complete",
                }),
            )
            .await?;
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        let _ = self.request("shutdown", json!({})).await;
        let wait_result = timeout(Duration::from_secs(2), self.child.wait()).await;
        if wait_result.is_err() {
            let _ = self.child.kill().await;
        }
        Ok(())
    }

    async fn request(&mut self, msg_type: &str, payload: Value) -> Result<Value> {
        self.request_seq += 1;
        let request_id = format!("swarm_req_{}", self.request_seq);
        let envelope = json!({
            "v": PROTOCOL_VERSION,
            "type": msg_type,
            "request_id": request_id,
            "payload": payload,
        });

        let line = serde_json::to_string(&envelope)?;
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;

        loop {
            let next = self.next_envelope().await?;
            let response_type = next.get("type").and_then(Value::as_str).unwrap_or_default();

            if response_type == "event" {
                if let Some(payload) = next.get("payload") {
                    self.pending_events.push_back(payload.clone());
                }
                continue;
            }

            if next.get("request_id").and_then(Value::as_str) != Some(request_id.as_str()) {
                continue;
            }

            match response_type {
                "ok" => {
                    let result = next
                        .get("payload")
                        .and_then(|payload| payload.get("result"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    return Ok(result);
                }
                "hello_ack" => {
                    return Ok(next.get("payload").cloned().unwrap_or(Value::Null));
                }
                "error" => {
                    let payload = next.get("payload").cloned().unwrap_or(Value::Null);
                    let code = payload
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("error");
                    let message = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown broker error");
                    bail!(
                        "broker request '{}' failed ({}): {}",
                        msg_type,
                        code,
                        message
                    );
                }
                _ => continue,
            }
        }
    }

    async fn next_event(&mut self, duration: Duration) -> Result<Option<Value>> {
        if let Some(event) = self.pending_events.pop_front() {
            return Ok(Some(event));
        }
        if duration.is_zero() {
            return Ok(None);
        }

        let deadline = Instant::now() + duration;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }

            let wait_for = deadline - now;
            let line = match timeout(wait_for, self.stdout_lines.next_line()).await {
                Ok(result) => result?,
                Err(_) => return Ok(None),
            };

            let Some(line) = line else {
                return Ok(None);
            };

            let parsed: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };

            let message_type = parsed
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if message_type != "event" {
                continue;
            }

            if let Some(payload) = parsed.get("payload") {
                return Ok(Some(payload.clone()));
            }
        }
    }

    async fn next_envelope(&mut self) -> Result<Value> {
        loop {
            let line = self.stdout_lines.next_line().await?;
            let Some(line) = line else {
                // Stdout closed — broker likely crashed.  Wait briefly for the
                // stderr reader task to capture the last error line, then
                // include it in our bail message so callers (e.g.
                // is_broker_lock_error) can pattern-match on the real cause.
                let _ = timeout(Duration::from_millis(200), self.child.wait()).await;
                let detail = self
                    .stderr_last_line
                    .lock()
                    .ok()
                    .and_then(|value| value.clone());
                if let Some(message) = detail {
                    bail!("broker exited before response: {}", message);
                }
                bail!("broker exited before response");
            };

            if line.trim().is_empty() {
                continue;
            }

            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                return Ok(value);
            }
        }
    }
}
