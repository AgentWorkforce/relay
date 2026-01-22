-- Agent Relay Cloud - Agent Sessions and Summaries
-- Migration: 0002_agent_sessions.sql
-- Adds cloud persistence tables for PtyWrapper events

-- Agent sessions - tracks lifecycle of agent instances
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  started_at TIMESTAMP DEFAULT NOW() NOT NULL,
  ended_at TIMESTAMP,
  end_marker JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_id ON agent_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_name ON agent_sessions(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

-- Agent summaries - stores [[SUMMARY]] blocks from agent output
CREATE TABLE IF NOT EXISTS agent_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_summaries_session_id ON agent_summaries(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_summaries_agent_name ON agent_summaries(agent_name);

-- Add comment documenting the event flow
COMMENT ON TABLE agent_sessions IS 'Tracks agent session lifecycle. Populated by CloudPersistenceService from PtyWrapper session-end events.';
COMMENT ON TABLE agent_summaries IS 'Stores agent progress summaries. Populated by CloudPersistenceService from PtyWrapper summary events.';
COMMENT ON COLUMN agent_sessions.end_marker IS 'JSON from [[SESSION_END]] block: {summary?: string, completedTasks?: string[]}';
COMMENT ON COLUMN agent_summaries.summary IS 'JSON from [[SUMMARY]] block: {currentTask?, completedTasks?, decisions?, context?, files?}';
