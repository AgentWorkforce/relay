use super::*;

/// Connection metadata discovered from a running broker — typically by
/// reading `<state-dir>/connection.json` or from explicit CLI flags / env.
pub(crate) struct BrokerConnection {
    base_url: String,
    api_key: Option<String>,
}

/// Resolve the broker connection by checking, in order:
///
/// 1. Explicit CLI args (`--broker-url`, `--api-key`). When `--broker-url`
///    is supplied without an API key, we still attempt to fall back to the
///    API key from env / `.agentworkforce/relay/connection.json` so users don't have
///    to repeat `--api-key` for every dump-pty invocation.
/// 2. Env vars `RELAY_BROKER_URL` / `RELAY_BROKER_API_KEY`.
/// 3. `connection.json` in the supplied state dir, otherwise
///    `.agentworkforce/relay/connection.json` directly under the current working
///    directory. The bare `cwd` is intentionally NOT probed — an unrelated
///    `connection.json` sitting in the user's repo root must not silently
///    redirect the snapshot request (and its broker API key) elsewhere.
pub(crate) fn discover_broker_connection(
    explicit_url: Option<&str>,
    explicit_api_key: Option<&str>,
    state_dir: Option<&Path>,
) -> Result<BrokerConnection> {
    // Walk the same search roots used for the URL fallback, but only to
    // pull out a stored `api_key`. Lets `--broker-url` reuse the broker's
    // saved key when the env var and `--api-key` are both unset.
    let api_key_from_connection_file = || -> Option<String> {
        let cwd = std::env::current_dir().ok()?;
        let roots: Vec<PathBuf> = match state_dir {
            Some(dir) => vec![dir.to_path_buf()],
            None => vec![cwd.join(".agentworkforce/relay")],
        };
        for root in roots {
            let path = root.join("connection.json");
            if !path.is_file() {
                continue;
            }
            let body = std::fs::read_to_string(&path).ok()?;
            let value: Value = serde_json::from_str(&body).ok()?;
            if let Some(key) = value.get("api_key").and_then(Value::as_str) {
                if !key.trim().is_empty() {
                    return Some(key.to_string());
                }
            }
        }
        None
    };

    let resolve_api_key = |explicit: Option<&str>| -> Option<String> {
        explicit
            .map(ToString::to_string)
            .or_else(|| std::env::var("RELAY_BROKER_API_KEY").ok())
            .or_else(api_key_from_connection_file)
            .filter(|value| !value.trim().is_empty())
    };

    if let Some(url) = explicit_url {
        return Ok(BrokerConnection {
            base_url: url.trim_end_matches('/').to_string(),
            api_key: resolve_api_key(explicit_api_key),
        });
    }

    if let Ok(url) = std::env::var("RELAY_BROKER_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Ok(BrokerConnection {
                base_url: trimmed.trim_end_matches('/').to_string(),
                api_key: resolve_api_key(explicit_api_key),
            });
        }
    }

    let cwd = std::env::current_dir().context("failed to read current directory")?;
    let search_roots: Vec<PathBuf> = match state_dir {
        Some(dir) => vec![dir.to_path_buf()],
        None => vec![cwd.join(".agentworkforce/relay")],
    };

    for root in &search_roots {
        let path = root.join("connection.json");
        if !path.is_file() {
            continue;
        }
        let body = std::fs::read_to_string(&path)
            .with_context(|| format!("failed reading {}", path.display()))?;
        let value: Value = serde_json::from_str(&body)
            .with_context(|| format!("failed parsing {}", path.display()))?;
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .with_context(|| format!("connection file missing 'url': {}", path.display()))?
            .to_string();
        let api_key = explicit_api_key
            .map(ToString::to_string)
            .or_else(|| std::env::var("RELAY_BROKER_API_KEY").ok())
            .or_else(|| {
                value
                    .get("api_key")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .filter(|value| !value.trim().is_empty());
        return Ok(BrokerConnection {
            base_url: url.trim_end_matches('/').to_string(),
            api_key,
        });
    }

    anyhow::bail!(
        "could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, \
         or run from a directory containing .agentworkforce/relay/connection.json"
    );
}

/// `agent-relay-broker dump-pty <name>` — capture and print a worker's
/// current visible screen by hitting the broker's snapshot route.
pub(crate) async fn run_dump_pty(cmd: DumpPtyCommand) -> Result<()> {
    use base64::Engine;

    let connection = discover_broker_connection(
        cmd.broker_url.as_deref(),
        cmd.api_key.as_deref(),
        cmd.state_dir.as_deref(),
    )?;

    let url = format!(
        "{}/api/spawned/{}/snapshot?format={}",
        connection.base_url,
        urlencoding::encode(&cmd.name),
        cmd.format.as_wire_str(),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("failed to build http client")?;

    let mut request = client.get(&url);
    if let Some(key) = connection.api_key.as_deref() {
        request = request.header("X-API-Key", key);
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("failed reaching broker at {url}"))?;
    let status = response.status();
    let body_bytes = response
        .bytes()
        .await
        .context("failed reading broker response body")?;

    if !status.is_success() {
        let body_str = String::from_utf8_lossy(&body_bytes);
        anyhow::bail!("broker returned {status}: {body_str}");
    }

    let body: Value =
        serde_json::from_slice(&body_bytes).context("broker response was not valid JSON")?;
    let screen = body
        .get("screen")
        .and_then(Value::as_str)
        .context("broker response missing 'screen' field")?;

    match cmd.format {
        DumpPtyFormat::Plain => {
            // The plain payload already includes the trailing newline per row.
            // Print as-is so pipelines see a stable terminator.
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            stdout
                .write_all(screen.as_bytes())
                .context("failed writing snapshot to stdout")?;
            stdout.flush().ok();
        }
        DumpPtyFormat::Ansi => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(screen)
                .context("broker returned non-base64 ansi screen")?;
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            stdout
                .write_all(&bytes)
                .context("failed writing snapshot to stdout")?;
            stdout.flush().ok();
        }
    }

    Ok(())
}
