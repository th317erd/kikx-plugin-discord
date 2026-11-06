-- Which bot answers in a channel.
--
-- One Kikx instance may carry several Discord applications (the fleet cut-over: one
-- bot app per persona). The binding row already says WHERE an inbound message lands
-- (session_id); this says WHO answers there. 'default' means "the single legacy
-- /kikx/discord/bot/token" — the value every existing row gets — so an instance that
-- configures no per-bot tokens behaves byte-for-byte as before, and the cut-over
-- applies bindings per channel without touching rows it has not reached yet.
--
-- The seed of real bot keys is deliberately NOT here: which channel belongs to which
-- bot is per-instance operational state, applied by the operator at cut-over time
-- (UPDATE discord_channel_session SET bot_key = 'auri' WHERE channel_id = ...).
ALTER TABLE discord_channel_session
  ADD COLUMN IF NOT EXISTS bot_key TEXT NOT NULL DEFAULT 'default';
