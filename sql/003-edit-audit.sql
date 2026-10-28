-- The edit tail, kept where the transport owns it. The frame holds the original text and
-- the current tail; this is the transport's own record of every edit, so a repeated edit
-- accumulates rather than replacing what came before.
ALTER TABLE discord_message_frame
  ADD COLUMN IF NOT EXISTS audit JSONB NOT NULL DEFAULT '[]'::jsonb;
