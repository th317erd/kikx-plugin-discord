-- Which frame a Discord message became. An edit must find the original frame without
-- touching the text already in it: the original stays intact and edits append an audit
-- tail, so both the bot and we keep the original at all times.
CREATE TABLE IF NOT EXISTS discord_message_frame (
  message_id    TEXT        PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  frame_id      TEXT        NULL,
  original_text TEXT        NOT NULL,
  edits         INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
