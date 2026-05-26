# Three-Way Plan Debate — VHS recording
#
# Records a side-by-side demo of three named agents (planner, reviewer,
# adversarial) debating a plan in real time, communicating via the
# workspace's general channel.
#
# Strategy (third iteration — the first two failed because VHS keystrokes
# were racing Claude's boot and Opus xhigh thinking was too slow):
#   - Use --model sonnet for fast responses
#   - Use --task to deliver each agent's role via the broker's controlled
#     inject mechanism — the broker waits for Claude to be ready before
#     injecting, so the brief never gets dropped
#   - No VHS Type into Claude's prompt at all; all input goes to bash shells
#   - PlaybackSpeed 2.5x compresses the GIF
#
# Layout: planner left, reviewer top-right, adversarial bottom-right.
#
# Prereqs:
#   - `agent-relay` on PATH, `claude` authenticated, tmux 3.x, vhs >= 0.11
#
# Run from repo root:
#   vhs scripts/demos/three-way-debate.tape

Output scripts/demos/three-way-debate.gif
Output scripts/demos/three-way-debate.mp4

Set Shell "bash"
Set FontSize 13
Set Width 1920
Set Height 1080
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms
Set PlaybackSpeed 2.5

# ---------- Hidden setup ----------
Hide

Type "tmux kill-session -t debate 2>/dev/null; agent-relay down 2>/dev/null; true" Enter
Sleep 2s

Type "agent-relay up --no-spawn >/tmp/agent-relay-vhs.log 2>&1 &" Enter
Sleep 5s

# Build the 3-pane layout
Type "tmux new-session -d -s debate -x 240 -y 60" Enter
Type "tmux split-window -h -p 45 -t debate" Enter
Type "tmux split-window -v -t debate:0.1" Enter

# Spawn reviewer (top-right, pane 0.1) with its task — broker injects when Claude is ready.
# IMPORTANT: must use the verbose `new` verb (not `-n` shorthand) so --task and --model
# are parsed by agent-relay instead of being passed through to claude as unknown options.
Type `tmux send-keys -t debate:0.1 "agent-relay new reviewer claude --attach --mode passthrough --ephemeral --model sonnet --task 'Watch the general channel using mcp__relaycast__check_inbox every 20 seconds. When planner and adversarial deadlock, post a synthesis to general via mcp__relaycast__post_message and say REVIEWER ratified.'" Enter` Enter
Sleep 1s

# Spawn adversarial (bottom-right, pane 0.2) with its task
Type `tmux send-keys -t debate:0.2 "agent-relay new adversarial claude --attach --mode passthrough --ephemeral --model sonnet --task 'Watch the general channel via mcp__relaycast__check_inbox every 15 seconds. When planner posts a plan, find 3 biggest flaws and post critique via mcp__relaycast__post_message. Iterate. Say ADVERSARIAL satisfied when convinced.'" Enter` Enter
Sleep 1s

# Focus planner pane and attach VHS to tmux
Type "tmux select-pane -t debate:0.0" Enter
Type "tmux attach -t debate" Enter
Sleep 2s

# Give reviewer and adversarial time to boot and start polling
Sleep 18s

# ---------- Recording starts ----------
Show

# Spawn planner with its task — the typed command IS the visible kickoff
Type `agent-relay new planner claude --attach --mode passthrough --ephemeral --model sonnet --task "You are the planner. Two other agents are listening on the general channel: adversarial (critic) and reviewer (arbitrator). Draft a plan to migrate our auth service from session cookies to OAuth2, zero downtime, 50k DAU. Post the plan to general via mcp__relaycast__post_message. Iterate with adversarial until they ratify."`
Sleep 600ms
Enter

# Show debate: ~100s real -> ~40s in the GIF at 2.5x playback
Sleep 100s

# ---------- Cleanup ----------
Hide
Type "tmux kill-session -t debate; agent-relay down" Enter
Sleep 1s
