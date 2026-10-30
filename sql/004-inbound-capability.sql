-- Which Discord users may feed a channel into a session, and from where.
--
-- PluginAuthority derives this name from the plugin id (`discord_` + `capability`), so it
-- is the table `PluginAuthority` already looks for - there is no second grant mechanism
-- here. It did not exist before, which meant the inbound path had no way to be both
-- strict and usable: a gate with no table to read denies everyone.
--
-- Deny by default: a grant must exist and match. scope_json narrows a grant to one
-- channel; NULL means "no narrowing", never "everything".
--
-- A PRIMARY KEY cannot contain an expression in PostgreSQL, so the NULL-tolerant
-- uniqueness lives in a unique index instead. The index expression must match, byte for
-- byte, the ON CONFLICT target used by PluginAuthority.grant().
CREATE TABLE IF NOT EXISTS discord_capability (
  actor      TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  scope_json JSONB       NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT        NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS discord_capability_unique
  ON discord_capability (actor, action, COALESCE(scope_json::text, ''));
