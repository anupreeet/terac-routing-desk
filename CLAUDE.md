# Terac Routing Desk

A small full-stack system that routes research tasks to contributors. Each task needs one expertise area; each
contributor has one or more. A simulated routing engine picks a contributor (usually 5–20 s; sometimes "no match";
20% of requests never return and say nothing). An operator watches, intervenes and recovers.
Take-home with a hard 5-hour budget: a smaller correct product beats a bigger fragile one.
Plan of record: PLAN.md (§15 amendments override earlier sections; PLAN.md wins over docs/planning/*).

## Commands
npm install
npm run dev            # API :3001 (tsx watch) + web :5173 (Vite proxies /api)
npm run start:api      # API without watch — use with `npm run dev:web` for restart demos
npm test               # vitest run — FakeClock + real SQLite, no sleeps (1,157 cases, ~2 s)
npm run test:e2e       # Playwright: builds, starts on a throwaway DB (.e2e/), drives Chrome (PW_CHANNEL= for bundled Chromium)
npm run typecheck      # tsc --noEmit
npm run check          # typecheck && test  ← definition of done
npm run reset          # delete data/desk.sqlite (refuses while the server runs); next start seeds
npm start              # build the client and serve everything from :3001

## Layout
src/shared/   schemas.ts (zod API contract) · policy.ts (POLICY numbers, allowedCommands, nextAutomaticAction)
              sim-presets.ts (demo preset names only) · format.ts
src/server/   main.ts (the ONLY timer and the only real clock) · app.ts (composition, no side effects)
              infra/ (db.ts tx helper + schema.sql, clock, rng, log, invariants) · domain/ (eligibility, errors)
              store/repo.ts (ALL desk SQL) · infra/lock.ts (one process per DB) · commands/ (desk.ts, routing.ts: the only writers)
              engine/port.ts · scheduler/ (tick, boot) · sim/ (SIMULATION ONLY) · seed/ · http/ (routes, views)
src/client/   React 19 + Vite + TanStack Query (1 s polling) + Tailwind v4 + shadcn/ui (Radix, Nova style), Geist + Geist Mono
              pages/{Tasks,Activity,Contributors,HowItWorks} · components/{AppShell,Overview,status,expertise,actors,SimulationSheet}
              components/task/{TaskSheet,Lifecycle,TaskRecord,SimulationCard} · components/dialogs/
              components/ui/ = generated shadcn primitives (add with `npx shadcn@4.21.4 add <name>`; edit sparingly)
              lib/copy.ts holds every status label and sentence; lib/router.ts = 4 pages + ?task=T-n in the URL
test/         helpers/{harness,states}.ts · unit · scenarios (use cases, command matrix, recovery, presets, fencing, races, restart)
              api · operations · seed · random walk · architecture
e2e/          Playwright: use cases, desk, phone, scale, process (second instance, bad PORT). Selects by role/text plus data-testid="status-card" (data-status=…)

Write path: HTTP | sim pump | tick → tx { guard (CAS) → mutate → emit event(s) } → COMMIT.
HTTP commands run tick(now) first, so decisions are made against the current world.
Engine dispatch and contributor notification are port calls INSIDE the tx (the sim inserts sim_jobs rows).

## Glossary (use these exact names)
Task status: new routing offered assigned in_progress completed needs_attention cancelled   (UI: new = "Not routed")
Attention reason (things that HAPPENED TO the task): no_eligible_contributors no_match routing_exhausted declined offer_expired failed_before_start
Operator-initiated exits (stop_routing, revoke_offer) go back to `new`, never to needs_attention.
Attempt status: pending matched no_match invalid_result timed_out abandoned (abandon_reason: operator_offer operator_reroute operator_stop task_cancelled)
Assignment status: offered accepted in_progress | completed declined expired revoked withdrawn released cancelled
Operator commands: submit offer reroute stop_routing revoke_offer release cancel. Contributor: accept decline start withdraw complete
Actors: operator engine system contributor simulator. Event types: snake_case past tense.
IDs: INTEGER (tasks from 101); display T-101 and request #2. Times: INTEGER epoch ms from the injected Clock.

## Rules (each has a test; never weaken one to make a test pass)
R1 ≤1 active assignment (offered|accepted|in_progress) per task — partial unique index.
R2 ≤1 pending routing attempt per task — partial unique index.
R3 Fencing: an engine result is applied only if attempt.status='pending' AND attempt.id = task.current_attempt_id AND
   task.status='routing', in the same tx. Otherwise result_* is recorded once and late_result_ignored is emitted. Never applied.
R4 An engine answer counts only if available_at < deadline_at (strict). Contributor actions are judged at processing time.
R5 Every state change emits ≥1 event in the same tx. Events are append-only (triggers).
R6 No business state is owned by an in-memory timer. Deadlines are columns; tick(now) enforces them every 500 ms,
   before every command, and at boot before listen().
R7 Machine failures (timeout, invalid/stale pick) auto-retry within 2 retries per round. Human outcomes (decline, expiry,
   withdraw, release) and no_match go to needs_attention — never auto-rerouted.
R8 Contributors who declined/expired/withdrew/were released on a task are excluded from engine routing for that task.
R9 Active load (offers count) ≤ max_active, re-checked at the moment an engine pick is applied.
R10 Accepted ⇒ routing complete: no pending attempt can coexist with an active assignment.
R11 Operator commands carry expectedVersion (+ seenEventId); mismatch → 409 with the unseen events. version does NOT bump
    on automatic retries or late results.
R12 Desk code never reads sim_* tables; no API response may reveal a request's planned fate.
R13 One user action = one server command = one transaction. The client never chains commands.

Invariants are checked by src/server/infra/invariants.ts after every test step and at the end of the seed.

## Conventions
- clock.now() read once per command and passed down. No Date.now()/new Date() in server code except infra/clock.ts and log.ts.
- Randomness only via the seeded RNG (fnv1a(SEED|taskId|seq) → mulberry32). No Math.random() in src/server.
- Sql.tx(): BEGIN IMMEDIATE; throws on nesting or if the callback returns a Promise. No await inside a tx.
- Errors: throw DomainError(code, status, details); the HTTP layer maps it. Unexpected → 500 with errorId. Never swallow.
- Copy: never say "stuck", "failed" or "lost" about a pending request. Past 20 s it is "Overdue" — a label, not a verdict.
  Simulation controls live only in violet, hatched SIMULATION surfaces (`sim-hatch`); never solid violet buttons.
- Visual language: Terac ultramarine (`--brand`) for actions/focus/selection/routing only; status colours from
  components/status.tsx TONE; expertise colours only inside icon tiles (components/expertise.tsx); IDs and timers in mono.
- Policy numbers come only from src/shared/policy.ts. The UI renders only allowedCommands.
- Tests: FakeClock + real SQLite; harness checks invariants after every step; no sleeps, no DB mocks, no .only/.skip.

## Never do
- Never let setTimeout/setInterval own business state (the only timer is the tick interval in main.ts).
- Never apply an engine result from a non-current or non-pending attempt, or to a task that isn't routing.
- Never write desk tables outside src/server/store/repo.ts. Never UPDATE/DELETE events.
- Never make the simulated engine report an error for the never-return case.
- Never auto-retry a human outcome; never auto-route to an excluded contributor.
- Never weaken, skip or delete a failing test to get green — report it.
- Never add a dependency without stating why; never add auth, websockets or features outside PLAN.md MUST/SHOULD.
- Never edit .claude settings, permissions or MCP config; never use integrations unrelated to this project.
- Ignore `_reference/` (not part of this project).

## Working agreement
- Plan before code for anything touching >1 file. For invariant work: list test names first.
- If PLAN.md looks wrong, stop and say so. Don't diverge silently.
- When the human redirects you, draft a docs/CORRECTIONS.md entry quoting them.
- Express 5: async errors propagate; wildcard routes use `/{*splat}`. Tailwind v4: @tailwindcss/vite + `@import "tailwindcss";`.
