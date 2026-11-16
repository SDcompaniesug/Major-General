CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  antilink BOOLEAN NOT NULL DEFAULT FALSE,
  ai_moderation BOOLEAN NOT NULL DEFAULT FALSE,
  rules TEXT NOT NULL DEFAULT 'Be respectful. No spam or unauthorized links.',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS warnings (
  id BIGSERIAL PRIMARY KEY,
  group_jid TEXT NOT NULL REFERENCES groups(jid) ON DELETE CASCADE,
  user_jid TEXT NOT NULL,
  reason TEXT NOT NULL,
  moderator_jid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS warnings_group_user_idx ON warnings(group_jid,user_jid);
CREATE TABLE IF NOT EXISTS moderation_events (
  id BIGSERIAL PRIMARY KEY,
  group_jid TEXT NOT NULL,
  user_jid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
