# Corrections log

Written when they happen, never reconstructed. Entries below were recorded during the build session (2026-10-08).
**Author: add your own redirects of the agent here as they happen, and pick the most important one for the session map.**

## C-1: Pre-build plan amendments A1–A6
- When: start of the build session, before any code.
- What changed: PLAN.md §15 — operator exits go to Not routed (A1), late-answer advice is MUST (A2), the seed replays real
  commands and starts two live tasks (A3), new MUST tests (A4), one action = one command (A5), README-vs-repo check (A6).
- Origin and rationale: _to be written by the author._
- Proof: `test/scenarios/use-cases.test.ts` (stop routing → Not routed), `test/seed.test.ts`, `test/api.test.ts`
  ("slow and never-returning look identical"), `test/unit/fate.test.ts`.
- Importance: medium–high (changes product semantics).

## C-2: The domain relied on a database CHECK for title length
- What the agent did: `createTask` passed titles straight to SQL; only the HTTP layer validated them.
- How noticed: the restart test used 2-character titles and failed with a raw `CHECK constraint failed` from SQLite —
  through any path other than HTTP that would have been a 500.
- Correction: `createTask` now validates 3–120 characters and throws a `DomainError` (400); the test titles were fixed.
- Proof: `test/api.test.ts` ("rejects invalid input"), `test/scenarios/restart.test.ts`.
- Importance: low (defence in depth).

## C-3: A test asserted the wrong order of events
- What: "a pick outside the request's candidate snapshot" made a contributor unavailable *after* the request was sent,
  so the snapshot still contained them. The code was right; the test was wrong.
- Correction: set availability before creating the task. Kept the assertion that later changes don't alter the frozen snapshot.
- Importance: low.

## C-4: UI issues found by screenshot review (headless Chrome)
- "Send offer" wrapped onto two lines; the In-flight summary text was truncated; the simulation box sat below a long
  history (hard to reach); after **Reset demo** the restart toast would have claimed the server restarted.
- Corrections: `whitespace-nowrap` on buttons; shorter summary; simulation box above history; the toast only appears
  when `lastBoot.offlineMs` is set (a real restart). `resetDb` now also clears cached prepared statements.
- Importance: low–medium (operator clarity).

## Verification of the test suite itself (not a correction)
Mutation check: removing the fencing condition failed 12 tests (including all 5 random walks); judging deadlines by
processing time failed the exact-deadline test; skipping the pick re-check failed 7 tests. All reverted.

## C-5: The operator UI was rejected as confusing; full redesign on shadcn/ui
- When: 2026-10-08, after the v1 hand-off, on first look at the running app.
- What the human said (verbatim, expletives removed): "what is this … so confusing in UI redesign everything drop this …
  design see how label box mercor … snorkel AI these companies design such platform … very clear very organized very
  production level for user friendly and use all new library shad cn or whatever is the best … do your own research".
- What the agent had done: a dense, single-screen "ops console" (13px text, uppercase micro-labels, a five-tile strip,
  grouped table, a 560px drawer stacked with six sections, a striped violet dock). Every behaviour was tested, but the
  screen was judged on how it reads, and it read as cluttered.
- Correction: research the product UIs of Labelbox, Mercor and Snorkel AI; rebuild the client on shadcn/ui (Radix +
  Tailwind v4) with an app shell (sidebar, page header), a proper data table, a task sheet with tabs, and clearer hierarchy.
  The data layer, copy rules and one-action-one-command behaviour are kept; the server is untouched.
- Proof: `npm run check` (typecheck + 64 tests) and `vite build` green after the redesign; a scripted headless-Chrome
  tour of every page, dialog and sheet (desktop and 390 px), the live states (routing → overdue → retry → offer with a
  late answer recorded), a real API stop/start (offline banner, restart toast, "enforced at startup") and non-modal panel
  switching, with no console errors. Decision record: `docs/DECISIONS.md` D15.
- Importance: high (the operator experience is half of the brief).

## C-6: "Looks AI-made": visual identity, brief audit, and a much larger test suite
- When: 2026-10-08, after reviewing the shadcn redesign (C-5).
- What the human said (verbatim): "It doesn't look that attractive. It looks like AI made, not like a real website. A
  little colorful and attractive. … go through the take home assignment. Are we covering each and everything? …
  Write a lot of unit tests, make more and more tests, check all operations are working fine in every possible way".
- What the agent had done: a correct but default-looking shadcn layout (grey neutrals, black buttons, identical stat
  cards with corner icons), a requirements check only against PLAN.md rather than line by line against the brief, and
  64 tests concentrated on the server's hardest rules.
- Correction: (1) research what makes well-loved product UIs feel crafted and give the desk a real visual identity;
  (2) audit the README and product line by line against the brief (now a coverage table in the README);
  (3) add exhaustive tests: a state × command matrix, every simulation preset, every endpoint, pure-function units, and
  a browser end-to-end suite of the use cases.
- Research finding that set the direction: Terac's own site uses an electric ultramarine on warm off-white with Geist and
  Geist Mono; aligning with that reads as intentional rather than templated. Violet stays reserved for simulation and is
  now also hatched, so it reads even in greyscale (blue and violet are only ~26° apart in hue).
- Proof: screenshots of every page, dialog and panel (desktop and 390 px); `npm run check` (1,086 test cases) and
  `npm run test:e2e` (16 browser tests) green; README *Brief coverage* table maps each line of the brief to the product
  and to the test that proves it.
- Importance: high.

## C-7: Bugs found by the exhaustive test suite (agent-written tests, fixed in src)
- How: a test-writing subagent was told not to touch `src/`, to keep any test that exposed a real bug failing, and to
  report it with a diagnosis. Four tests failed; three root causes:
  1. Body-parser refusals (body too large, unsupported charset) returned **500** instead of 413/415.
     Fix: the HTTP error handler passes through body-parser's own 4xx (`src/server/http/routes.ts`).
  2. *Deliver no match* reported `applied: false` although the desk had acted on it (the task went to Needs attention), so
     the simulation card said "not applied". Fix: an on-time no-match returns `applied: true` (`commands/desk.ts`).
  3. The restart summary under-counted: a timeout or expiry enforced *inline* while catch-up applied a late answer or a
     reply wasn't counted. Fix: the summary counts the `attempt_timed_out` / `offer_expired` events catch-up actually wrote,
     so it can't disagree with the history (`scheduler/boot.ts`).
- Also tightened from the same report: task ids must be plain decimal (`/api/tasks/0x65` no longer resolves to T-101);
  unknown keys inside `sim` are rejected; a release needs a reason in the domain, not only over HTTP; an out-of-order
  contributor reply (e.g. "start" before accepting) is now recorded once as *Ignored*, as PLAN TT-22 specified. The
  timeout history line no longer says a request "may be lost": it says it may be slow or may never answer.
- Proof: the four failing tests now pass; new tests pin the hardening (`test/api.more.test.ts`, *hardening found by this
  suite*); the matrix test was updated to the PLAN behaviour for out-of-order replies (stricter, not weaker).
- Importance: medium–high (two of the three were user-visible).

## C-8: Adversarial bug bash before submission (two agents trying to break it, fixes in src)
- When: 2026-10-09, after the human asked for more testing and edge cases "so they can't find any mistakes".
- How: two report-only agents attacked their own copies of the app. One drove the UI in a real browser (every action and
  state, double-clicks, hostile text, 150+ tasks, URLs, offline/restart, keyboard, viewports). The other attacked the API
  and the process (concurrency bursts with invariant checks, `kill -9` under load and mid-seed, clock jumps, malformed
  input, production mode). Every finding was checked against the code before fixing; each fix has a test that fails
  without it.
- What held up: none of R1–R13 broke. 200 parallel offers with one version → 1 success, 199 conflicts; 12 kills under
  load → 0 invariant violations; no stack traces, SQL or paths in any response; no path traversal.
- Fixed (server):
  1. A second desk process (same port, or same database on another port) wrote a fake "Desk restarted" into the live
     database before failing to listen. Now the port is claimed and a per-database lock taken **before** the database
     is opened; a second copy exits 1 with a readable message (`main.ts`, `infra/lock.ts`; `e2e/process.spec.ts`).
  2. A kill during *Reset demo* could brick the database (tables dropped one by one). Reset is one transaction (`db.ts`).
  3. A kill during the first seed left a half-seeded database forever. The seed writes a marker last; a database with
     contributors but no marker is reset and reseeded at start (`db.ts` `seedState`, `main.ts`).
  4. Any web page could reset the demo with a plain form post. Writes from another site (Origin / Sec-Fetch-Site) get
     403 (`routes.ts`).
  5. `/api/health` returned the simulation seed, from which every request's fate could be computed (R12). Removed.
  6. Boot catch-up processed all answers, then all timeouts, then all expiries, so a restart could change an outcome.
     It is now time-ordered (DECISIONS D18, PLAN A7).
  7. A NUL in a title, or a malformed `%`-escape in any URL, returned 500. Control and invisible characters are refused
     in the schema and the domain; title length counts characters the same way in zod, the domain and SQLite; URL
     decode errors are 400.
  8. A clock that moved backwards produced "~0s offline" and negative durations. The restart line now says the clock
     moved back and by how much.
  9. A refused *Respond as* click cancelled the contributor's scheduled reply. Only an applied one does now.
  10. Repeating a refused reply grew the history without bound. It is recorded once per action and assignment state.
  11. Health said ok while deadlines weren't being enforced. It is 503 when the last tick is more than four ticks old.
  12. Production static serving: a missing `/assets/*` returned the app shell (200 HTML for a script); fingerprinted
      assets were not cached. Now 404, and `immutable` for a year; ETags off for no-store JSON.
  - Also: cancelling a task someone holds needs a reason in the domain (it was UI-only; PLAN A8); clearer wording for
    capacity ("at capacity, 1 of 1"), offers that override an exclusion, and quoted notes.
- Fixed (client, by a forked agent that owned `src/client` only):
  1. **A decision in an open dialog was applied to whatever the task had become.** The dialog sent the version from the
     live poll at the moment of sending, so an engine offer behind an open *Cancel* dialog was cancelled silently.
     Dialogs now freeze the version and last-seen event when they open; the change comes back as a conflict
     (`hooks/data.ts`, `TaskSheet.tsx`; `e2e/desk.spec.ts` "a decision made in an open dialog…").
  2. Task titles collapsed to 0 px between 768 and ~1200 px; the pipeline strip overflowed at narrow widths with ≤60
     tasks; long unbroken notes pushed dialog buttons off-screen; briefs lost their line breaks.
  3. Offline: countdowns kept running and buttons stayed enabled; a failed send closed the dialog and lost the note.
     Now absolute due times, disabled actions with the reason, and the dialog keeps what was typed.
  4. Performance: the whole app re-rendered 4×/s; Activity refetched every loaded page every 2 s. Now 1×/s aligned to
     server seconds, and Activity polls only its newest page.
  5. Keyboard and accessibility: the task panel trapped Tab and lost focus on close; pipeline blocks lost their button
     role; avatars had no names; `N` fired over open menus. Fixed, plus `dir="auto"` on user text, strict `?task=` ids
     and 404s that stop polling.
- Not fixed (2 of 31): a boot killed *during* catch-up leaves the next restart line under-counting what it did (the
  history is complete; the suggested fix would have miscounted normal uptime events); the task panel still covers the
  search box at 1440 px (pushing the board aside left it ~550 px, which read worse). Scale and operations limits are in
  README *Production notes* (snapshot size, retention, Host allow-list, simulation endpoints in production builds).
- Process note: during this pass the agent ran a code formatter with no project configuration, restyling ~17 files;
  restored to the house style the same hour (no logic changed; the full suite was green before and after).
- Proof: `npm run check` (1,157 test cases, including `test/scenarios/bug-bash.test.ts`, one block per finding) and
  `npm run test:e2e` (25 browser and process tests) green; the catch-up test fails if the old order is restored.
- Importance: high (findings 1–4 and the stale-dialog bug were each a way to lose or corrupt the operator's work).
