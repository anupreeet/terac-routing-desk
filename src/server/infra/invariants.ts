// The promises the desk makes, as queries. Tests run this after every step; the seed runs it
// before declaring success. An empty list means every promise holds.
import type { Sql } from './db';
import { POLICY, requestsPerRound, type Policy } from '../../shared/policy';

export interface Violation {
  rule: string;
  detail: string;
}

export function checkInvariants(sql: Sql, policy: Policy = POLICY): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, rows: Record<string, unknown>[]) => {
    for (const r of rows) out.push({ rule, detail: JSON.stringify({ ...r }) });
  };

  add('I1 at most one active assignment per task', sql.all(`SELECT task_id, COUNT(*) AS n FROM assignments WHERE status IN ('offered','accepted','in_progress') GROUP BY task_id HAVING n > 1`));

  add('I2 at most one pending request per task', sql.all(`SELECT task_id, COUNT(*) AS n FROM routing_attempts WHERE status = 'pending' GROUP BY task_id HAVING n > 1`));

  add('I3 routing ⇔ current_attempt_id set', sql.all(`SELECT id, status, current_attempt_id FROM tasks WHERE (status = 'routing') <> (current_attempt_id IS NOT NULL)`));

  add(
    'I3b the pointer names a pending request of the same task',
    sql.all(`SELECT t.id, t.current_attempt_id, a.task_id, a.status FROM tasks t JOIN routing_attempts a ON a.id = t.current_attempt_id
             WHERE a.task_id <> t.id OR a.status <> 'pending'`),
  );

  add(
    "I3c every pending request is its task's current request",
    sql.all(`SELECT a.id, a.task_id FROM routing_attempts a JOIN tasks t ON t.id = a.task_id
             WHERE a.status = 'pending' AND (t.current_attempt_id IS NULL OR t.current_attempt_id <> a.id)`),
  );

  add('I4 needs_attention ⇔ attention_reason set', sql.all(`SELECT id, status, attention_reason FROM tasks WHERE (status = 'needs_attention') <> (attention_reason IS NOT NULL)`));

  add(
    'I5 never a pending request and an active assignment together',
    sql.all(`SELECT a.task_id FROM routing_attempts a JOIN assignments s ON s.task_id = a.task_id
             WHERE a.status = 'pending' AND s.status IN ('offered','accepted','in_progress')`),
  );

  add(
    'I6 task status mirrors its active assignment',
    sql.all(`SELECT t.id, t.status, s.status AS assignment_status FROM tasks t
             LEFT JOIN assignments s ON s.task_id = t.id AND s.status IN ('offered','accepted','in_progress')
             WHERE NOT (
               (t.status = 'offered' AND s.status = 'offered') OR
               (t.status = 'assigned' AND s.status = 'accepted') OR
               (t.status = 'in_progress' AND s.status = 'in_progress') OR
               (t.status NOT IN ('offered','assigned','in_progress') AND s.status IS NULL)
             )`),
  );

  add(
    'I7 active load ≤ max_active',
    sql.all(`SELECT c.id, c.max_active, COUNT(s.id) AS load FROM contributors c
             JOIN assignments s ON s.contributor_id = c.id AND s.status IN ('offered','accepted','in_progress')
             GROUP BY c.id HAVING load > c.max_active`),
  );

  add('I12 engine offers carry their request; offers carry an expiry', sql.all(`SELECT id FROM assignments WHERE (source = 'engine') <> (attempt_id IS NOT NULL) OR expires_at IS NULL`));

  add('I13 at most N requests per routing round', sql.all(`SELECT task_id, round, COUNT(*) AS n FROM routing_attempts GROUP BY task_id, round HAVING n > ?`, requestsPerRound(policy)));

  add(
    'I14 final tasks hold nothing open',
    sql.all(`SELECT t.id FROM tasks t WHERE t.status IN ('completed','cancelled') AND (
               EXISTS (SELECT 1 FROM routing_attempts a WHERE a.task_id = t.id AND a.status = 'pending') OR
               EXISTS (SELECT 1 FROM assignments s WHERE s.task_id = t.id AND s.status IN ('offered','accepted','in_progress')))`),
  );

  add('I15 every task has history', sql.all(`SELECT t.id FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id)`));

  return out;
}
