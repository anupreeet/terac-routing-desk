# 04 — Architecture & Verification

> **SUPERSEDED — input only.** This is a pre-synthesis dimension draft. Where it disagrees with `PLAN.md` (statuses, restart model, API shapes, numbers, CLAUDE.md text), `PLAN.md` wins. Do not implement from this file.

> Dimension owner: Architecture & Verification. Covers the stack, code structure, persistence mechanics, the HTTP API, error handling and logging, the test and verification strategy, observability, and notes on the path to production.
> Interacts with: **Domain & State** (states, reason codes, event types), **Engine, Time & Concurrency** (fencing, deadlines, retry policy, sim behaviour), **Operator UX** (what the API must serve), **Delivery & Agentic Process** (build order, timeline, Loom).
> Tags: **MUST** / **SHOULD** / **COULD** / **WON'T** against the 5-hour total budget.

---

## 0. TL;DR

| # | Decision | Tag |
|---|---|---|
| A1 | **Single npm package** with `src/server`, `src/client`, `src/shared`. No workspaces. | MUST |
| A2 | **Express 5** + **zod v4** at every boundary. No Fastify. | MUST |
| A3 | **`node:sqlite` (`DatabaseSync`)**, built into Node 26.5. Verified locally: SQLite 3.53.4, partial unique indexes, `RAISE(ABORT)` triggers and `BEGIN IMMEDIATE/ROLLBACK` all work, no experimental warning. better-sqlite3 is the fallback behind a 3-method wrapper. | MUST |
| A4 | **Raw SQL** in one `store/` module. No ORM or query builder. CAS guards stay visible as `WHERE … AND status='pending'` with `changes` checked. | MUST |
| A5 | **React 19 + Vite + TanStack Query v5 + Tailwind v4**, no component kit. | MUST |
| A6 | **Polling at 1 s** (`GET /api/snapshot`), not SSE. The client derives ages and countdowns from a server-time offset. | MUST |
| A7 | **Commands are the only writers.** Each one is a single synchronous `BEGIN IMMEDIATE` transaction. Task invariants are asserted *before COMMIT*, and engine dispatch happens *after COMMIT*. | MUST |
| A8 | **One deterministic `tick(now)`** runs (1) the sim pump, then (2) the reconciler. A 500 ms interval drives it in prod. Tests call it directly with a `FakeClock`, so tests run no real timers. | MUST |
| A9 | **The engine sim is durable** (`sim_jobs` table). It stands in for an external service that outlives our process (baseline option **B**). | MUST (flagged divergence → Engine) |
| A10 | Test harness + invariant checker + 6 core scenario tests + 1 restart test + 4 API tests = **MUST**. The other 6 scenarios and the fast-check fuzz are **SHOULD**. Playwright is **WON'T**; a written manual checklist is **MUST**. | — |

**What I'd tell the reviewer:** *"One Node process and a synchronous SQLite handle, so every state change is a short serialized transaction. Concurrency then comes down to the order things arrive in, which I can replay deterministically with a fake clock and fuzz with fast-check."*

---

## 1. Stack decisions

### 1.1 Runtime: Node 26.5 + tsx, not bun — MUST
- **Choice:** Node 26.5 runs the server through `tsx` (`tsx watch` in dev, `tsx` in "prod"). There is no server build step. `tsc --noEmit` does type checking only.
- **Alternatives:** bun (has `bun:sqlite` and is fast, but not the candidate's daily driver, and Vitest/supertest on bun adds risk). Node's native type stripping (`node --watch file.ts`) drops a dependency but rejects enums and parameter properties and requires `.ts` import extensions.
- **Why:** it is familiar and has zero surprises. tsx handles ESM, extensionless imports and watch mode.
- **Reviewer line:** "Boring runtime on purpose. The interesting part is the state machine."

### 1.2 HTTP: Express 5, not Fastify — MUST
- **Choice:** Express 5. Rejected async handlers reach the error middleware natively, so `express-async-errors` isn't needed.
- **Alternatives:** Fastify. It has schema-first routes and is faster, but needs a zod type provider and plugin setup, and it's unfamiliar here. Hono is nice but again unfamiliar.
- **Why:** the API is about 15 routes with low traffic. Familiarity is worth more than throughput here, and supertest works out of the box.
- **Reviewer line:** "Express 5 because I can make it correct quickly. Validation is zod at the edge either way."

### 1.3 SQLite driver: `node:sqlite` — MUST
- **Choice:** `DatabaseSync` from `node:sqlite`. I checked this locally on the candidate's machine: `DatabaseSync` exists, `sqlite_version()` = 3.53.4, partial unique indexes and `RAISE(ABORT)` triggers work, `db.isTransaction` exists, and the import prints no experimental warning.
- **Alternatives:** `better-sqlite3`. It's mature and has `db.transaction()`, but it is a native addon. Node 26 may lack prebuilt binaries, which means a node-gyp compile, which is a real risk of losing 30+ minutes. `bun:sqlite` is out with bun.
- **Why:** no native dependency and the same synchronous semantics, which are what we actually want (see §2). The one thing missing is a transaction helper, which takes 15 lines (§4.2).
- **Risk and mitigation:** Vitest/Vite may not externalize `node:sqlite` in some versions. **T+0 spike (5 min):** a test that opens `:memory:` and runs one query. If it fails, try `server.deps.external` or `pool: 'forks'`, and then swap to better-sqlite3. Our `db.ts` wrapper exposes only `exec`, `prepare().get/all/run`, and `tx`, which both drivers share, so the swap takes about 10 minutes.
- **Reviewer line:** "Built-in SQLite: synchronous, no native build, and the partial unique indexes enforce my invariants in the database."

### 1.4 Data access: raw SQL — MUST
- **Choice:** hand-written SQL in `src/server/store/repo.ts`, with typed row interfaces and small `toTask(row)` mappers. Every guarded write returns `changes` and the caller checks it.
- **Alternatives:** Drizzle or Kysely (better typing, but setup cost and uncertain `node:sqlite` dialect support). Prisma (heavy, async, hides transactions).
- **Why:** the core logic of this exercise is compare-and-set. I want `UPDATE routing_attempts SET status='timed_out' WHERE id=? AND status='pending'` visible in code review and in the Loom, not hidden behind a builder.
- **Reviewer line:** "The fencing rules are literally the WHERE clauses."

### 1.5 Package layout: single package — MUST (flagged divergence: baseline left it open)
- **Choice:** one `package.json` with `src/server`, `src/client`, `src/shared`, one `tsconfig.json` (`moduleResolution: "Bundler"`, `strict`, `noUncheckedIndexedAccess`, `jsx: react-jsx`, `lib: [ES2023, DOM]`), and **relative imports with no path aliases**, so tsx, Vite and Vitest need no alias config.
- **Alternatives:** npm workspaces (`packages/server|client|shared`). That means build ordering for `shared`, TS project references, and three `package.json` files, all for no benefit at this size.
- **Why:** it's the fewest moving parts. The `shared/` rule is enforced by convention: it may import only `zod`, never `node:*` or `react`.
- **Reviewer line:** "One package; `shared/` holds the zod contracts both sides compile against."

### 1.6 Frontend: React 19 + Vite + TanStack Query v5 + Tailwind v4, no kit — MUST
- **Choice:** Tailwind v4 via `@tailwindcss/vite`, plus hand-rolled primitives (Badge, Button, Drawer via native `<dialog>`, Countdown). No shadcn, Radix or date library. A 10-line `formatDuration(ms)` produces strings like "2m 14s".
- **Alternatives:** shadcn/ui (good-looking, but the init and copy-paste cost about 20 minutes, which we can't spare). Mantine or MUI (heavy and generic-looking).
- **Why:** the UI is one dense operator screen. Tailwind plus 5 primitives covers it. Operator UX owns how it looks.
- **COULD:** `lucide-react` icons (2 minutes).

### 1.7 Live updates: polling, not SSE — MUST
- **Choice:** TanStack Query `refetchInterval: 1000` on `GET /api/snapshot`, plus `GET /api/tasks/:id` while the detail drawer is open. `refetchIntervalInBackground: false`. After any command, the response replaces the detail cache and invalidates the snapshot.
- **Alternatives:** SSE (lower latency, but needs reconnect handling and a resync-on-reconnect, and that resync *is* the snapshot fetch anyway). WebSockets (overkill).
- **Why:** polling survives server restarts with no extra code, which matters because restarts are a first-class scenario. The snapshot is small (under 50 tasks, about 10 contributors, under 30 KB). One second of staleness is fine, because ages and countdowns tick locally every 250 ms from `serverTime`.
- **Client clock:** `offset = snapshot.serverTime - Date.now()` measured at receipt, using the median of the last 5 measurements. `useNow()` returns `Date.now() + offset` every 250 ms. Every age or countdown is `useNow() - createdAt` or `deadlineAt - useNow()`. Server timestamps are **epoch-ms integers** everywhere, in the DB and the API alike.
- **Reviewer line:** "Polling because restarts are part of the brief. A reconnecting stream would just be a snapshot fetch with more code."

### 1.8 Dev ergonomics — MUST
```jsonc
// package.json scripts
"dev":        "concurrently -k -n api,web -c blue,magenta \"npm:dev:api\" \"npm:dev:web\"",
"dev:api":    "tsx watch src/server/main.ts",          // :3001
"dev:web":    "vite",                                   // :5173, proxies /api -> :3001
"reset":      "tsx scripts/reset.ts",                   // drop file, migrate, seed (refuses if server heartbeat < 3s old)
"test":       "vitest run",
"test:watch": "vitest",
"typecheck":  "tsc --noEmit",
"check":      "npm run typecheck && npm test",
"inspect":    "tsx scripts/inspect.ts"                  // COULD: npm run inspect -- T-104
```
- `dev:api` and `dev:web` are separate scripts, so the Loom can **kill only the API** while the UI stays open and shows "Disconnected", then restart it and show the catch-up. This is the cheapest honest restart demo.
- Env: `DESK_DB` (default `data/desk.sqlite`, gitignored), `SEED` (default random, **logged at boot** so any demo run can be replayed), `SIM=on|off` (default on), `PORT=3001`.
- Dependencies (complete list). Runtime: `express`, `zod`, `react`, `react-dom`, `@tanstack/react-query`. Dev: `typescript`, `tsx`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `vitest`, `supertest`, `fast-check`, `concurrently`, `@types/{node,express,supertest,react,react-dom}`. No logger, ORM, date or UI library.
- Prettier (format on save): SHOULD. ESLint: WON'T (setup time). `strict` TS and exhaustive `switch` with `never` stand in for it.

---

## 2. Runtime model (the core architectural argument)

```
               ┌──────────────────────── one Node process ─────────────────────────┐
  Browser ──►  │ Express routes ──► commands.* ──► tx(BEGIN IMMEDIATE … COMMIT) ──► │──► SQLite (WAL, file)
  (poll 1s)    │                         ▲                │ effects (after COMMIT)   │
               │  scheduler.tick(now) ───┤                ▼                          │
               │   1. sim.pump(now) ─────┘   engine.dispatch(req) ──► sim_jobs       │
               │   2. reconciler.run(now) ─► commands.timeoutAttempt / expireOffer   │
               └────────────────────────────────────────────────────────────────────┘
```

1. **Everything that mutates domain state is a command** (`src/server/commands/*`). HTTP handlers, the reconciler, and the sim pump all call commands. None of them write SQL themselves.
2. **Commands are synchronous end to end.** `node:sqlite` is synchronous and JS is single-threaded, so a command's transaction can never interleave with another inside the process. `tx()` throws if its callback returns a Promise (§4.2). **Rule: no `await` inside a transaction.**
3. **That serialization is not why the system is correct.** The CAS guards are (`expectedVersion`, `current_attempt_id`, `status='pending'`). Single-process serialization only means we have no lock waits. The README says this plainly, and it is what lets the design port to Postgres (§12).
4. **Effects run after COMMIT.** A command returns `effects: Effect[]` (`DispatchAttempt`, `OfferCreated`), and the composition root executes them after commit. If the process dies between COMMIT and dispatch, the attempt is `pending` with no engine job. That looks exactly like a request that never returns, and **the same persisted deadline recovers it.** We get this for free, with no outbox.
5. **Time has one owner.** `clock.now()` is read **once per command** and passed down, so every row and event in a transaction shares a timestamp. The reconciler takes `now` as a parameter. No `setTimeout` owns business state. The only timer is the scheduler's `setInterval(tick, 500)`, and it is started only in `main.ts`.

**What I'd tell the reviewer:** *"I turned concurrency into a sequencing problem: every input is a discrete, atomic, guarded command. Then I test sequences."*

---

## 3. Code structure and module boundaries

```
terac-routing-desk/
├─ package.json  tsconfig.json  vite.config.ts  vitest.config.ts  .prettierrc
├─ data/                         # gitignored: desk.sqlite (+ -wal, -shm)
├─ scripts/
│  ├─ reset.ts                   # MUST  delete db file → migrate → seed
│  └─ inspect.ts                 # COULD print one task's rows + timeline + sim fate
├─ src/
│  ├─ shared/                    # imports zod only. Compiled into both client and server.
│  │  ├─ schemas.ts              # enums, TaskSummary, TaskDetail, Snapshot, OperatorCommand (discriminated union),
│  │  │                          # ContributorAction, SimConfig, ApiError — the API contract
│  │  └─ policy.ts               # PURE: DEFAULT_POLICY numbers; nextAutomaticAction(); allowedCommands(task);
│  │                             # isOverdue(attempt, now); describeReason(code) → microcopy
│  ├─ server/
│  │  ├─ main.ts                 # composition root: SystemClock, mulberry32(SEED), open(DESK_DB), boot(), start(), listen
│  │  ├─ app.ts                  # createApp(deps) → { http, commands, tick, boot, start, stop } — no side effects on import
│  │  ├─ infra/
│  │  │  ├─ db.ts                # open(path) + pragmas, migrate(), tx(), dropAll() (for reset)
│  │  │  ├─ schema.sql           # DDL: CHECKs, partial unique indexes, append-only triggers  ← invariants I1–I3, I8
│  │  │  ├─ clock.ts             # interface Clock { now(): number }; SystemClock; FakeClock { set(ms); advance(ms) }
│  │  │  ├─ rng.ts               # interface Rng { next(): number; int(a,b); pick<T>(xs) }; mulberry32; rngFor(seed, ...keys)
│  │  │  ├─ ids.ts               # prefixed ids (tsk_, att_, asg_, evt_); deterministic generator in tests
│  │  │  └─ log.ts               # 25-line JSON-lines logger, pretty in TTY
│  │  ├─ domain/                 # PURE — no db, no clock, no I/O. Unit-tested table-style.
│  │  │  ├─ machine.ts           # TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]>; assertTransition()
│  │  │  ├─ eligibility.ts       # candidatesFor(task, contributors, exclusions, activeCounts) → {eligible, excluded[{id, reason}]}
│  │  │  └─ routing-policy.ts    # attemptDeadline(priority, at); canAutoRetry(attemptsUsed); offerExpiry(at); classifyFailure()
│  │  ├─ store/
│  │  │  └─ repo.ts              # all SQL: loadTaskAggregate(id), CAS updates (return changes), insertEvent(), queries for views
│  │  ├─ commands/               # THE ONLY WRITERS of tasks / routing_attempts / assignments / events
│  │  │  ├─ run.ts               # runCommand(name, fn): now, tx, assertTaskInvariants (pre-COMMIT), log, effects post-COMMIT
│  │  │  ├─ create.ts            # createTask (idempotent on clientRequestId), submit
│  │  │  ├─ operator.ts          # assign, retryRouting, stopRouting, withdrawOffer, markFailed, cancel  (expectedVersion)
│  │  │  ├─ engine-result.ts     # applyEngineResult — fencing (attempt is current && pending && task routing)
│  │  │  ├─ contributor.ts       # respond: accept | decline | start | complete | withdraw  (fenced on assignment status)
│  │  │  ├─ system.ts            # timeoutAttempt, expireOffer, recordBoot  (called by scheduler only)
│  │  │  └─ effects.ts           # type Effect = DispatchAttempt | OfferCreated
│  │  ├─ engine/
│  │  │  └─ port.ts              # interface RoutingEngine { dispatch(req: RoutingRequest): void }; RoutingResult (zod)
│  │  ├─ scheduler/
│  │  │  ├─ scheduler.ts         # tick(now) = sim.pump(now) → reconciler.run(now) → meta.last_tick_at; boot(); start/stop
│  │  │  └─ reconciler.ts        # due-deadline queries → system commands; idempotent; one tx per item
│  │  ├─ sim/                    # SIMULATION ONLY. Never imported by domain/, commands/, store/.
│  │  │  ├─ engine-sim.ts        # implements RoutingEngine; decides fate at dispatch; writes sim_jobs
│  │  │  ├─ contributor-sim.ts   # on OfferCreated: decide accept/decline/ignore + delay; writes sim_jobs
│  │  │  ├─ pump.ts              # deliver due sim_jobs by calling PUBLIC commands, as an external caller would
│  │  │  ├─ scripts.ts           # forced fates per (task, attempt_no): sim_scripts table
│  │  │  └─ seed.ts, scenarios.ts
│  │  └─ http/
│  │     ├─ routes.ts            # Express router; parse(schema, input); thin
│  │     ├─ views.ts             # rows → Snapshot / TaskDetail DTOs (uses shared/policy for derived fields)
│  │     └─ errors.ts            # DomainError(code, status, details); error middleware; 404 fallback
│  └─ client/                    # owned by Operator UX
│     ├─ index.html  main.tsx  App.tsx
│     ├─ api.ts                  # fetch wrapper; parses responses with shared zod in dev; throws ApiError
│     └─ hooks/ useSnapshot.ts useTaskDetail.ts useNow.ts useCommand.ts
└─ test/
   ├─ helpers/harness.ts         # createTestApp(), advance(), jump(), restart(), spy engine
   ├─ helpers/invariants.ts      # checkInvariants(db) → Violation[]  (also used by runCommand in dev/test)
   ├─ unit/ machine.test.ts eligibility.test.ts routing-policy.test.ts policy.test.ts
   ├─ scenarios/ *.test.ts       # S1–S12, given/when/then
   ├─ restart.test.ts
   ├─ fuzz.test.ts
   └─ api.test.ts
```

### 3.1 Dependency rules (enforced by review, plus one cheap test — COULD)
- `domain/` imports only `shared/`. `commands/` imports `domain/`, `store/`, and `infra/`. `sim/` imports only `engine/port.ts`, `commands` (the public interface), and `infra/`.
- **Nothing outside `sim/` reads `sim_jobs` or `sim_scripts`.** This boundary is what keeps the premise "the operator cannot know whether a request is slow or lost" honest in the code, not just in the UI. COULD: a test that greps `src/server/{domain,commands,store,http,scheduler}` for `sim_` and fails on a match (5 minutes, and a nice Loom moment).

### 3.2 Where Clock and Rng are injected
| Dependency | Injected into | Prod | Test |
|---|---|---|---|
| `Clock` | `createApp(deps)` → commands (`runCommand` reads `now` once), scheduler, sim | `SystemClock` | `FakeClock` starting at `2026-01-01T09:00:00Z` |
| `Rng` | `engine-sim`, `contributor-sim`, `ids` (test mode) | `mulberry32(SEED)` | fixed seed per test |
| `RoutingEngine` | commands' effect runner | `EngineSim` | `EngineSim` with scripted fates, **or** `SpyEngine` (records requests, never answers) |

**Per-attempt determinism (SHOULD, flagged to Engine):** derive each attempt's fate from `rngFor(seed, taskNumber, attemptNo)` instead of a shared stream. "T-103 attempt #1 never returns" then holds across runs with the same `SEED`, however the operator's clicks interleave.

### 3.3 Where each invariant lives
| # | Invariant | Enforced by | Checked by |
|---|---|---|---|
| I1 | ≤ 1 active assignment (`offered/accepted/in_progress`) per task | partial unique index `ux_one_active_assignment` | invariants.ts |
| I2 | ≤ 1 `pending` routing attempt per task | partial unique index `ux_one_pending_attempt` | invariants.ts |
| I3 | `needs_attention` ⇔ `attention_reason IS NOT NULL` | table `CHECK` | invariants.ts |
| I4 | `status='routing'` ⇔ `current_attempt_id` points to *this task's* pending attempt; any other status ⇒ no pending attempt | command code (one place: `run.ts` pre-COMMIT assert) | invariants.ts |
| I5 | `awaiting_response` ⇔ exactly one `offered`; `assigned` ⇔ one `accepted`; `in_progress` ⇔ one `in_progress`; all other statuses ⇒ none active | pre-COMMIT assert | invariants.ts |
| I6 | contributor active assignments ≤ `capacity` | command check inside `BEGIN IMMEDIATE` (count query) | invariants.ts |
| I7 | an active assignment's contributor has the task's expertise | eligibility check in `assign` / `applyEngineResult` | invariants.ts |
| I8 | events are append-only | `BEFORE UPDATE/DELETE` triggers with `RAISE(ABORT)` | trigger test |
| I9 | every state change writes ≥ 1 event in the same tx; `task.version` increments by exactly 1 per state change | `runCommand` (asserts `eventsWritten > 0` when the version changed) | fuzz |
| I10 | terminal rows never change (task `completed/cancelled`; attempt ≠ `pending`; assignment not active) | guarded `WHERE` clauses | fuzz (cross-step) |

**Pre-COMMIT assertion (SHOULD, strongly recommended):** `runCommand` calls `assertTaskInvariants(db, touchedTaskIds)` inside the transaction, as about 6 indexed queries scoped to the touched tasks. On a violation it throws and **rolls back**, so a bug becomes a rejected command (`500 invariant_violation`, logged loudly) instead of corrupted state. It's on in dev and test and would stay on in prod ("fail closed"). Reviewer line: *"The same invariant checker runs in my fuzz tests and before every commit."*

---

## 4. Persistence

### 4.1 DDL sketch (Domain & State owns the vocabulary; this shows *where invariants live*)
```sql
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;

CREATE TABLE contributors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 0),
  created_at INTEGER NOT NULL
);
CREATE TABLE contributor_expertise (            -- join table: eligibility is a plain JOIN
  contributor_id TEXT NOT NULL REFERENCES contributors(id), area TEXT NOT NULL,
  PRIMARY KEY (contributor_id, area)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,               -- display id: T-101
  title TEXT NOT NULL, description TEXT,
  expertise TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high','normal','low')),
  status TEXT NOT NULL CHECK (status IN ('new','routing','awaiting_response','assigned',
                                        'in_progress','completed','needs_attention','cancelled')),
  attention_reason TEXT,
  current_attempt_id TEXT,                      -- fencing token (FK omitted: circular with routing_attempts)
  version INTEGER NOT NULL DEFAULT 1,           -- optimistic concurrency for operator commands
  client_request_id TEXT UNIQUE,                -- create idempotency (see §7)
  status_since INTEGER NOT NULL,                -- time-in-state for UI
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((status = 'needs_attention') = (attention_reason IS NOT NULL))     -- I3
);

CREATE TABLE routing_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_no INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('submit','auto_retry','operator_retry')),
  status TEXT NOT NULL CHECK (status IN ('pending','matched','no_match','timed_out',
                                         'superseded','stopped','cancelled','rejected_result')),
  candidate_ids TEXT NOT NULL,                  -- JSON: exactly what the engine was sent
  dispatched_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  resolved_at INTEGER, result_contributor_id TEXT,
  late_result TEXT, late_result_at INTEGER,     -- recorded, never applied
  UNIQUE (task_id, attempt_no)
);
CREATE UNIQUE INDEX ux_one_pending_attempt ON routing_attempts(task_id) WHERE status = 'pending';   -- I2
CREATE INDEX ix_attempt_due ON routing_attempts(deadline_at) WHERE status = 'pending';

CREATE TABLE assignments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  contributor_id TEXT NOT NULL REFERENCES contributors(id),
  source TEXT NOT NULL CHECK (source IN ('engine','operator')),
  attempt_id TEXT REFERENCES routing_attempts(id),
  status TEXT NOT NULL CHECK (status IN ('offered','accepted','in_progress','completed',
                                         'declined','expired','withdrawn','failed','cancelled')),
  offered_at INTEGER NOT NULL, expires_at INTEGER, responded_at INTEGER, ended_at INTEGER, end_reason TEXT
);
CREATE UNIQUE INDEX ux_one_active_assignment ON assignments(task_id)
  WHERE status IN ('offered','accepted','in_progress');                                              -- I1
CREATE INDEX ix_contrib_active ON assignments(contributor_id) WHERE status IN ('offered','accepted','in_progress');
CREATE INDEX ix_offer_due ON assignments(expires_at) WHERE status = 'offered';

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,        -- ordering is by seq, never by timestamp
  task_id TEXT REFERENCES tasks(id),            -- NULL for system events (boot, reset)
  at INTEGER NOT NULL, type TEXT NOT NULL,
  actor TEXT NOT NULL,                          -- 'operator' | 'engine' | 'system' | 'contributor:<id>' | 'sim'
  summary TEXT NOT NULL,                        -- human sentence written at write time
  attempt_id TEXT, assignment_id TEXT,
  task_version INTEGER,                         -- task.version AFTER this event (for 409 "what changed")
  data TEXT NOT NULL DEFAULT '{}'               -- JSON detail: from/to, dueAt, lateByMs, wouldHaveChosen…
);
CREATE INDEX ix_events_task ON events(task_id, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;  -- I8
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;

-- SIMULATION: the outside world. Only src/server/sim/** touches these.
CREATE TABLE sim_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('engine_result','contributor_response')),
  ref_id TEXT NOT NULL,                         -- attempt id or assignment id
  due_at INTEGER,                               -- NULL = will never be delivered
  payload TEXT NOT NULL,                        -- {"outcome":"match","contributorId":"ctr_ana"} | {"action":"decline"}
  created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE INDEX ix_sim_due ON sim_jobs(due_at) WHERE delivered_at IS NULL AND due_at IS NOT NULL;
CREATE TABLE sim_scripts (task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, fate TEXT NOT NULL,
                          PRIMARY KEY (task_id, attempt_no));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version, boot_id, last_tick_at, sim_config
```
- **Timestamps** are epoch-ms `INTEGER`. That makes arithmetic and comparisons trivial, and the API exposes the same numbers.
- **Migrations:** `schema.sql` is applied once with `CREATE … IF NOT EXISTS` plus `meta.schema_version=1`. There's no migration framework (WON'T). Changing the schema means `npm run reset`.
- **Reset** drops every table with `DROP TABLE` (which doesn't fire the DELETE trigger), then re-applies the schema, seeds, writes a new `boot_id`, and writes a system event `"Desk reset to seed '<name>'"`.

### 4.2 Transaction helper — MUST
```ts
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) throw new Error('nested tx: commands must not call commands');
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    if (out && typeof (out as any).then === 'function') throw new Error('tx callback must be synchronous');
    db.exec('COMMIT');
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}
```
`BEGIN IMMEDIATE` takes the write lock up front. That doesn't matter with one process, but it's the right habit, and it means a second process (for example `npm run reset` while the server runs) gets `SQLITE_BUSY` after 5 s instead of corrupting a read-modify-write.

---

## 5. The command pipeline

```ts
type Ctx = { now: number; db: Db; ids: Ids; events: EventWriter; effects: Effect[]; touched: Set<string> };

function runCommand<T>(name: CommandName, input: unknown, fn: (ctx: Ctx) => T): T {
  const now = clock.now(); const effects: Effect[] = []; const t0 = performance.now();
  try {
    const value = tx(db, () => {
      const ctx = { now, db, ids, events: eventWriter(db, now), effects, touched: new Set<string>() };
      const v = fn(ctx);
      assertTaskInvariants(db, ctx.touched);            // throws → ROLLBACK
      return v;
    });
    log.info('command', { cmd: name, outcome: 'applied', durMs: performance.now() - t0, ...summarize(input) });
    for (const e of effects) runEffect(e);              // after COMMIT; failures logged, deadlines recover
    return value;
  } catch (err) {
    log[isDomainError(err) ? 'info' : 'error']('command', { cmd: name, outcome: 'rejected', code: codeOf(err) });
    throw err;
  }
}
```

**The three kinds of guard** (Engine, Time & Concurrency owns the policy; this is the mechanism):

| Caller | Guard | On guard failure |
|---|---|---|
| Operator command | `UPDATE tasks SET … , version = version + 1 WHERE id = ? AND version = :expectedVersion` | `409 version_conflict` + `eventsSince` |
| Engine result | load in tx: `attempt.status = 'pending' AND task.current_attempt_id = attempt.id AND task.status = 'routing'`, then `UPDATE routing_attempts … WHERE id = ? AND status = 'pending'` | **not an error.** Record `late_result` + event "Late engine response ignored". Return `{applied:false, reason}` |
| Contributor response / system (reconciler) | `UPDATE assignments … WHERE id = ? AND status = 'offered'` (or the `accepted` status the action requires); `UPDATE routing_attempts … WHERE status='pending' AND deadline_at <= :now` | contributor: `409 offer_not_active` + recorded event. System: silent no-op (idempotent) |

**Order of checks for operator commands:** (1) the task exists → else 404. (2) `expectedVersion` matches → else 409 `version_conflict`. A stale view should be answered with "here's what changed", not "invalid transition". (3) The command is allowed in the current status → else 409 `invalid_transition` with `allowed[]`. That case is a client bug, because the UI renders only `allowedCommands`. (4) Payload rules (eligibility, capacity) → 409 or 422.

**`expectedVersion` also makes operator commands idempotent.** A double-clicked "Retry routing" dispatches once. The second click gets a 409 whose `eventsSince` reads "Routing attempt #3 started by operator". No separate idempotency store is needed for commands.

**`task.version` bumps only on task state changes.** A recorded late result appends an event but doesn't change the version. Otherwise a harmless late reply would 409 an operator mid-click. (Flagged to Domain.)

---

## 6. Scheduler, restart model and boot catch-up

### 6.1 Restart model — decision: durable sim (baseline option B) — MUST (divergence → Engine, Time & Concurrency)
- **Choice:** the engine sim and the contributor auto-responder decide each outcome at dispatch or offer time and persist it as a `sim_jobs` row (`due_at = NULL` means "never returns"). `sim.pump(now)` delivers due jobs **by calling the same public commands an external webhook would call**. The jobs survive restarts.
- **Alternative (A):** an in-memory `setTimeout` sim, where in-flight requests die with the process. That's also safe, because deadlines catch them. But it makes a restart look like a mass never-return, it can never produce a "result arrives after restart" case, and it needs `vi.useFakeTimers()` choreography in tests.
- **Why B:** (1) it models reality, since the engine is an external service and our deploy doesn't cancel its work. (2) Restarts actually exercise fencing. (3) It's **easier to test**: the harness advances a `FakeClock` and calls `tick()`, with no fake timers at all. (4) It costs one table and a 30-line pump.
- **Reviewer line:** "The simulated engine outlives my server like a real one would, so a restart can produce late answers, and fencing handles them."

### 6.2 `tick(now)`: fixed order — MUST
```
tick(now):
  1. sim.pump(now)        // deliver sim_jobs WHERE delivered_at IS NULL AND due_at <= now ORDER BY due_at, id
                          //   engine_result        → commands.applyEngineResult(...)
                          //   contributor_response → commands.contributorRespond(...)
                          //   mark delivered_at in the sim's own tx (after the command, success OR domain rejection)
  2. reconciler.run(now)  // attempts: status='pending' AND deadline_at <= now → commands.timeoutAttempt(id)
                          //   (which auto-retries within budget → DispatchAttempt effect, or → needs_attention)
                          // offers:   status='offered' AND expires_at <= now → commands.expireOffer(id)
                          // each item in its own tx; a throwing item is logged and retried next tick
  3. meta.last_tick_at = now   // heartbeat (shown in UI footer; used for downtime on boot)
  return TickReport { delivered, timedOut, expired, retried, escalated }
```
- **Pump before reconciler (divergence → Engine):** in one tick, an answer due by `now` is applied before the deadline is enforced. In steady state this only matters at the boundary of a 500 ms tick. At boot after downtime it means **an answer waiting in the inbox beats a timeout we were too dead to enforce.** That's better for the operator: it avoids throwing away a valid match and dispatching a fresh request. The alternative, "deadline first", is simpler to state but punishes our own downtime.
- **Interval:** 500 ms (baseline said ~1 s). Countdowns to the next automatic action then land within half a second, and the work per tick is a few indexed queries.

### 6.3 Boot — MUST
```
boot():
  migrate(); bootId = uuid(); meta.boot_id = bootId
  downtimeMs = now - meta.last_tick_at   (if present)
  report = tick(now)                      // catch-up uses the SAME code path as steady state
  commands.recordBoot({ downtimeMs, report })  // one system event
  start() → setInterval(tick, 500)        // main.ts only
```
- The system event summary (exact copy): **"Server started after 1m 55s offline. Caught up: 1 engine response delivered, 1 routing attempt timed out (retrying), 1 offer expired."** With nothing to do: **"Server started. Nothing was due while it was offline."**
- Per-item events from the catch-up carry `data.dueAt` and `data.lateByMs`, so the timeline reads "Attempt #1 timed out — deadline was 14:02:31, processed 1m 25s late (server was offline)". Operator UX renders it.
- `bootId` goes into every snapshot. When the client sees it change, it shows a one-time toast with the boot event summary and drops the cached task detail.
- Graceful shutdown on `SIGINT/SIGTERM`: stop the interval, `server.close()`, `db.close()`. A `kill -9` mid-transaction is safe because SQLite rolls back the uncommitted transaction on next open.

---

## 7. REST API catalogue

Base `/api`, JSON in and out, timestamps in epoch ms, ids are prefixed strings. Every response body is defined by a zod schema in `src/shared/schemas.ts`. The error envelope is always `{ "error": { "code", "message", ...details } }`.

### 7.1 Reads
| Method & path | Response | Notes | Tag |
|---|---|---|---|
| `GET /api/health` | `{ ok, serverTime, bootId, lastTickAt, sim: boolean, seed }` | footer liveness: "Reconciler: last run 0.4s ago" | MUST |
| `GET /api/snapshot` | `Snapshot` (below) | polled every 1 s | MUST |
| `GET /api/tasks/:id` | `TaskDetail` (below) | polled every 1 s while the drawer is open; `:id` accepts `tsk_…` or `T-104` | MUST |
| `GET /api/events?after=<seq>&limit=50` | `{ events: Event[] }` | global activity feed | COULD |
| `GET /api/debug/invariants` | `{ violations: Violation[] }` | runs `checkInvariants` against the live DB | COULD |

```ts
type Snapshot = {
  serverTime: number; bootId: string; lastBoot: { at: number; downtimeMs: number | null; summary: string } | null;
  policy: Policy;                                   // effective numbers for the "How this desk behaves" panel
  stats: { byStatus: Record<TaskStatus, number>; needsAttention: number; routingOverdue: number;
           oldestNeedsAttentionSince: number | null };
  tasks: TaskSummary[];                             // all non-archived; WON'T paginate
  contributors: { id; name; expertise: string[]; capacity: number; activeCount: number; activeTaskNumbers: number[] }[];
};
type TaskSummary = {
  id; number; title; expertise; priority; status; attentionReason: string | null; version: number;
  createdAt; statusSince; updatedAt;
  currentAttempt: { id; no: number; trigger; dispatchedAt; deadlineAt; candidateCount: number } | null;
  attemptsUsed: number; retryBudget: number;
  activeAssignment: { id; contributorId; contributorName; status; source; offeredAt; expiresAt: number | null } | null;
  nextAutomaticAction: { kind: 'timeout_and_retry' | 'timeout_and_escalate' | 'expire_offer'; at: number } | null;
  allowedCommands: OperatorCommandType[];           // server-computed via shared/policy.ts; UI renders only these
  lastEvent: { at; summary } | null;
};
type TaskDetail = TaskSummary & {
  description: string | null;
  attempts: { id; no; trigger; status; candidateIds: string[]; dispatchedAt; deadlineAt; resolvedAt;
              resultContributorId; lateResult: RoutingResult | null; lateResultAt: number | null }[];
  assignments: { id; contributorId; contributorName; source; attemptNo: number | null; status;
                 offeredAt; expiresAt; respondedAt; endedAt; endReason }[];
  events: Event[];                                  // ascending by seq
  candidates: { contributorId; name; eligible: boolean;
                reason?: 'declined_this_task' | 'expired_this_task' | 'failed_this_task' | 'at_capacity' }[];
};
```

### 7.2 Task creation
| Method & path | Body | Success | Errors | Tag |
|---|---|---|---|---|
| `POST /api/tasks` | `{ clientRequestId: uuid, title: string(3..120), description?: string(≤2000), expertise: Area, priority: 'high'\|'normal'\|'low', submit: boolean }` | `201 TaskDetail` (`submit:true` → `routing` or, with zero eligible, `needs_attention`) | 400 `validation_failed` | MUST |

- **Idempotency (divergence: baseline said "idempotency key"):** `tasks.client_request_id UNIQUE`. The form generates a uuid when it opens. Create does `INSERT … ON CONFLICT(client_request_id) DO NOTHING`, then `SELECT`. A replay returns **`200`** with the original task and header `Idempotent-Replay: true`. **Why not a generic `idempotency_keys` table:** one column gives the same guarantee for the only non-versioned create, and operator commands are already idempotent through `expectedVersion`. A replay with a different body gives the original back unchanged (documented; WON'T hash-compare). SHOULD (10 min).
- `submit` is a separate command too: `{type:'submit'}` (below), for tasks created with `submit:false`.

### 7.3 Operator commands — one endpoint, discriminated union — MUST
`POST /api/tasks/:id/commands`, body: `OperatorCommand`

```ts
const Base = { expectedVersion: z.number().int().positive(), note: z.string().max(500).optional() };
export const OperatorCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('submit'),         ...Base }),                     // new → routing
  z.object({ type: z.literal('retry_routing'),  ...Base }),                     // routing (supersede pending) | needs_attention → routing
  z.object({ type: z.literal('stop_routing'),   ...Base }),                     // routing → needs_attention(routing_stopped)
  z.object({ type: z.literal('assign'),         ...Base, contributorId: z.string() }), // new|routing|needs_attention → awaiting_response (source=operator)
  z.object({ type: z.literal('withdraw_offer'), ...Base }),                     // awaiting_response → needs_attention(offer_withdrawn)
  z.object({ type: z.literal('mark_failed'),    ...Base, reason: z.string().min(3).max(200) }), // assigned → needs_attention(failed_before_start)
  z.object({ type: z.literal('cancel'),         ...Base }),                     // any non-terminal → cancelled
]);
```
- **Response:** `200 { applied: true, task: TaskDetail }`. The client writes it straight into the detail cache, so there's no second round trip.
- **Why one endpoint:** one place for `expectedVersion` handling, 409 formatting, logging (`cmd=<type>`), and an exhaustive `switch` with a `never` check. The client gets one typed `sendCommand(taskId, cmd)`. Alternative: one path per command (`/assign`, `/retry`), which is a little more RESTful to read but repeats the plumbing seven times. Exact state applicability is owned by **Domain & State**. The list above is the shape, not the final table.
- **Errors:**

| HTTP | `code` | Body extras | When |
|---|---|---|---|
| 400 | `validation_failed` | `issues: {path, message}[]` | zod failure |
| 404 | `not_found` | `entity` | unknown task or contributor |
| 409 | `version_conflict` | `currentVersion`, `currentStatus`, `eventsSince: Event[]` (events with `task_version > expectedVersion`) | stale view |
| 409 | `invalid_transition` | `currentStatus`, `allowed: OperatorCommandType[]` | command not valid now |
| 409 | `contributor_at_capacity` | `contributorId`, `activeCount`, `capacity` | assign to a full contributor |
| 422 | `contributor_ineligible` | `contributorId`, `reason: 'expertise_mismatch'` | assign outside expertise (WON'T: override) |
| 500 | `invariant_violation` / `internal` | `errorId` | bug; tx rolled back |

Microcopy for `version_conflict.message`: **"T-104 changed while you were looking (v7 → v9). Review what happened, then try again."** The UI lists `eventsSince[].summary` under it.

### 7.4 Contributor channel (a real input in prod, driven by the SIMULATION panel here) — MUST
`POST /api/assignments/:id/respond`, body `{ action: 'accept'|'decline'|'start'|'complete'|'withdraw', note?: string }`
- Fenced on the assignment's status, not on `task.version`, because a contributor responds to *their offer*, not to the operator's view. `accept|decline` need `offered`. `start|withdraw` need `accepted`. `complete` needs `in_progress`.
- `200 { applied: true, task: TaskDetail }` | `409 offer_not_active { assignmentStatus }`. A response that arrives late is also **recorded** as an event: **"Ana tried to accept offer #2, but it had already expired. Ignored."**
- Prod note: this would be authenticated as that contributor. Here it is open and labelled SIMULATION in the UI.

### 7.5 Simulation controls (all under `/api/sim`, `404 sim_disabled` when `SIM=off`)
| Method & path | Body | Effect | Tag |
|---|---|---|---|
| `GET /api/sim/config` / `PUT /api/sim/config` | `SimConfig` (below) | read or update live sim knobs (persisted in `meta`) | SHOULD |
| `POST /api/sim/attempts/:attemptId/deliver` | `{ outcome: 'match'\|'no_match', contributorId? }` | delivers an engine response **now** for any attempt, including superseded or timed-out ones. This is how the Loom shows a late return. Goes through `applyEngineResult`. Returns `{ applied, reason? }` | **MUST** |
| `POST /api/sim/tasks/:taskId/script` | `{ fates: Fate[] }` (`{kind:'never'} \| {kind:'match', contributorId?, latencyMs} \| {kind:'no_match', latencyMs}`) | forces outcomes for the next attempts of this task | SHOULD |
| `POST /api/sim/scenarios/:name` | — | creates the named demo scenario's tasks with scripted fates: `routine`, `stuck-high-priority`, `late-return-after-intervention`, `decline-recovery`, `capacity-contention` | SHOULD |
| `POST /api/admin/reset` | `{ seed?: 'default' \| 'empty' }` | drop, migrate, seed, new `bootId`, system event | MUST |
| `POST /api/engine/results` | `RoutingResult` | the shape a real engine webhook would hit. Same command as the pump | COULD |

```ts
type SimConfig = {
  engine: { minLatencyMs: 5000; maxLatencyMs: 20000; neverReturnRate: 0.2; noMatchRate: 0.1 };
  contributors: { autoRespond: true; acceptRate: 0.6; declineRate: 0.25; ignoreRate: 0.15;
                  minResponseMs: 3000; maxResponseMs: 12000 };
};
```
(Default numbers belong to **Engine, Time & Concurrency**. They are listed here only to fix the shape.)

---

## 8. Errors, validation, logging

### 8.1 Validation — MUST
- **At the edge:** `parse(schema, req.body | req.params | req.query)` throws `DomainError('validation_failed', 400, { issues })`.
- **External inputs are untrusted even when we simulate them:** `RoutingResult` is zod-parsed in `applyEngineResult`. Unknown contributor, a contributor not in the attempt's `candidate_ids`, or a malformed payload all lead to the attempt becoming `rejected_result`, an event "Engine returned an invalid result (contributor not in candidate list). Treated as a failed attempt.", and the system-failure path (auto-retry within budget). (Flagged to Domain/Engine. Baseline reason code: `invalid_engine_result`.)
- **Chosen contributor is no longer available** (e.g. took a manual offer elsewhere while the request was in flight): same path. It's a system-class failure, so it auto-retries with fresh candidates within budget, then becomes `needs_attention`. (Divergence → Domain: baseline lists `invalid_engine_result` as an attention reason. I suggest it's only the *terminal* reason once the budget is spent.)
- **DB rows** are trusted and mapped with typed functions, not zod-parsed. **API responses** are zod-parsed on the client in dev only (`import.meta.env.DEV`), which acts as a free contract check while building the UI.

### 8.2 Error handling — MUST
- `DomainError { code; status; message; details }` is the only expected error type. The error middleware maps it to the envelope. Anything else becomes a 500 with `errorId` (uuid) logged at `error` level with the stack, and the client sees "Something went wrong (ref 3f2a…). Nothing was changed." That message is accurate, because the transaction rolled back.
- Express 5 forwards async rejections. There's an unknown-route fallback with `404 not_found`, and a JSON body limit of 32 kb.
- Effect failures after COMMIT (dispatch throws) are logged at `warn`, and **the request still succeeds**. The persisted deadline covers it. Reviewer line: "If dispatch fails, it looks exactly like a lost request, and that's the one failure we already handle."
- The sim pump: when a delivery's command throws a `DomainError`, the job is marked delivered and the rejection logged. When it throws an unknown error, the job is left undelivered for retry next tick, with a warn log carrying `attempts`. COULD: give up after 5.

### 8.3 Logging — MUST (tiny)
JSON lines to stdout. In a TTY, a compact pretty format: `09:00:08.512 INFO command cmd=assign task=T-104 v=7→8 routing→awaiting_response 2.1ms`.
| Log line | Level | Fields |
|---|---|---|
| `boot` | info | `bootId, seed, dbPath, downtimeMs, caughtUp{…}` |
| `command` | info / error | `cmd, taskId, taskNo, from, to, version, outcome: applied\|rejected, code?, durMs` |
| `engine.dispatch` | info | `taskNo, attemptId, attemptNo, candidates, deadlineAt` |
| `engine.result` | info / warn | `attemptId, outcome, applied, reason?: stale\|duplicate\|invalid, latencyMs` |
| `reconciler` | info (only when it acts) | `timedOut[], expired[], lateByMs` |
| `sim.fate` | debug (only with `LOG_LEVEL=debug`) | `attemptId, fate` (keeps the sim's secret out of default logs) |
| `http` | debug | `method, path, status, ms` (only non-GET at info) |

---

## 9. Architecture-level edge cases

| # | Situation | Behaviour |
|---|---|---|
| E1 | `kill -9` during a command | SQLite rolls back the open transaction on next open. No partial state. The client's request fails, and its retry gets 409 or succeeds. |
| E2 | Crash after COMMIT, before `engine.dispatch` | The attempt stays `pending` with no `sim_job`. The deadline times it out and auto-retry runs. The timeline says "timed out", which is honest, since we can't tell this apart from a lost request. |
| E3 | Crash after the sim job is written | The job survives. The pump delivers it after boot (applied if still current, recorded if fenced). |
| E4 | Two browser tabs act on one task | The first wins. The second gets `409 version_conflict` with `eventsSince`. |
| E5 | Double-click on Create / Retry | Create: `clientRequestId` replay → same task. Retry: the second request is a 409 → no double dispatch. |
| E6 | Operator acts in the same tick a deadline passes | Serialized, so whoever commits first wins. If the reconciler was first, the operator gets a 409 that shows "attempt #1 timed out, attempt #2 started". If the operator was first, the reconciler's CAS finds `status≠pending` and does nothing. |
| E7 | Engine result for an attempt that doesn't exist (after a reset) | The pump logs `warn engine.result reason=unknown_attempt` and marks the job delivered. The HTTP deliver endpoint returns 404. |
| E8 | Same engine result delivered twice | First: applied. Second, identical: `{applied:false, reason:'duplicate'}`, logged at warn, **no event** (it's noise). Second, *different* payload: recorded as `late_result` + event. (Flagged to Engine.) |
| E9 | Server down while the UI is open | Polling fails. A banner reads **"Connection lost. Showing the last state from 14:03:12. Retrying…"**, ages freeze (the server-time offset can't be trusted), and command buttons are disabled. On recovery, a new `bootId` triggers the boot toast. |
| E10 | `npm run reset` while the server runs | The script checks `meta.last_tick_at`. If it's under 3 s old: **"The server looks like it's running. Use Reset in the UI (or POST /api/admin/reset), or stop the server first."** Exit code 1. |
| E11 | Reset while engine jobs are pending | `sim_jobs` are dropped with everything else. Nothing late arrives into the new world. |
| E12 | Wall-clock jump (NTP or sleep) | Deadlines are wall-clock epoch ms because they must survive restarts. A forward jump fires deadlines early, and a laptop sleep acts like downtime and gets the same catch-up. Accepted and documented. |
| E13 | Events written in the same millisecond | Ordering is by `seq`, never by `at`. |
| E14 | A reconciler item throws repeatedly (poison) | Logged every tick. Other items keep processing (one tx per item). COULD: back off. |
| E15 | Client clock badly skewed | Irrelevant, because ages use the server-time offset. |

---

## 10. Testing and verification strategy

### 10.1 Principles
- **The backend is built test-first through the harness, before any UI exists.** Scenario tests *are* the dev loop, so they replace manual clicking rather than adding to it. That's what makes the budget below realistic.
- **No real timers in any test.** The `FakeClock` plus explicit `tick()` makes everything deterministic, and the suite runs in about 2 s.
- **Every test checks invariants after every step**, automatically, through the harness.

### 10.2 Harness — MUST (~15 min)
```ts
const h = createTestApp({ seed: 42, startAt: T0, contributors: [...], sim: { autoRespond: false }, engine?: 'sim' | 'spy' });
h.commands.*                     // direct calls (scenario tests)
h.http                           // supertest(h.app.http) (api tests)
h.advance(ms)                    // clock.advance in 500ms steps, tick() each step, checkInvariants() each step → throws with a readable diff
h.jump(ms)                       // single clock jump + ONE tick (catch-up semantics)
h.script(taskId, fates)          // sim_scripts
h.deliver(attemptId, result)     // = POST /api/sim/attempts/:id/deliver
h.respond(assignmentId, action)  // contributor channel
h.spy.requests                   // RoutingRequest[] when engine = 'spy'
h.task(id) / h.detail(id) / h.events(id).map(e => e.type)
h.dbHash()                       // stable hash of all domain tables (for "rejected ⇒ unchanged")
h.restart({ at })                // close app, reopen SAME db file, new FakeClock at `at`, boot()
```
The DB is `:memory:` by default and a temp file when `restart` is needed.

### 10.3 Layer 1 — table-driven pure tests — MUST (~5 min)
- `machine.test.ts`: `it.each` over every `(from, to)` pair. Allowed pairs pass, every other pair throws.
- `eligibility.test.ts`: expertise match, exclusion of decliners, expired and failed contributors, capacity, empty set.
- `routing-policy.test.ts`: `attemptDeadline('high', t) = t+30_000` (etc.), `canAutoRetry(3) = false`, `nextAutomaticAction` for each state.
- `policy.test.ts`: `allowedCommands(status)` matches the transition table, so the UI and server can't drift.

### 10.4 Layer 2 — scenario integration tests (given / when / then)
Assumed defaults (owned by **Engine, Time & Concurrency** / **Domain & State**; tests import them from `DEFAULT_POLICY`, never hard-code them): expected window 5–20 s; overdue after 20 s; deadline high 30 s / normal 45 s / low 60 s; retry budget 2 (3 attempts total); offer TTL 60 s.
Fixture contributors: **Ana** (finance, cap 1), **Ben** (finance, cap 1), **Chen** (healthcare, cap 2). Contributor auto-respond is **off** unless stated.

**S1 Routine assignment — MUST**
- *Given* the script for T1 (finance, normal) is `[match Ana @8s]`.
- *When* the operator creates T1 with `submit:true`. *Then* T1 is `routing`, attempt #1 is `pending` with `deadlineAt = T0+45s`, `candidate_ids=[Ana,Ben]`, and the events are `[task_created, routing_requested]`.
- *When* `advance(8s)`. *Then* attempt #1 is `matched`, an assignment is `offered` to Ana (source `engine`, `expiresAt=T0+68s`), T1 is `awaiting_response`, and the version went up.
- *When* Ana `accept`s. *Then* T1 is `assigned`, there are no pending attempts, and routing is complete.
- *When* Ana `start`s, then `complete`s. *Then* `in_progress` → `completed`. The event types match the expected list exactly.

**S2 Never-return → timeout → auto-retry → match — MUST**
- *Given* T1 is high priority, script `[never, match Ana @6s]`.
- *When* submitted and `advance(29.5s)`. *Then* still `routing`, attempt #1 is `pending`, and `isOverdue` is true (past 20 s).
- *When* `advance(0.5s)`. *Then* attempt #1 is `timed_out`, attempt #2 is `pending` (`trigger=auto_retry`, deadline `+30s`), and T1 is still `routing` with version +1. The event summary is **"Attempt #1 got no response within 30s (it may be slow or lost; we can't tell). Retrying automatically (retry 1 of 2)."**
- *When* `advance(6s)`. *Then* the assignment is offered to Ana.

**S3 Retries exhausted → needs_attention — MUST**
- *Given* high priority, script `[never, never, never]`.
- *When* submitted and `advance(90s)`. *Then* 3 attempts are `timed_out`, T1 is `needs_attention(routing_exhausted)`, there's no pending attempt, and `nextAutomaticAction = null`.
- *When* `advance(60s)` more. *Then* the event count and `dbHash` are unchanged (the reconciler is idempotent).

**S4 Operator manual offer while pending; the engine returns later — MUST**
- *Given* script `[match Ben @15s]`.
- *When* submitted, `advance(5s)`, and the operator sends `assign {contributorId: Ana, expectedVersion: v}`. *Then* attempt #1 is `superseded`, the assignment is `offered` to Ana (source `operator`), and T1 is `awaiting_response`.
- *When* `advance(10s)` (the engine job comes due). *Then* attempt #1 has `late_result={match, Ben}` and an event **"Late engine response for attempt #1 ignored. It would have chosen Ben; Ana's offer from the operator stands."** T1's status and version are unchanged, and no assignment for Ben exists.

**S5 Late return of attempt #1 while attempt #2 is pending — SHOULD**
- *Given* normal priority, script `[match Ana @50s, match Ben @10s]`.
- *When* `advance(45s)`. *Then* #1 is `timed_out` and #2 is `pending`.
- *When* `advance(5s)`. *Then* #1's late result is recorded, **not applied**: T1 is still `routing` with `current_attempt_id=#2`, and Ana has no offer.
- *When* `advance(5s)`. *Then* the assignment is offered to Ben (from attempt #2).
- This encodes the strict fencing policy ("only the current attempt counts"). If Engine chooses "adopt a valid late answer while still routing", this test flips. That's the point of writing it.

**S6 Decline → recovery → re-route excludes the decliner — MUST**
- *Given* engine = `spy` for attempt #2, script `[match Ana @5s]`.
- *When* submitted, `advance(5s)`, and Ana `decline`s. *Then* the assignment is `declined`, T1 is `needs_attention(declined)`, `nextAutomaticAction=null` (a human outcome, so no auto-retry), and `detail.candidates` shows Ana `eligible:false, reason:'declined_this_task'` and Ben `eligible:true`.
- *When* the operator sends `retry_routing {expectedVersion}`. *Then* attempt #2 is dispatched and `spy.requests[1].candidates` deep-equals `[Ben]`.

**S7 Offer expiry — SHOULD**
- *Given* T1 has been offered to Ana (sim ignores).
- *When* `advance(60s)`. *Then* the assignment is `expired` and T1 is `needs_attention(offer_expired)`, with Ana marked `expired_this_task` in the candidates.
- *When* Ana `accept`s afterwards. *Then* `409 offer_not_active`, plus the event "Ana tried to accept offer #1, but it had already expired. Ignored." T1 is unchanged.

**S8 Accepted, then failed before start — SHOULD**
- *Given* T1 is `assigned` to Ana.
- *When* Ana `withdraw`s (or the operator sends `mark_failed {reason}`). *Then* the assignment is `withdrawn`/`failed`, T1 is `needs_attention(failed_before_start)`, Ana's `activeCount` is 0, and Ana is excluded.
- *When* Ana `start`s afterwards. *Then* `409 offer_not_active`.

**S9 Zero eligible contributors — SHOULD**
- *Given* no contributor has `legal` (or every matching contributor is at capacity).
- *When* T1 (legal) is created with `submit:true`. *Then* no attempt row exists, `spy.requests.length === 0`, and T1 is `needs_attention(no_eligible_contributors)` with the summary **"No available contributors with legal expertise (0 of 3 match). The engine was not called."**

**S10 Two tasks contend for one contributor at capacity — SHOULD**
- *Given* only Ana is finance (cap 1). T1 script `[match Ana @5s]`, T2 script `[match Ana @6s]`. Both are dispatched with candidates `[Ana]`.
- *When* `advance(5s)`. *Then* T1 is offered to Ana and Ana is at capacity.
- *When* `advance(1s)`. *Then* T2's attempt #1 is `rejected_result` (contributor_unavailable), auto-retry finds zero available, and T2 is `needs_attention(no_eligible_contributors)` with detail "1 matching contributor is at capacity". Ana's `activeCount` stays 1 throughout.
- *And* the operator's `assign` of Ana to T2 gets `409 contributor_at_capacity`.

**S11 Stale expectedVersion → 409 — MUST**
- *Given* T1 is `routing` at version v, with script `[never]`.
- *When* `advance(45s)` (the reconciler times out #1 and starts #2, so the version is v+1), then the operator sends `stop_routing {expectedVersion: v}`. *Then* `409 version_conflict`, `currentVersion=v+1`, `eventsSince[0].summary` mentions attempt #1 timing out, and `dbHash` is unchanged.

**S12 Duplicate engine callback — SHOULD**
- *Given* attempt #1 has matched Ana (applied).
- *When* the identical result is delivered again. *Then* `{applied:false, reason:'duplicate'}`, exactly one assignment, and no new event.
- *When* a different result (Ben) is delivered for #1. *Then* it's recorded as `late_result` with an event, and nothing is applied.

### 10.5 Layer 3 — restart test — MUST (~15 min)
- *Given* a temp-file DB and app A at T0.
  - TA (normal) script `[never]`: attempt deadline T0+45s.
  - TB (normal) script `[match Ana @20s]`.
  - TC offered to Ben with `expires_at = T0+60s`. The sim ignores it.
- *When* app A stops at T0+5s, the clock jumps to T0+120s, and `h.restart({ at: T0+120s })`.
- *Then*, **before** `boot()`: the domain tables hash-equal what A committed, so nothing was in memory only.
- *Then*, after `boot()`:
  - TB: the engine result is delivered first (pump before reconciler), so TB is offered to Ana with expiry `T0+180s`, counted from processing time.
  - TA: #1 is `timed_out` with `data.lateByMs = 75000`, #2 is dispatched with deadline `T0+165s`, and TA is `routing`.
  - TC: the offer is `expired` and TC is `needs_attention(offer_expired)`.
  - Exactly one system event: "Server started after 1m 55s offline. Caught up: 1 engine response delivered, 1 routing attempt timed out (retrying), 1 offer expired."
  - Invariants hold.
- *When* `boot()` runs again at the same `now`. *Then* there are no changes apart from a second boot event.

### 10.6 Layer 4 — property-based invariant fuzz (fast-check) — SHOULD (~30 min)
- **Generator:** `fc.array(action, { maxLength: 40 })`, with each action picked by `fc.oneof` from:
  - `create(priority, area, submit)`
  - `operator(type ∈ 7 commands, taskIdx, contributorIdx, versionSkew ∈ {0, -1})`, where `-1` sends a stale version
  - `respond(assignmentIdx, action ∈ 5)`
  - `deliver(attemptIdx over ALL attempts incl. stale, outcome, contributorIdx incl. ineligible)`
  - `advance(ms ∈ {0, 500, 5_000, 20_000, 31_000, 61_000})`
  - `restart()`
- Indices are taken modulo the current entity count, so most actions hit real rows. Sim auto-respond is on with a seeded RNG. `numRuns: 200`. On failure fast-check shrinks and prints the seed and path.
- **Checked after every step (`checkInvariants` + cross-step model):**
  1. I1: ≤ 1 active assignment per task.
  2. I2: ≤ 1 pending attempt per task.
  3. I4: `routing` ⇔ `current_attempt_id` is a pending attempt of this task.
  4. I5: task status agrees with the active assignment status (or the absence of one).
  5. I3: `needs_attention` ⇔ the reason is set.
  6. I6: each contributor's `activeCount ≤ capacity`.
  7. I7: the active assignee has the task's expertise. Engine-sourced offers never go to a contributor excluded for this task.
  8. **Liveness after tick:** no `pending` attempt with `deadline_at ≤ now`, no `offered` assignment with `expires_at ≤ now`, and no undelivered `sim_job` with `due_at ≤ now`.
  9. **Rejected ⇒ unchanged:** if a command threw a `DomainError`, `dbHash` before equals `dbHash` after, except for an appended "ignored" event where policy says to record one.
  10. **Late results are never applied:** after a `deliver` to a non-current attempt, the task's status, version and assignments are unchanged.
  11. **Absorbing terminals:** a task once seen as `completed`/`cancelled` keeps that status. An attempt once non-`pending` never changes status. An assignment once non-active never changes.
  12. **Monotonic history:** `task.version` never decreases. Every status change between steps has a new event for that task with `task_version` equal to the new version. The old event prefix is byte-identical (append-only).
  13. **Restart transparency:** the domain hash immediately after `restart()` (pre-boot) equals the hash before it.
- **Why it's worth 30 minutes:** it's the strongest available evidence for "correctness under concurrency or uncertainty", and the first failure it finds is usually a real bug worth showing in the Loom's session map.

### 10.7 Layer 5 — API tests (supertest) — MUST (~10 min)
1. `POST /api/tasks` with an empty title → 400 `validation_failed` with `issues[0].path = ['title']`.
2. `POST /api/tasks` twice with the same `clientRequestId` → same `id`, and `snapshot.tasks.length` grows by 1.
3. `POST /api/tasks/:id/commands` with a stale version → 409, and the body parses with the shared `ApiError` zod schema, including `eventsSince`.
4. `GET /api/snapshot` → the body parses with the shared `Snapshot` schema (a **contract test**: client and server agree).
- COULD: `/api/sim/*` → 404 when `SIM=off`; unknown route → JSON 404.

### 10.8 Layer 6 — browser verification: manual checklist — MUST (~10 min, run right before recording)
Playwright is **WON'T**: about 30 minutes of setup and flake risk for one smoke test. Instead, run this list against `npm run reset && npm run dev`, in a real browser, with the API in its own terminal:
1. The board loads, seeded tasks show ages that tick, and contributors show load.
2. Create a high-priority finance task (submit on). It appears in `routing` instantly with a countdown that shows **"Expected 5–20s"**.
3. Let a routine one match and accept (or click Accept in SIMULATION). The status walks to `assigned`, then `completed`.
4. Use the `stuck-high-priority` scenario. Past 20 s it shows **Overdue**. At 30 s the timeline shows timeout plus auto-retry, and the countdown reset.
5. While attempt #2 is pending, **Assign manually** to Ana. Then use "Deliver engine response now" on attempt #2 (choose Ben). The timeline shows "Late engine response … ignored … would have chosen Ben".
6. Decline as the contributor. The recovery panel shows Ana excluded. "Retry routing" dispatches to the remaining candidates only.
7. Open the same task in two tabs and act in both. The second tab gets the "changed while you were looking" message with the events.
8. Double-click Create. Only one task appears.
9. **Restart:** with tasks pending, Ctrl-C `dev:api`. The UI shows **"Connection lost…"**. Wait 40 s, then `npm run dev:api`. The toast "Server started after 42s offline. Caught up: …" appears, and the affected timelines show "processed late (server was offline)".
10. The footer's "last tick" stays under 1 s, and `GET /api/debug/invariants` (if built) returns `[]`.
11. Check the narrow window (about 1024px). Nothing overlaps.
12. `npm run check` passes. Paste its output into the session for the verification part of the session map.

### 10.9 Test budget summary
| Item | Tag | Est. (agent-assisted) |
|---|---|---|
| T+0 spike: `node:sqlite` under Vitest | MUST | 5 min |
| Harness + `checkInvariants` | MUST | 15 min |
| Unit tables (machine, eligibility, policy) | MUST | 5 min |
| Scenarios S1, S2, S3, S4, S6, S11 | MUST | 30 min |
| Restart test | MUST | 15 min |
| API tests ×4 | MUST | 10 min |
| Manual checklist run | MUST | 10 min |
| **MUST subtotal** | | **≈ 90 min** (overlaps the backend build, since tests are the dev loop) |
| Scenarios S5, S7, S8, S9, S10, S12 | SHOULD | 20 min |
| fast-check fuzz | SHOULD | 30 min |
| Boundary grep test (`sim_` not read outside `sim/`) | COULD | 5 min |
| GitHub Action running `npm ci && npm run check` | COULD | 5 min |
| Playwright E2E | WON'T | — |
| Load/perf tests | WON'T | — |

**Cut order if behind:** fuzz restart action → fuzz entirely → S10 → S12 → S5. Never cut S4, S6, S11 or the restart test, because they are the brief's four use cases plus the restart requirement.

---

## 11. Observability and debugging a stuck task

- **The event log is the audit trail.** Each event records who (`actor`), what (`type` plus a human `summary` written at write time, so old history reads correctly even if code changes later), which entity (`attempt_id`, `assignment_id`), the resulting `task_version`, and machine detail in `data` (`from`, `to`, `dueAt`, `lateByMs`, `wouldHaveChosen`, `candidateIds`, `note`). It's written in the same transaction as the change, so history and state can't disagree.
- **Liveness is visible.** `meta.last_tick_at` feeds `GET /api/health`, and the UI footer shows **"Reconciler: last run 0.4s ago"**. It turns amber above 3 s and red above 10 s ("Automatic actions are paused; the server may be down").
- **Runbook: "this task looks stuck"** (also goes in the README):
  1. Open the task. Read the **last event** and the **next automatic action**. If a countdown is running, the desk is waiting on purpose.
  2. `routing` past the deadline with no timeout event: check the footer. A stale last tick means the reconciler isn't running (server down or crashing). Check the logs for `reconciler` errors.
  3. `routing` within the deadline: the engine is slow or lost, and we can't tell which by design. The operator can Retry, Assign, or Stop.
  4. Dev only: `npm run inspect -- T-104` (COULD) dumps rows plus the timeline **plus the sim's secret fate** ("attempt #1: never returns"). It's the only place outside the SIMULATION panel where that fate is visible.
  5. `GET /api/debug/invariants` (COULD) shows whether state is internally consistent.
- **Metrics:** WON'T build. The README names what we'd track: routing latency p50/p95 by priority, observed never-return rate, timeouts per hour, time-in-`needs_attention`, late-result rate. Late results are interesting because they show deadlines that are too tight.

---

## 12. Path to production (README section, brief)

- **Postgres instead of SQLite.** The partial unique indexes port verbatim. Commands become `BEGIN; SELECT … FROM tasks WHERE id=$1 FOR UPDATE; …; COMMIT`, alongside the existing version CAS. Contributor capacity gets a row lock on the contributor (`FOR UPDATE`) or a counter column with `CHECK (active_count <= capacity)` maintained in the same transaction.
- **Multiple instances.** The reconciler claims due rows with `SELECT … WHERE deadline_at <= now() FOR UPDATE SKIP LOCKED LIMIT 100`, so any instance can run it with no leader needed. Alternatively, a single leader via `pg_try_advisory_lock`. A durable scheduler (pg-boss, graphile-worker, SQS delay queues) can replace polling for timers.
- **Outbox.** Write the attempt and an `outbox` row in one transaction. A relay publishes to the engine with at-least-once delivery. Today's "the deadline recovers a lost dispatch" property stays as the backstop.
- **A real engine.** Results arrive by **signed webhook** (HMAC over the body plus timestamp, a 5-minute replay window). `attemptId` is the idempotency key. Responses return 2xx for stale or duplicate results (they're recorded, not errors), so the engine doesn't retry forever. Optionally send a cancel to the engine when an attempt is superseded.
- **Push.** SSE or WebSocket "something changed (task, version)" pings, with the snapshot or detail fetch kept as the resync path.
- **Auth and roles.** Operator SSO; contributor responses authenticated as that contributor; sim and admin routes removed from prod builds.
- **Ops.** Structured logs to a collector, metrics (§11), alerts on reconciler heartbeat age and `needs_attention` age, and event-schema versioning (`events.schema_version`).

---

## 13. MUST / SHOULD / COULD / WON'T — this dimension

**MUST**
- The A1–A9 stack decisions and the single-package layout with one-command `dev`, `reset` and `test`. `dev:api` and `dev:web` stay separate for the restart demo.
- `tx()` helper; `runCommand` pipeline; effects after COMMIT; `clock.now()` once per command.
- DDL with CHECKs, both partial unique indexes and append-only triggers.
- Durable sim (`sim_jobs`) + pump + reconciler under a single ordered `tick()`. Boot catch-up with a system event and `bootId`.
- API: health, snapshot, task detail, create, the `commands` union, the contributor `respond`, sim `deliver`, admin reset. Error envelope and codes.
- Harness and invariants; unit tables; scenarios S1, S2, S3, S4, S6, S11; restart test; 4 API tests; manual checklist.
- JSON logger with the command, engine, reconciler and boot lines.

**SHOULD**
- Pre-COMMIT invariant assertion.
- `clientRequestId` create idempotency.
- Per-attempt deterministic fate (`rngFor(seed, taskNo, attemptNo)`).
- Sim config GET/PUT, per-task scripts, named scenarios.
- Scenarios S5, S7–S10, S12; fast-check fuzz.
- Footer heartbeat; Prettier.

**COULD**
- `npm run inspect`.
- `/api/debug/invariants`.
- `/api/events` feed.
- `/api/engine/results` webhook shape.
- Boundary grep test.
- CI workflow.
- `lucide-react`.
- Reconciler poison back-off.

**WON'T**
- Fastify, ORM or query builder, workspaces, bun.
- SSE or WebSocket.
- Migration framework.
- Playwright.
- Auth.
- Pagination.
- Optimistic UI updates. Commands are server-authoritative, and a local round trip is under 50 ms.
- Metrics stack.
- Generic idempotency-key table.
- Operator override of the expertise or capacity rules.

---

## 14. Divergences and open questions for the synthesizer

| # | Topic | Baseline | This section proposes | Owner to reconcile |
|---|---|---|---|---|
| D1 | Restart model (#11) | open: A or B | **B, durable `sim_jobs`**, plus contributor auto-responses durable in the same table | Engine, Time & Concurrency |
| D2 | Tick order | unspecified | **pump before reconciler**: "an answer in the inbox beats a timeout we were too dead to enforce" | Engine, Time & Concurrency |
| D3 | Reconciler interval | ~1 s | **500 ms** (minor; countdowns land within half a second) | Engine, Time & Concurrency |
| D4 | Create idempotency | idempotency key | **`tasks.client_request_id UNIQUE`**; operator commands are idempotent through `expectedVersion` | Domain & State |
| D5 | Command API shape | per-command endpoints implied | **`POST /api/tasks/:id/commands`** with a zod discriminated union | Operator UX (client hook) |
| D6 | Version bump on late results | unspecified | **no bump.** A recorded late result appends an event but doesn't 409 operators | Domain & State |
| D7 | Engine picks a now-unavailable or invalid contributor | `invalid_engine_result` → needs_attention | **system-class failure → auto-retry within budget**, and needs_attention only when the budget is exhausted | Domain & State / Engine |
| D8 | Duplicate identical engine result | "recorded" | **log-only, no event.** A *different* payload for a resolved attempt is recorded as `late_result` | Engine, Time & Concurrency |
| D9 | Package layout | open (workspaces vs single) | **single package**, relative imports, no aliases | Delivery |
| D10 | SQLite driver | open | **`node:sqlite`**, verified locally on Node 26.5 / SQLite 3.53.4; better-sqlite3 fallback behind the wrapper | — |
| D11 | Late result for attempt #1 while #2 is still pending | strict fencing | **keep strict** (S5 encodes it). Alternative "adopt a valid late answer while still routing" is noted as a considered tradeoff | Engine, Time & Concurrency |
| D12 | Zero available because everyone is at capacity | no_eligible_contributors | same reason code, but the detail distinguishes "0 match expertise" from "N match but are at capacity". **WON'T** build a waiting-for-capacity queue (README "next") | Domain & State |

**The verification story for the Loom and session map, in one paragraph:** state changes happen only inside guarded, synchronous transactions. The same invariant checker runs before every commit and after every step of every test. Six use-case scenarios and a restart test replay the brief's situations deterministically with a fake clock. A fast-check fuzz throws random interleavings of operator actions, late or duplicate engine replies, contributor responses, clock jumps and restarts at the system, and the invariants still hold.
