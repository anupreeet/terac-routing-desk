# Decisions

> Draft written with the coding agent from PLAN.md. **Author: review each entry and restate it in your own words** —
> you will be asked to defend these.

Format: Context → Decision → Alternatives → Consequences → One-liner.

## D1. One process, TypeScript end to end, `node:sqlite`, raw SQL
- **Context:** 5-hour budget; local persistence is acceptable; correctness under races matters most.
- **Decision:** Express 5 + `node:sqlite` (`DatabaseSync`) + React/Vite, one package. All desk SQL in `store/repo.ts`.
- **Alternatives:** Next.js + Prisma + Postgres (Docker, more moving parts); better-sqlite3 (native build).
- **Consequences:** Synchronous transactions serialize every command in-process. No multi-instance story (documented).
- **One-liner:** The fencing rules live in visible `WHERE` clauses, not behind an ORM.

## D2. Rows are the truth; events are an append-only log written in the same transaction
- **Alternatives:** Event sourcing (rebuild state from events) — more machinery, harder to query.
- **Consequences:** History can never disagree with state. Triggers refuse UPDATE/DELETE on `events`.

## D3. Fencing: first terminal transition wins; late answers are recorded, never applied
- **Decision:** `tasks.current_attempt_id` is the fencing pointer. An engine answer applies only if the attempt is
  `pending`, is current, and the task is `routing` — checked in one transaction. Otherwise the answer is written onto
  the attempt once and a `late_result_ignored` event explains why. Still-useful late picks surface as one-click advice.
- **Alternatives:** "Any valid answer wins" (adopt late answers automatically) — fewer clicks, but two sources of truth
  and order-dependent outcomes.
- **One-liner:** A late answer can never overwrite a human decision, but you still get to see what it said.

## D4. Time lives in columns; one `tick()` enforces it; catch-up runs before `listen()`
- **Alternatives:** `setTimeout` per request (lost on restart; needs special recovery code).
- **Consequences:** A restart is just a long gap between ticks. Tests drive time with a FakeClock — no fake timers.

## D5. The deadline is judged by when the answer arrived, not when we processed it
- **Decision:** `available_at < deadline_at` for engine answers. Contributor actions are judged at processing time
  (they need our API to be up; the engine's inbox doesn't).
- **One-liner:** The outcome does not depend on when the ticker happened to run.

## D6. Pending policy: Overdue at 20 s for everyone; stop waiting at 30/45/60 s; 2 retries per round
- **Why Overdue is the same for every priority:** it is a fact about the engine's normal window (5–20 s).
- **Why high priority waits less:** we're less willing to sit on a request that may be lost.
- **Copy rule:** never "stuck", "failed" or "lost" — "no answer yet", "stopped waiting", "may still answer".
- **Consequence:** every automatic action is announced by a countdown first.

## D7. Machines retry machine failures; a person's "no" goes to a person
- Timeouts and unusable picks retry automatically within the budget. Declines, expiries, withdrawals, releases and the
  engine's "no match" go to `needs_attention` with a *Your decision* section. Re-routing excludes people who said no.

## D8. Operator-initiated exits go back to Not routed, not to Needs attention (PLAN §15 A1)
- `stop_routing` and `revoke_offer` return the task to `new`. `needs_attention` only holds things that happened to the task.

## D9. An operator pick is an offer, on the same lifecycle as an engine pick
- The contributor must still accept. Exclusions bind the engine, not the operator, who can override after a confirm.

## D10. Capacity, with offers counting, re-checked when a pick is applied
- The only coupling between tasks; carries the "several tasks routed at once" story (two tasks contending for one person).

## D11. The simulated engine is an outside service with a durable inbox the desk cannot read
- Fates are decided at dispatch from a seeded RNG and stored in `sim_jobs`. Desk code never reads `sim_*` (architecture
  test). A slow request and a lost one produce identical API output (API test).
- **Alternative considered:** an in-memory engine whose requests die on restart (simpler, but restarts would never exercise fencing).

## D12. Optimistic concurrency with `expectedVersion` + `seenEventId`
- `version` bumps on every operator command and on status/assignment changes, but not on automatic retries or late
  results (no spurious 409s). A 409 returns the events the client hasn't seen.

## D13. One user action = one server command = one transaction (PLAN §15 A5)
- Create-and-route is one transaction on the server; the client never chains two commands.

## D14. Polling over push; server-time offset on the client
- 1 s polling survives restarts with no reconnection logic. Ages and countdowns use the server's clock.

## D15. Operator UI: shadcn/ui on Radix, in Terac's own visual language (CORRECTIONS C-5, C-6)
- **Context:** The first UI was rejected as confusing; the second as "AI-made". Research into Linear, Attio, Plain, Stripe,
  Mercor, Snorkel and Terac's own site showed the tells (stock grey template, identical stat cards, one chip shape for
  everything) and what crafted products do instead (one brand colour used sparingly, status as icon + label, colour-coded
  categories in icon tiles, mono for IDs and timers, a headline that says something).
- **Decision:** Terac ultramarine (#1F2CF4) on warm paper (#F4F4F1), Geist + Geist Mono. Blue is spent on actions, focus,
  selection and "routing"; status colours carry state; expertise colours live only in icon tiles; violet *and hatching*
  mean simulation. Tasks page: a sentence headline, a *Needs you* card, a pipeline with one block per task, an engine
  strip, and a table with draining countdowns. Task panel: non-modal, status-coloured header, lifecycle stepper.
- **Dependencies, and why:** `radix-ui` (accessible primitives behind shadcn), `class-variance-authority` and `cn`
  (shadcn's variant and class-merging helpers), `tw-animate-css` (shadcn's animations), `sonner` (toasts),
  `@fontsource-variable/geist` and `geist-mono` (self-hosted fonts, no CDN). Dev only: `shadcn` (CLI and its stylesheet),
  `@playwright/test` (browser suite; uses the installed Chrome locally, Playwright's Chromium in CI).
- **Alternatives:** Mantine or MUI (heavier, harder to make look like anything but themselves); hand-rolled Tailwind
  (what was rejected first).
- **Consequences:** `components/ui/` is generated code checked in (overlay blur removed, task panel made non-modal by hand).
  Vendor code ships in separate cached chunks.
- **One-liner:** Same desk, same rules; the screen now looks like Terac built it.

## D16. "State of the operation" includes the engine's recent behaviour, and history is desk-wide too
- **Context:** The brief asks to see the current state of the operation and to inspect enough history. The operator
  can't know about one pending request, but can see a pattern: answer times, how often requests go unanswered.
- **Decision:** The snapshot carries engine health for the last 24 h (sent, waiting, overdue, answered in time, matched,
  no match, no answer by the deadline, stopped by the operator, late answers, median and p90 answer time). It counts
  outcomes and never predicts one, so a slow request and a never-returning one still look identical. `GET /api/activity`
  pages the whole event log backwards with the task title attached; the Activity page filters it by actor.
- **Proved by:** `test/operations.test.ts` (including "identical for a slow request and a never-returning one").
- **One-liner:** You can't know about one request; you can see how the engine has been behaving.

## D17. Every contributor reply that isn't applied is still recorded
- **Decision:** A reply to an ended assignment, and (since C-7) a reply that doesn't fit the assignment's status, changes
  nothing and is recorded once as *Ignored* with the reason (PLAN TT-22). Replies are judged when processed; engine
  answers are judged by when they arrived (D5) because the engine's inbox has a timestamp and a person's reply in this
  demo doesn't.
- **One-liner:** If someone tried to do something, the history says so, even when it couldn't happen.

## D18. Catch-up after downtime happens in the order things happened
- **Context:** The API bug bash showed boot catch-up delivered every due answer first, then every timeout, then every
  expiry. After downtime, a pick could be rejected as "at capacity" because of an offer that had expired *before* the
  answer arrived; the same history then recorded the expiry, contradicting itself.
- **Decision:** One time-ordered pass: before each delivery (stamped with its arrival time), enforce every deadline at or
  before that time. Records keep their true times (an attempt closes at its deadline, an offer ends at its expiry);
  events are written at processing time and tagged as catch-up.
- **Alternatives:** Ignore offers past their expiry when counting load (fixes one symptom, not the order); full
  virtual-time replay (re-running the ticker over the gap: more code, same outcome for this model).
- **Proved by:** `test/scenarios/bug-bash.test.ts` ("restart catch-up handles what came due in the order it happened":
  the same world always-up and restarted reaches the same outcome; the test fails with the old order).
- **One-liner:** A restart should never change what would have happened.
