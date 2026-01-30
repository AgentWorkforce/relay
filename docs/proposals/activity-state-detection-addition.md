# Proposed Addition to Progress Tracker Sidecar Spec

> **Location**: Add as section "3.5 Activity State Detector" between "Pattern Analyzer" and "Reminder System"

---

## 3.5 Activity State Detector

**Purpose:** Provide fast, deterministic activity state detection without LLM overhead

The Pattern Analyzer (section 3) uses LLM for intelligent analysis, but has latency and cost implications. The Activity State Detector provides a complementary **sub-second detection layer** using velocity analysis and pattern matching—inspired by [NTM's detection system](https://github.com/Dicklesworthstone/ntm).

### Activity States

| State | Description | Detection Method |
|-------|-------------|------------------|
| `waiting` | At prompt, awaiting input | Prompt pattern match |
| `thinking` | Processing/planning | Thinking indicator patterns |
| `generating` | Actively outputting text | Output velocity > 10 chars/sec |
| `tool_executing` | Running a tool | Tool start patterns |
| `compacting` | Context window compaction | Compaction patterns |
| `error` | Error encountered | Error patterns |
| `stalled` | Stuck in same state too long | Time threshold exceeded |
| `idle` | No activity for extended period | Velocity = 0 for > 30s |

### Detection Algorithm

The detector combines three signal types:

#### 1. Velocity Analysis

Measure output rate by comparing character counts between captures:

```typescript
// Velocity thresholds (chars/sec)
HIGH_VELOCITY    = 10.0  // → generating
MEDIUM_VELOCITY  = 2.0   // → generating (slower)
LOW_VELOCITY     = 1.0   // → thinking or transitioning
IDLE_VELOCITY    = 0.0   // → waiting or stalled
```

**Implementation notes:**
- Count Unicode runes, not bytes
- Strip ANSI escape sequences before counting
- Negative deltas (scroll/clear) treated as zero
- Use circular buffer of 10 samples for smoothing

#### 2. Pattern Matching

Apply CLI-specific regex patterns in priority order:

```typescript
// Priority: Error > Compacting > Tool > Thinking > Prompt > Velocity

const PATTERNS = {
  // Universal - all CLIs
  thinking: [
    /⏺\s*Thinking/i,
    /●\s*Thinking/i,
    /\.{3,}$/,                    // Trailing dots
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,            // Braille spinner
  ],
  
  tool_executing: [
    /●\s*(Read|Write|Edit|Bash|Glob|Grep|Task)/,
    /⏺\s*(Read|Write|Edit|Bash|Glob|Grep|Task)/,
  ],
  
  error: [
    /(?i)rate.?limit/,
    /(?i)429|too many requests/,
    /(?i)API.?error|exception/,
    /(?i)panic:|SIGSEGV|fatal/,
    /(?i)connection (refused|timeout)/,
  ],
  
  compacting: [
    /(?i)context.*compact/,
    /(?i)auto-compact triggered/,
    /(?i)summarizing.*conversation/,
  ],
  
  // CLI-specific prompts
  claude_prompt: [
    /(?i)claude\s*>?\s*$/,
    /╰─>\s*$/,
  ],
  
  codex_prompt: [
    /(?i)codex\s*>?\s*$/,
    /\$\s*$/,
  ],
  
  gemini_prompt: [
    /(?i)gemini\s*>?\s*$/,
    />>>\s*$/,
  ],
};
```

#### 3. Temporal Analysis

Track time in current state to detect stalls:

```typescript
// Stall thresholds per state
const STALL_THRESHOLDS = {
  thinking:       60_000,   // 1 min thinking is suspicious
  tool_executing: 300_000,  // 5 min tool execution suspicious
  generating:     30_000,   // 30s no new output while "generating"
  default:        120_000,  // 2 min default
};
```

### Hysteresis (Anti-Flicker)

Prevent rapid state oscillation:
- Transitions require **2 seconds of stability**
- **Exception:** Error states activate immediately (safety-critical)
- First detection establishes baseline immediately

### Data Structures

```typescript
interface ActivitySnapshot {
  state: ActivityState;
  since: number;           // Timestamp when entered this state
  duration: number;        // Time in current state (ms)
  confidence: number;      // 0-1, detection confidence
  tool?: string;           // If tool_executing, which tool
  error?: string;          // If error, the message
  velocity: number;        // Current chars/sec
  tokenVelocity: number;   // Estimated tokens/min (~velocity/4*60)
}

interface StateTransition {
  from: ActivityState;
  to: ActivityState;
  timestamp: number;
  trigger: string;         // What caused transition
}
```

### Integration with Pattern Analyzer

The Activity State Detector and Pattern Analyzer work together:

```
Log/Output Stream
       │
       ▼
┌──────────────────────┐
│ Activity State       │  ← Fast (< 100ms)
│ Detector             │  ← Deterministic
│ (velocity + patterns)│  ← Runs every poll
└──────────┬───────────┘
           │
           ▼
    state = 'stalled' OR 
    state = 'error' OR
    duration > threshold?
           │
     yes   │   no
           │    └─────────────────────────────┐
           ▼                                   │
┌──────────────────────┐                      │
│ Pattern Analyzer     │  ← Slower (1-5s)     │
│ (LLM-powered)        │  ← Expensive         │
│                      │  ← Only when needed  │
└──────────┬───────────┘                      │
           │                                   │
           ▼                                   │
    recommendation                        continue
    (remind/escalate/                     monitoring
     restart/none)
```

**Benefits:**
- Fast detection: < 100ms vs 1-5s for LLM
- Cost reduction: Only invoke LLM when needed
- Accuracy: Deterministic for known patterns, LLM for ambiguous cases
- Real-time dashboard: Activity state updates every poll cycle

### Health Score Computation

Aggregate activity signals into a composite health score:

```typescript
function computeHealth(activity: ActivitySnapshot): HealthState {
  // Priority order (highest = most severe)
  
  if (activity.state === 'error') {
    return { status: 'unhealthy', reason: activity.error };
  }
  
  if (activity.state === 'stalled' && activity.duration > 300_000) {
    return { status: 'unhealthy', reason: 'Stalled > 5 min' };
  }
  
  if (activity.state === 'stalled') {
    return { status: 'degraded', reason: 'Agent stalled' };
  }
  
  if (activity.state === 'idle' && activity.duration > 300_000) {
    return { status: 'degraded', reason: 'Idle > 5 min' };
  }
  
  return { status: 'healthy' };
}
```

### Dashboard Display

Real-time activity state in agent cards:

```
┌─────────────────────────────────────────┐
│  Agent: Frontend                        │
│  ┌─────┐                                │
│  │ 🟢 │ generating  (2m 34s)           │
│  └─────┘                                │
│  Velocity: 847 tok/min                  │
│  Tool: —                                │
│  Health: healthy                        │
└─────────────────────────────────────────┘
```

State indicators:
- 🔵 `waiting` - Ready for input
- 🟡 `thinking` - Processing (pulse animation)
- 🟢 `generating` - Active output
- 🟣 `tool_executing` - Running tool
- 🟠 `stalled` - Needs attention (pulse animation)
- 🔴 `error` - Error state
- ⚪ `idle` - No recent activity

### Configuration

```typescript
interface ActivityDetectorConfig {
  // Velocity thresholds
  highVelocityThreshold: number;    // Default: 10.0 chars/sec
  mediumVelocityThreshold: number;  // Default: 2.0 chars/sec
  idleVelocityThreshold: number;    // Default: 1.0 chars/sec
  
  // Time thresholds
  stallThresholdMs: number;         // Default: 30000 (30s)
  idleThresholdMs: number;          // Default: 30000 (30s)
  hysteresisMs: number;             // Default: 2000 (2s)
  
  // Buffer sizes
  velocitySampleCount: number;      // Default: 10
  transitionHistoryCount: number;   // Default: 20
  
  // CLI type (affects pattern selection)
  cliType: 'claude' | 'codex' | 'gemini' | 'other';
}
```

### Implementation Notes

1. **ANSI stripping**: Use a robust ANSI stripper before analysis
2. **Unicode handling**: Count runes, not bytes
3. **Buffer management**: Circular buffers with fixed size
4. **Thread safety**: Detector may be called from poll loop and API
5. **Metrics**: Emit Prometheus metrics for state durations
6. **Events**: Publish state transitions to event bus

---

## Beads Task Addition

Add to `docs/PROGRESS_TRACKER_BEADS_TASKS.md`:

```
## Task: activity-state-detector
parent: progress-tracker
effort: 8h
priority: high

Implement fast, deterministic activity state detection layer.

### Subtasks
- [ ] ActivityState enum and types (1h)
- [ ] VelocityTracker with circular buffer (2h)
- [ ] CLI-specific pattern definitions (1h)
- [ ] State machine with hysteresis (2h)
- [ ] Health score computation (1h)
- [ ] Integration with polling loop (1h)

### Acceptance Criteria
- [ ] Detects all 8 activity states
- [ ] < 100ms detection latency
- [ ] Hysteresis prevents state flicker
- [ ] Dashboard shows real-time activity
- [ ] Unit tests for all state transitions
```

---

## References

- [NTM Activity Detection](https://github.com/Dicklesworthstone/ntm) - Inspiration for velocity + pattern approach
- Competitor analysis in `docs/competitive/NTM_ANALYSIS.md` (proposed)
