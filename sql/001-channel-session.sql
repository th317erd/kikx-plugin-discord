-- Which Kikx session a Discord channel feeds. A transport needs this to know where an
-- inbound message belongs; without it a message has nowhere to land.
CREATE TABLE IF NOT EXISTS discord_channel_session (
  channel_id TEXT        PRIMARY KEY,
  session_id TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
