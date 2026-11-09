# Cloud worker local execution opt-in

Task: connect fresh Cloud worker assignments to the existing explicit Relayflows local-agent execution option.

Decision: default stays disabled; propagate one public start flag through foreground and daemon paths. Do not infer available provider credentials or advertise new remote authority. Preserve resume refusal and nonzero runner failure handling.

Validation plan: actual command/queue/assignment boundaries with injected fetch and process dependencies; exact YAML/TS arguments, default-off, daemon, parked failure and state-bearing refusal. No worker enrollment, provider calls or deployment.

Trail CLI is unavailable in this environment; this tracked record captures the delegated decision directly.
