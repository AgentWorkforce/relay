-- Full-Text Search for Channel Messages (Task 5)
-- Adds PostgreSQL FTS with tsvector column and GIN index

-- Add search_vector column for full-text search
ALTER TABLE "channel_messages" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;
--> statement-breakpoint

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS "idx_channel_messages_search" ON "channel_messages" USING GIN("search_vector");
--> statement-breakpoint

-- Create index for channel-scoped search (channel_id + search)
CREATE INDEX IF NOT EXISTS "idx_channel_messages_channel_search" ON "channel_messages"("channel_id", "created_at" DESC);
--> statement-breakpoint

-- Create function to update search_vector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION update_channel_message_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.sender_name, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.body, '')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Create trigger to auto-update search_vector
DROP TRIGGER IF EXISTS channel_message_search_vector_trigger ON "channel_messages";
CREATE TRIGGER channel_message_search_vector_trigger
  BEFORE INSERT OR UPDATE OF body, sender_name ON "channel_messages"
  FOR EACH ROW
  EXECUTE FUNCTION update_channel_message_search_vector();
--> statement-breakpoint

-- Backfill existing messages with search vectors
UPDATE "channel_messages"
SET search_vector =
  setweight(to_tsvector('english', COALESCE(sender_name, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(body, '')), 'A')
WHERE search_vector IS NULL;
--> statement-breakpoint

-- Add GIN index for mentions array (for Task 6 filtering)
CREATE INDEX IF NOT EXISTS "idx_channel_messages_mentions" ON "channel_messages" USING GIN("mentions");
