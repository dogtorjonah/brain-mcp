-- 0004_wrapper_identity.sql
-- Persist wrapper_pid -> identity binding so respawns within a brain-claude
-- wrapper inherit the same auto-minted identity without needing the bash
-- wrapper to re-export CLAUDE_IDENTITY. The daemon resolves on every tool
-- call against this table, so the source of truth survives MCP reconnects
-- and respawns as long as the wrapper PID is the same.

CREATE TABLE IF NOT EXISTS wrapper_identity (
  wrapper_pid    INTEGER PRIMARY KEY,
  identity_name  TEXT NOT NULL REFERENCES identity_profiles(name),
  bound_at       INTEGER NOT NULL,             -- Unix epoch ms
  cwd            TEXT,                         -- cwd at first bind, for diagnostics
  source         TEXT NOT NULL DEFAULT 'mint'  -- mint | env | swap
);

CREATE INDEX IF NOT EXISTS idx_wrapper_identity_name
  ON wrapper_identity(identity_name);
