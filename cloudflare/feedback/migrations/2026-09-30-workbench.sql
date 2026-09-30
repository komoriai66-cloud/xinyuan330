-- Run once, after the visitor-close and product migrations.
ALTER TABLE threads ADD COLUMN author_closed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN admin_seen_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN triage TEXT NOT NULL DEFAULT 'reply';
ALTER TABLE threads ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN outcome TEXT NOT NULL DEFAULT 'received';
ALTER TABLE threads ADD COLUMN outcome_note TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN resolved_version TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN outcome_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN visitor_result TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN environment TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN public_title TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN last_admin_change_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN last_visitor_change_at INTEGER NOT NULL DEFAULT 0;
UPDATE threads SET public_title = title, author_closed = CASE WHEN status = 'closed' THEN 1 ELSE 0 END,
  last_admin_change_at = last_admin_at, last_visitor_change_at = last_visitor_at;
-- A previously closed public thread stays hidden; its earlier visibility is unknown.
UPDATE threads SET status = CASE WHEN kind = 'public' THEN 'hidden' ELSE 'open' END WHERE status = 'closed';
ALTER TABLE messages ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE messages ADD COLUMN moderation TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE messages ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
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
