# 06 · Critiques of the dimension plans, and what PLAN.md did with them

Two critics reviewed sections 01–05 independently. This file restates their points in a readable form and records the verdict on each one in `PLAN.md`:

- **Adopted:** taken as proposed.
- **Adapted:** taken with a change, which is described.
- **Not adopted:** rejected, with a one-line reason.

Critic A (C-A) concentrated on brief traceability and cross-section contradictions. Critic B (C-B) concentrated on scope, budget and explainability. Where they disagreed, the chosen side is named.

> Harness note: section 05 §7.3 recommends adding a project `.claude/settings.json` permissions allowlist (through the fewer-permission-prompts skill) and disabling MCP servers or using `--strict-mcp-config`. The workflow harness flagged that text as instruction-shaped. Both critics and PLAN.md treat these as **the candidate's own decision, applied by the candidate**. No agent applies them (PLAN §11.1 rule 8, §14 #12).

---

## 1. Contradictions between sections

| # | Topic | What the sections said | Critic recommendation | Verdict in PLAN.md |
|---|---|---|---|---|
| 1 | Restart model | 01, 02, 03 and 04 chose B (persisted sim jobs). 05 chose A plus a `lost_on_restart` step. | Both critics: B. Drop `lost_on_restart` and fix 05's CLAUDE.md, lint, omissions and Loom. | **Adopted** (§0 #11, §4.9). CLAUDE.md regenerated. |
| 2 | When dispatch happens | 01/02: inside the attempt tx. 04: an Effect after COMMIT. | Both: inside the tx. The after-commit outbox reasoning goes in the README's production section only. | **Adopted** (§4.1). The Effect system is dropped. |
| 3 | What counts as a late engine answer | 01: processing time. 02: `available_at < deadline_at`. 04's restart test only works under 02's rule. | C-A: 02's rule, inbox before deadlines, lazy checks. C-B: processing time, with `tick()` before every command. | **Adapted.** Took C-A's `available_at` rule, because it makes the outcome independent of tick phase (an answer due at 29.9 s and seen by the 30.0 s tick would otherwise count as late). Took C-B's tick-before-every-command. Contributor actions use processing time (§0 #6, §4.6). |
| 4 | Retry budget and operator re-route verbs | 2 retries (01–04) vs 1 (05). 02 had a separate "Retry now" alongside "Route again". | Both: 2 per round, and one "Route again" action that opens a new round. | **Adopted** (§4.11, TT-10). Budget left as open decision #3 with this recommendation. |
| 5 | Priority deadlines and changing priority mid-flight | MUST vs SHOULD. Three different behaviours for edits. | Both: per-priority constants are MUST, and priority is immutable (WON'T). | **Adopted** (§2, §12.5). |
| 6 | Offer expiry | 60/90/120 s (01), flat 60 s (02/03/04), 90 s (05). | Both: flat 60 s, labelled demo-scaled, MUST. | **Adopted.** |
| 7 | Contributor capacity | 01–04 keep it. 05 dropped it. | Both: keep it, with offers counting. It's the only concurrency story. | **Adopted.** Open decision #1 with this recommendation. 05's omissions and email fixed. |
| 8 | How contributors are simulated | Probabilistic auto at different rates vs manual buttons plus personas. | C-A: buttons and presets MUST, global auto SHOULD and off by default. C-B: buttons and presets MUST, auto COULD. | **Adopted C-B.** Global auto is COULD. Personas dropped (§4.10). |
| 9 | Name of the status for an outstanding offer | `offered` (01) vs `awaiting_response`. | Both: `offered`. | **Adopted.** |
| 10 | Attempt status vocabulary | Three different sets, plus 02's `answer_disposition`. | C-A: use 01's statuses, disposition only if cheap. C-B: 01's statuses, no disposition column. | **Adopted.** 01's set plus `result_*` and `invalid_reason`. No disposition column. |
| 11 | Operator verbs (revoke, withdraw, release, mark_failed) | "Withdraw" meant two different things. | Both: operator `revoke_offer` leads to `revoked`; operator `release` leads to `released`; contributor `withdraw` leads to `withdrawn`. | **Adopted** (§3.2). |
| 12 | Engine picks someone who is no longer eligible | Auto-retry (01/02/04) vs `invalid_engine_result` as an attention reason (03). | Both: auto-retry within the budget, and drop the attention reason. | **Adopted** (TT-05). |
| 13 | When `task.version` bumps | 01: not on automatic retries. 04's S2/S11 assumed a bump. | Both: 01's rule. Rewrite S11. C-A: build "what changed" from `seenEventId`. C-B: from a `task_version` column on events. | **Adapted.** Took 01's rule plus operator commands. **`seenEventId` (C-A)**, because version arithmetic can't list retries that never bumped the version (§3.3, T8). |
| 14 | Whether `expectedVersion` is MUST | 02/03/04 said MUST. 01/05 said SHOULD. | C-A: MUST, since it's one column. | **Adopted.** |
| 15 | Operator pick: offer or direct assignment, and from which states | 05 said "Assign directly". Source states differed between sections. | C-A: always an offer, also allowed from `new`. Force-assign COULD. | **Adopted** (TT-11). Loom copy fixed. |
| 16 | Identifiers | INTEGER (01), `'T-104#2'` (02), prefixed random ids (04/05). | Both: INTEGER from 101, RNG keyed on (seed, taskId, seq). | **Adopted.** |
| 17 | Event names, actors and where wording lives | snake_case vs dotted names. Server-rendered vs client `eventSentence`. | Both: 01's catalogue, `summary` rendered by the server through `shared/event-copy.ts`. | **Adopted** (§3.9). |
| 18 | Sim tables and scenario catalogue | Four incompatible designs. | C-A: `sim_jobs` plus per-attempt parametric fates in `sim_scripts`, with named presets on top. C-B: `sim_jobs` plus `sim_task_scenarios(engine, contributor)`. | **Adopted C-B**, with named presets (§4.4). Exact timings for tests go through a test-only `h.script`. Demos use force-deliver. |
| 19 | API names and shapes | `/board`, `/desk` or `/snapshot`. Per-path commands vs a union. ISO vs epoch times. 409 vs 422 for capacity. | C-A: 04's shapes, epoch ms, capacity → 409, expertise → 422, policy carried in the snapshot. | **Adopted** (§6.5). Contributor responses live under `/sim/assignments/:id/respond`, because contributors are simulated here. |
| 20 | Reset and seed transactions vs the append-only triggers | 02's single-tx DELETE would trip the triggers. 01's savepoint seed conflicts with "no nesting". | C-A: reset by DROP, seed as sequential commands into a temp file and rename it. C-B: sequential commands, delete the file on failure. | **Adapted.** Reset by DROP is used for both the CLI and the endpoint, after **`PRAGMA foreign_keys=OFF`** (verified necessary because of the circular FKs). The seed runs as sequential commands. Invariants are checked afterwards and boot or reset fails loudly. No temp file. |
| 21 | UI while offline | Ages freeze (04) vs ages keep counting (02/03). | C-A: keep counting. Countdowns switch to absolute times, actions disabled. | **Adopted** (§4.9). |
| 22 | Priority of the policy panel and next-action countdown | 03: never cut. 05: cut at T+3:15. | C-A: both MUST. | **Adopted** (both are on the never-cut list). |
| 23 | Code layout, scripts and lint | 05 used top-level `server/` and `web/` with build/start/smoke scripts. 04 used `src/…`. | C-A: 04's layout, writes allowed in `store/`, `sim/` and `db.ts`, and either define build/start or drop them. C-B: drop smoke and build/start; the grep lint becomes COULD. | **Adopted.** 04's layout. Build/start/smoke dropped, `start:api` (no watch) added. The lint is replaced by `architecture.test.ts` (T16). |
| 24 | Colour for an overdue high-priority task | 01: red. 03: colour means status only. | C-A: amber for every priority; red only for needs_attention. | **Adopted** (§5.3). |
| 25 | Matching rule and default seed | Least-load with least-recently-offered (02) vs random (05). Seed 42 vs random. | C-A: 02's rule with reason strings, SEED=42. C-B: lowest load, then seeded random. | **Adapted.** Lowest load ratio, then a seeded tie-break, with a short reason string. SEED=42. |
| 26 | Seed data and field details | Three seeds. Title limit 140 vs 120. `brief` vs `description`. `acknowledgeExclusion` vs `overrideExclusion`. | Both: use 01's seed, trimmed. Separate fixtures for tests. | **Adopted** (§8: 8 contributors, raw seed MUST, replay seed SHOULD). Title 3–120, `brief`, `acknowledgeExclusion`. |
| 27 | Duplicate engine delivery | Counter (02), event on a different payload (04), drop (01). | C-B: written once, later deliveries dropped with a log line only. | **Adopted** (AT-08). |
| 28 | Timer rule in the never-do list | 05 allowed a timer in the engine sim. | C-B: only the tick interval in `main.ts`. | **Adopted.** |
| 29 | Reconciler cadence and an `attempt_overdue` event | 500 ms vs 1 s. 03 wanted an overdue event. | C-B: 500 ms plus a tick before every command. Overdue is computed only, never written. | **Adopted.** |

---

## 2. Gaps raised

| # | Critic | Gap | Severity | Verdict |
|---|---|---|---|---|
| G1 | A, B | **The combined MUSTs don't fit the build window.** 54k words of plans; planning already about 1 h in. | high | **Adopted.** One MoSCoW table (§2), schedule rebased on the real clock (§10), pre-cut lists, freeze gates. |
| G2 | A | **05's CLAUDE.md and prompts encode superseded choices** (restart A, random IDs, dotted events, layout, lint). | high | **Adopted.** CLAUDE.md regenerated with a glossary (§11.2). Section docs marked as superseded. |
| G3 | A, B | **The answer key leaks:** 05's prompt persisted the fate on the attempt row, and 03's sim box showed "scripted to: never answer". | high | **Adopted.** The fate lives only in `sim_jobs`. Presets are hidden after creation. The sim box offers only "Deliver now" and "Respond as". T16 grep test. |
| G4 | B | **Explainability:** a plan this large can't be defended, and "the agents decided". | high | **Adapted.** The candidate writes 8–10 decisions in their own words before freezing (§10). §0, §2 and §14 are the 10-minute read. The scope cut can be logged as C-1. C-B's "PLAN ≤3 pages" was **not adopted**, because the orchestrator asked for a thorough single source of truth. |
| G5 | B | **Deadline semantics conflicted** between processing time and `available_at`. | high | **Adapted.** One rule, see contradiction #3. |
| G6 | A | **Intervention coverage:** with only the MUSTs, offered or assigned tasks could only be cancelled. | medium | **Adopted.** `revoke_offer` and `release` are MUST. C-B's "revoke SHOULD" **not adopted**. |
| G7 | A, B | **Concurrent routing had no MUST test.** Capacity was disputed. | medium | **Adopted.** T10 (MUST) covers the capacity race and independent tasks. Capacity kept. |
| G8 | A | **Unstated assumptions:** the engine sees only eligible-now contributors, and the slow tail extends beyond 20 s. | medium | **Adopted** (§12.6, policy panel copy). |
| G9 | A | **The 409 "what changed" list misses retries** if it's keyed on version. | medium | **Adopted:** `seenEventId`. |
| G10 | A, B | **Loom timing:** real-time waits (20 s, 90 s, 60 s, downtime). | medium | **Adopted.** Presets, a pre-created unresolved task, force-deliver, a rehearsal (§12.4). |
| G11 | A | **Seed robustness:** a replay seed needs every command before the board shows anything. | medium | **Adopted.** Raw seed MUST in S2, replay SHOULD. |
| G12 | B | **Four overlapping test plans** with conflicting fixtures and expectations. | medium | **Adopted.** One list T1–T18 (§9.2) with its own fixtures. |
| G13 | B | **Reviewer runtime:** `node:sqlite` needs a recent Node, and `isTransaction` is newer still. | medium | **Adopted.** `engines`, `.nvmrc`, a boot guard, and a `tx()` depth counter instead of relying on `isTransaction`. |
| G14 | B | **Ceremony cost:** 6 sessions, tags, a lint, smoke tests, build/start. | medium | **Adopted.** 4 sessions, fresh-clone check is `npm ci && reset && check`, lint becomes a test. |
| G15 | A, B | **Transcript hygiene and config changes:** the email address and unrelated integration tool lists appear in transcripts; 05 proposed config changes. | medium | **Adopted.** Minimal JSONL-safe redaction (§11.5). Config is the candidate's decision (§14 #12). |
| G16 | A | **Restart dividers per task** need an in-flight list and heartbeat columns. | low | **Adopted.** One `desk_restarted` event plus `catchUp` tags is MUST. Per-task dividers are COULD. |
| G17 | A | **The S6 fresh-clone check relied on scripts that didn't exist.** | low | **Adopted.** Scripts dropped, and the check simplified. |
| G18 | A | **Multi-tab history said "You"** even for actions taken in the other tab. | low | **Adapted.** Operator events render as "Operator" at zero cost. A `tabId` is COULD. |
| G19 | A | **`tsx watch` and `concurrently -k`** can break the restart demo during the Loom. | low | **Adopted.** `start:api` and `dev:web` run in separate terminals. |
| G20 | A | **The email's assumptions contradicted the plan,** and it was unclear who sends it. | low | **Adopted.** Questions regenerated (§12.7). The candidate sends them personally. |
| G21 | B | **Red bucket semantics:** operator-initiated holds were shown in red. | low | **Adapted.** Stop routing is cut to COULD. `offer_revoked` stays in needs_attention (nothing happens automatically, which is accurate) and is labelled "(by operator)". |
| G22 | B | **Likely Loom pushback is unprepared,** for example "why ignore a valid late answer?" | low | **Adopted.** Q&A prep (§12.8). Adopting a late answer within the same round is next step #1. |
| G23 | B | **UX density:** engine tile, alert line, activity feed, telemetry. | low | **Adopted.** Those are cut to COULD. |

---

## 3. Additions proposed

| Critic | Addition | Verdict |
|---|---|---|
| A | A canonical glossary table | **Adopted** (§3.2, copied into CLAUDE.md) |
| A | A "Brief → where it lives" table in the README | **Adopted** (§12.1 item 3) |
| A | `shared/policy.ts` as the single source of numbers, plus a test | **Adopted** (§4.11, T17) |
| A | `seenEventId` for the 409 changes list | **Adopted** |
| A | Server-rendered summaries via `shared/event-copy.ts` | **Adopted** |
| A | `tabId` on operator requests | **Not adopted** (COULD). The "Operator" label solves it at no cost. |
| A, B | A test that no desk table holds the sim fate | **Adopted** (T16) |
| A | A Loom recording checklist: no watch mode, laptop awake, reset, SEED=42 | **Adopted** (§12.4 setup) |
| A | Node-version boot guard, `.nvmrc`, `engines` | **Adopted** |
| A | A DECISIONS note on why Overdue is 20 s for every priority while deadlines vary | **Adopted** (§12.2 item 6) |
| B | A short PLAN.md of 3 pages or less | **Not adopted.** A thorough plan was requested. §0, §2 and §14 serve as the short read. |
| B | "Deliver answer now" MUST, "Expire offer now" SHOULD | **Adapted.** Deliver is MUST. Expire-now is COULD, because it would let simulation touch a desk deadline, and the `ignore` preset covers the case. |
| B | Hide the scripted fate in the operator UI | **Adopted** |
| B | A 3-command reviewer quickstart | **Adopted** (§12.1) |
| B | One mutation spot-check per core session | **Adopted** (§9.3) |
| B | An honest time log in SESSIONS.md | **Adopted** (§11.4) |
| B | A 6-question Q&A prep sheet | **Adopted** (§12.8) |
| B | A decisions table linking file:line to the proving test | **Adopted** (§12.1 item 6) |
| B | Unit tests for `nextAutomaticAction` and `allowedCommands` | **Adopted** (T17) |
| B | Log the planning-stage scope cut in CORRECTIONS.md if it really happens | **Adopted** (§11.3, candidate's call) |

---

## 4. Proposed scope cuts

| Critic | Cut | Verdict |
|---|---|---|
| A, B | Changing priority after creation | **Adopted** (WON'T) |
| A, B | "Retry now" separate from Route again | **Adopted** |
| A, B | Force-assign, reassign composites, operator mark-complete, keep waiting +30 s | **Adopted** (COULD) |
| A, B | Triggers for I5 and I9 | **Adopted** (COULD). The append-only events trigger stays SHOULD. |
| A, B | Per-task restart dividers, `inFlightAtStop` | **Adopted** (COULD) |
| A, B | Engine tile, alert line, progress bars, activity feed, keyboard shortcuts, path compression, offers table | **Adopted** (COULD) |
| B | Mini attempt timeline to COULD | **Adapted.** It stays SHOULD as the first UI SHOULD to build, and is safe to cut because the text list and ghost entries are MUST. |
| A | In-dialog pre-warning on a version change | **Adopted** (COULD; not built) |
| A | Late-answer "Offer to X" button as SHOULD, ghost entry MUST | **Adopted** |
| A, B | Idempotent create | **Adopted** (COULD; buttons are disabled while in flight) |
| A, B | Full fast-check fuzz | **Adopted.** A seeded 300-step random walk is COULD. |
| A, B | Duplicate and invalid presets, editable knobs, personas | **Adopted** (COULD or dropped) |
| A, B | inspect, debug/invariants, events feed, webhook, CI | **Adopted** (COULD) |
| A, B | Replay seed as SHOULD, after the raw seed | **Adopted** |
| A, B | Standalone "Add note" | **Adopted.** Notes go on actions only. |
| B | Reason strings with least-recently-offered, an 8-value disposition taxonomy, dead-letter queue | **Adopted** |
| B | Effect system, separate `/api/policy`, `dbHash` assertions, pretty TTY logger | **Adopted** (dropped). Kept: the snapshot contract test. |
| B | Per-TT-row tests replaced by about 12 use-case tests | **Adopted** (T1–T18) |
| B | `closed_processed_at`, `lateByMs`, catchUp flags, 5 s heartbeat | **Adapted.** `closed_processed_at` and `lateByMs` dropped; the UI derives lateness from `event.at − payload.deadlineAt`. The `catchUp` flag is **kept**, because it's one context boolean and the restart story depends on it. |
| B | `check:invariants` grep lint, smoke script, build/start, worktree session, per-checkpoint tags | **Adopted.** Tags are kept, since they're free. |
| B | Persisted settings and `schema_version` tables | **Adopted.** POLICY is code constants. `meta` is a single key/value table. |

---

## 5. Open decisions the critics raised (all are in PLAN §14)

| Question | C-A | C-B | PLAN recommendation |
|---|---|---|---|
| Capacity | keep | keep | keep (#1) |
| Slow tail | yes, disclosed | — | yes, disclosed (#2) |
| Retry budget | — | 2 | 2 (#3) |
| Restart model | — | B | B (#4) |
| Loom centrepiece | intervention + late answer | — | intervention + late answer (#5) |
| Late answer within the same round | — | strict + advice | strict + advice (#6) |
| Contributor simulation | — | buttons + presets | buttons + presets (#7) |
| Board at boot | — | replay with needs_attention | raw MUST, replay SHOULD (#8) |
| Stop routing | — | COULD | COULD (#9) |
| Clarifying email | send, personally | send 3 | send 3, personally (#10) |
| Exports location | private repo or separate link | — | private repo, or public after reading (#11) |
| Config / allowlist / MCP | candidate's choice | candidate's choice | candidate's choice, not an agent's (#12) |
| SHOULD scope and schedule | rebase on real T0, pre-cut | freeze now, short plan | rebased §10 with clock gates (#13) |
| Deadline rule | `available_at` | processing time | `available_at` for engine answers, processing time for contributors (decided in §0 #6; listed in the summary as the one critic disagreement settled by judgement) |

---

## 6. Top risks the critics named (merged into PLAN §13)

C-A: overrun · spec drift into the agent · deadline semantics · leaking the answer key · version-bump semantics · tooling · Loom timing · transcript privacy.
C-B: overscope · unresolved contradictions · time-logic bugs · explainability · tooling · UI estimate too low · demo non-determinism · redaction · fuzz rabbit hole · ceremony crowding out the product.

All of them are covered by PLAN §13 rows 1–10. "Fuzz rabbit hole" is handled by demoting the fuzz to a COULD random walk. "Ceremony" is handled by cutting to 4 sessions with lighter tooling.

---

## 7. Traceability

Both critics' requirement matrices were merged into **PLAN Appendix A**. Every brief requirement maps to a section and a test or demo beat. The items they marked partial are now covered:

- contributors list → MUST
- intervention in an assignment → revoke and release MUST
- concurrent routing → T10
- "make choices visible" → policy panel never cut
- honest uncertainty → fate hidden, T16
- seed → one seed
- documentation of assumptions → §12.6
