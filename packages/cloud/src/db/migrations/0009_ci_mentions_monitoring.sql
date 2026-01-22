-- Add CI failure tracking, mentions/issues, and monitoring tables
-- These tables support:
-- - CI failure detection and auto-fix agents
-- - GitHub @mentions and issue assignments
-- - Agent memory monitoring and crash insights

-- ============================================================================
-- CI Failure Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS ci_failure_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
  repository VARCHAR(255) NOT NULL,
  pr_number BIGINT,
  branch VARCHAR(255),
  commit_sha VARCHAR(40),
  check_name VARCHAR(255) NOT NULL,
  check_id BIGINT NOT NULL,
  conclusion VARCHAR(50) NOT NULL,
  failure_title TEXT,
  failure_summary TEXT,
  failure_details TEXT,
  annotations JSONB DEFAULT '[]',
  workflow_name VARCHAR(255),
  workflow_run_id BIGINT,
  processed_at TIMESTAMP,
  agent_spawned BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_failure_events_repository ON ci_failure_events(repository);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_failure_events_pr_number ON ci_failure_events(pr_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_failure_events_check_name ON ci_failure_events(check_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_failure_events_created_at ON ci_failure_events(created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_failure_events_repo_pr ON ci_failure_events(repository, pr_number);

-- ============================================================================
-- CI Fix Attempts
-- ============================================================================
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ci_fix_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_event_id UUID NOT NULL REFERENCES ci_failure_events(id) ON DELETE CASCADE,
  agent_id VARCHAR(255) NOT NULL,
  agent_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  commit_sha VARCHAR(40),
  error_message TEXT,
  started_at TIMESTAMP DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_fix_attempts_failure_event ON ci_fix_attempts(failure_event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_fix_attempts_status ON ci_fix_attempts(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ci_fix_attempts_agent_id ON ci_fix_attempts(agent_id);

-- ============================================================================
-- Issue Assignments
-- ============================================================================
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS issue_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
  repository VARCHAR(255) NOT NULL,
  issue_number BIGINT NOT NULL,
  issue_title TEXT NOT NULL,
  issue_body TEXT,
  issue_url VARCHAR(512),
  agent_id VARCHAR(255),
  agent_name VARCHAR(255),
  assigned_at TIMESTAMP,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  resolution TEXT,
  linked_pr_number BIGINT,
  labels TEXT[],
  priority VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  CONSTRAINT issue_assignments_repo_issue_unique UNIQUE (repository, issue_number)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issue_assignments_repository ON issue_assignments(repository);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issue_assignments_issue_number ON issue_assignments(issue_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issue_assignments_status ON issue_assignments(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issue_assignments_agent_id ON issue_assignments(agent_id);

-- ============================================================================
-- Comment Mentions
-- ============================================================================
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS comment_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
  repository VARCHAR(255) NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  source_id BIGINT NOT NULL,
  issue_or_pr_number BIGINT NOT NULL,
  comment_body TEXT NOT NULL,
  comment_url VARCHAR(512),
  author_login VARCHAR(255) NOT NULL,
  author_id BIGINT,
  mentioned_agent VARCHAR(255) NOT NULL,
  mention_context TEXT,
  agent_id VARCHAR(255),
  agent_name VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  response_comment_id BIGINT,
  response_body TEXT,
  responded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comment_mentions_repository ON comment_mentions(repository);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comment_mentions_source ON comment_mentions(source_type, source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comment_mentions_status ON comment_mentions(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comment_mentions_mentioned_agent ON comment_mentions(mentioned_agent);

-- ============================================================================
-- Agent Metrics (memory monitoring)
-- ============================================================================
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daemon_id UUID NOT NULL REFERENCES linked_daemons(id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  pid BIGINT,
  status VARCHAR(50) NOT NULL DEFAULT 'unknown',
  rss_bytes BIGINT,
  heap_used_bytes BIGINT,
  cpu_percent BIGINT,
  trend VARCHAR(20),
  trend_rate_per_minute BIGINT,
  alert_level VARCHAR(20) DEFAULT 'normal',
  high_watermark BIGINT,
  average_rss BIGINT,
  metrics_data JSONB,
  uptime_ms BIGINT,
  started_at TIMESTAMP,
  recorded_at TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_metrics_daemon_id ON agent_metrics(daemon_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_name ON agent_metrics(agent_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_metrics_recorded_at ON agent_metrics(recorded_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_metrics_alert_level ON agent_metrics(alert_level);

-- ============================================================================
-- Agent Crashes
-- ============================================================================
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_crashes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daemon_id UUID NOT NULL REFERENCES linked_daemons(id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  pid BIGINT,
  exit_code BIGINT,
  signal VARCHAR(50),
  reason TEXT,
  likely_cause VARCHAR(50),
  confidence VARCHAR(20),
  summary TEXT,
  peak_memory BIGINT,
  last_known_memory BIGINT,
  memory_trend VARCHAR(20),
  insight_data JSONB,
  last_output TEXT,
  crashed_at TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_crashes_daemon_id ON agent_crashes(daemon_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_crashes_agent_name ON agent_crashes(agent_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_crashes_crashed_at ON agent_crashes(crashed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_crashes_likely_cause ON agent_crashes(likely_cause);

-- ============================================================================
-- Memory Alerts
-- ============================================================================
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memory_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daemon_id UUID NOT NULL REFERENCES linked_daemons(id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  current_rss BIGINT,
  threshold BIGINT,
  message TEXT,
  recommendation TEXT,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_alerts_daemon_id ON memory_alerts(daemon_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_alerts_agent_name ON memory_alerts(agent_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_alerts_alert_type ON memory_alerts(alert_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_alerts_created_at ON memory_alerts(created_at);
