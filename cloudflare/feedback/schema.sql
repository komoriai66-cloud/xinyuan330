CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL DEFAULT 'ephone' CHECK(product IN ('ephone', 'uwu')),
  kind TEXT NOT NULL CHECK(kind IN ('private', 'public')),
  category TEXT NOT NULL CHECK(category IN ('wish', 'feedback', 'bug', 'other')),
  title TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'pending', 'visible', 'hidden', 'closed')),
  visitor_closed INTEGER NOT NULL DEFAULT 0 CHECK(visitor_closed IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  author_closed INTEGER NOT NULL DEFAULT 0,
  admin_seen_at INTEGER NOT NULL DEFAULT 0,
  triage TEXT NOT NULL DEFAULT 'reply' CHECK(triage IN ('reply','waiting','none')),
  snoozed_until INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'received',
  outcome_note TEXT NOT NULL DEFAULT '',
  resolved_version TEXT NOT NULL DEFAULT '',
  outcome_at INTEGER NOT NULL DEFAULT 0,
  visitor_result TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  public_title TEXT NOT NULL DEFAULT '',
  last_admin_change_at INTEGER NOT NULL DEFAULT 0,
  last_visitor_change_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_admin_at INTEGER NOT NULL DEFAULT 0,
  last_visitor_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_kind_status_created ON threads(kind, status, created_at DESC);
CREATE INDEX IF NOT EXISTS threads_updated ON threads(updated_at DESC);
CREATE INDEX IF NOT EXISTS threads_product_public ON threads(product, kind, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS threads_product_updated ON threads(product, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK(sender IN ('visitor', 'admin')),
  body TEXT NOT NULL,
  attachment_key TEXT,
  attachment_type TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retracted','removed')),
  moderation TEXT NOT NULL DEFAULT 'approved' CHECK(moderation IN ('approved','pending')),
  edited_at INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
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
CREATE INDEX IF NOT EXISTS threads_triage ON threads(product, triage, snoozed_until);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, product TEXT NOT NULL CHECK(product IN ('ephone','uwu')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','doing','paused','done')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
  review_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_review ON tasks(product, state, review_at);
CREATE TABLE IF NOT EXISTS task_threads (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, thread_id)
);
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY, product TEXT NOT NULL CHECK(product IN ('ephone','uwu')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'faq' CHECK(category IN ('faq','bug')),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
