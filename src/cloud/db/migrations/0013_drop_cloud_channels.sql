-- Drop cloud channels system
-- These tables are being removed because channel functionality is handled by the daemon
-- The daemon has full channel protocol support (CHANNEL_JOIN, CHANNEL_MESSAGE, etc.)
-- Cloud channels were a parallel implementation that was never integrated

-- Drop message reactions first (depends on channel_messages)
DROP TABLE IF EXISTS "message_reactions" CASCADE;--> statement-breakpoint

-- Drop channel read state (depends on channels and channel_messages)
DROP TABLE IF EXISTS "channel_read_state" CASCADE;--> statement-breakpoint

-- Drop channel members (depends on channels)
DROP TABLE IF EXISTS "channel_members" CASCADE;--> statement-breakpoint

-- Drop channel messages (depends on channels)
DROP TABLE IF EXISTS "channel_messages" CASCADE;--> statement-breakpoint

-- Drop channels table
DROP TABLE IF EXISTS "channels" CASCADE;
