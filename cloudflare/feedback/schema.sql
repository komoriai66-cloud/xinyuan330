CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('private', 'public')),
  category TEXT NOT NULL CHECK(category IN ('wish', 'feedback', 'bug', 'other')),
  title TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'pending', 'visible', 'hidden', 'closed')),
  visitor_closed INTEGER NOT NULL DEFAULT 0 CHECK(visitor_closed IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_admin_at INTEGER NOT NULL DEFAULT 0,
  last_visitor_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_kind_status_created ON threads(kind, status, created_at DESC);
CREATE INDEX IF NOT EXISTS threads_updated ON threads(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK(sender IN ('visitor', 'admin')),
  body TEXT NOT NULL,
  attachment_key TEXT,
  attachment_type TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread_time ON messages(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS attachments (
  key TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_thread ON attachments(thread_id);
