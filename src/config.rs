use clap::Parser;

#[derive(Debug, Parser, Clone)]
#[command(name = "agent-relay")]
#[command(about = "Wraps an agent CLI in a PTY and bridges Relaycast messages")]
pub struct Config {
    #[arg(long)]
    pub name: Option<String>,

    #[arg(long, default_value = "general")]
    pub channels: String,

    #[arg(long, default_value_t = 3000)]
    pub human_cooldown: u64,

    #[arg(long, default_value_t = 500)]
    pub coalesce_window: u64,

    #[arg(long, default_value_t = 200)]
    pub queue_max: usize,

    #[arg(long, default_value_t = 3)]
    pub max_retries: u32,

    #[arg(long, default_value_t = 300)]
    pub retry_delay: u64,

    #[arg(long)]
    pub rows: Option<u16>,

    #[arg(long)]
    pub cols: Option<u16>,

    #[arg(long, default_value = "info")]
    pub log_level: String,

    #[arg(long)]
    pub log_file: Option<String>,

    #[arg(long, default_value_t = false)]
    pub json_output: bool,

    #[arg(long)]
    pub log_conversation: Option<String>,

    #[arg(required = true)]
    pub command: String,

    #[arg(last = true)]
    pub args: Vec<String>,
}

impl Config {
    pub fn channels_vec(&self) -> Vec<String> {
        self.channels
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::Config;
    use clap::Parser;

    #[test]
    fn defaults_match_spec() {
        let cfg = Config::parse_from(["agent-relay", "claude"]);
        assert_eq!(cfg.channels, "general");
        assert_eq!(cfg.human_cooldown, 3000);
        assert_eq!(cfg.coalesce_window, 500);
        assert_eq!(cfg.queue_max, 200);
        assert_eq!(cfg.max_retries, 3);
        assert_eq!(cfg.retry_delay, 300);
    }
}
