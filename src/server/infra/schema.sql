-- Terac Routing Desk schema. Rows are the truth; `events` is an append-only log written in the
-- same transaction as every change. Invariants that the database can enforce, it enforces.
-- There is no migration framework: a schema change means `npm run reset` (see meta.schema_version).

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS expertise_areas (id TEXT PRIMARY KEY, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS contributors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  headline TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available','away')),
  max_active INTEGER NOT NULL DEFAULT 2 CHECK (max_active BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contributor_expertise (
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  expertise_id TEXT NOT NULL REFERENCES expertise_areas(id),
  PRIMARY KEY (contributor_id, expertise_id)
);
CREATE INDEX IF NOT EXISTS ix_expertise_area ON contributor_expertise(expertise_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,                       -- shown as T-101
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  brief TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  expertise_id TEXT NOT NULL REFERENCES expertise_areas(id),
  priority TEXT NOT NULL CHECK (priority IN ('high','normal','low')),
  status TEXT NOT NULL CHECK (status IN ('new','routing','offered','assigned','in_progress',
                                         'completed','needs_attention','cancelled')),
  attention_reason TEXT CHECK (attention_reason IN ('no_eligible_contributors','no_match','routing_exhausted',
                                                    'declined','offer_expired','failed_before_start')),
  round INTEGER NOT NULL DEFAULT 0,
  current_attempt_id INTEGER REFERENCES routing_attempts(id),    -- the fencing pointer
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  closed_at INTEGER,
  CHECK ((status = 'needs_attention') = (attention_reason IS NOT NULL)),
  CHECK ((status = 'routing') = (current_attempt_id IS NOT NULL)),
  CHECK ((status IN ('completed','cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks(status, priority, created_at);

CREATE TABLE IF NOT EXISTS routing_attempts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  round INTEGER NOT NULL,
  seq INTEGER NOT NULL,                                       -- shown as request #seq
  retry_index INTEGER NOT NULL CHECK (retry_index BETWEEN 0 AND 2),
  status TEXT NOT NULL CHECK (status IN ('pending','matched','no_match','invalid_result','timed_out','abandoned')),
  abandon_reason TEXT CHECK (abandon_reason IN ('operator_offer','operator_reroute','operator_stop','task_cancelled')),
  candidates_json TEXT NOT NULL,                              -- frozen at dispatch
  excluded_json TEXT NOT NULL DEFAULT '[]',
  dispatched_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  closed_at INTEGER,
  result_kind TEXT CHECK (result_kind IN ('match','no_match')),  -- written at most once, on time or late
  result_contributor_id INTEGER REFERENCES contributors(id),
  result_at INTEGER,                                          -- when the answer reached our inbox
  result_reason TEXT,
  invalid_reason TEXT,
  UNIQUE (task_id, seq),
  CHECK ((status = 'pending') = (closed_at IS NULL)),
  CHECK ((status = 'abandoned') = (abandon_reason IS NOT NULL)),
  CHECK ((result_kind IS NULL) = (result_at IS NULL))
);
-- At most one pending request per task.
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_pending_attempt ON routing_attempts(task_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_attempts_due ON routing_attempts(deadline_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  source TEXT NOT NULL CHECK (source IN ('engine','operator')),
  attempt_id INTEGER REFERENCES routing_attempts(id),
  status TEXT NOT NULL CHECK (status IN ('offered','accepted','in_progress','completed','declined',
                                         'expired','revoked','withdrawn','released','cancelled')),
  offered_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  note TEXT,
  CHECK ((source = 'engine') = (attempt_id IS NOT NULL)),
  CHECK ((status IN ('offered','accepted','in_progress')) = (ended_at IS NULL))
);
-- At most one active assignee per task.
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_assignment ON assignments(task_id)
  WHERE status IN ('offered','accepted','in_progress');
CREATE INDEX IF NOT EXISTS ix_active_by_contributor ON assignments(contributor_id)
  WHERE status IN ('offered','accepted','in_progress');
CREATE INDEX IF NOT EXISTS ix_offers_due ON assignments(expires_at) WHERE status = 'offered';
CREATE INDEX IF NOT EXISTS ix_assignments_task ON assignments(task_id, status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,                       -- ordering is by id, never by `at`
  at INTEGER NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  attempt_id INTEGER,
  assignment_id INTEGER,
  contributor_id INTEGER,
  type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('operator','engine','system','contributor','simulator')),
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_events_task ON events(task_id, id);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- ── SIMULATION: the outside world (the routing engine and the contributors). ─────────────────
-- Only src/server/sim/** reads or writes these tables. Desk code never sees a request's fate.
CREATE TABLE IF NOT EXISTS sim_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('engine_result','contributor_response')),
  ref_id INTEGER NOT NULL,                                    -- attempt id or assignment id
  due_at INTEGER,                                             -- NULL = never delivered
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sim_due ON sim_jobs(due_at)
  WHERE delivered_at IS NULL AND cancelled_at IS NULL AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sim_ref ON sim_jobs(kind, ref_id);

CREATE TABLE IF NOT EXISTS sim_task_scenarios (
  task_id INTEGER PRIMARY KEY,
  engine TEXT NOT NULL DEFAULT 'realistic',
  contributor TEXT NOT NULL DEFAULT 'manual',
  contributor_used INTEGER NOT NULL DEFAULT 0
);
