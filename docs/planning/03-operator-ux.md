# 03 — Operator UX

> **SUPERSEDED — input only.** This is a pre-synthesis dimension draft. Where it disagrees with `PLAN.md` (statuses, restart model, API shapes, numbers, CLAUDE.md text), `PLAN.md` wins. Do not implement from this file.

> Dimension: **Operator UX**, the operator-facing product. It covers information architecture, screens, interactions, microcopy and visual direction.
> Interacts with **Domain & State** (statuses, reason codes, events, exclusions), **Engine, Time & Concurrency** (deadlines, fencing, sim scenarios, restart model), **Architecture & Verification** (API shape, polling, tests), and **Delivery & Agentic Process** (Loom script, time budget).
> Tags: **[MUST] / [SHOULD] / [COULD] / [WON'T]** apply to the 5-hour total budget. Divergences from the baseline are marked **FLAG-n** and collected in §15.

---

## 0. TL;DR

- **One screen: "the desk."** A summary strip runs across the top. A triage-ordered task queue fills the left side, with contributors and activity on the right. Selecting a task opens a **non-modal drawer** from the right. A violet **Simulation** dock is pinned to the bottom.
- **Every task answers two questions in plain words:** *what is going on*, and *what will happen next, and when*. The second answer is a countdown computed by the server. **No automatic action happens unless its countdown was on screen first.**
- **We are honest about uncertainty.** Past 20s the copy reads: *"No answer for 27s. The engine may be slow or the request may be lost — we can't tell from here."* The UI never uses the words "stuck" or "failed" for a pending request.
- **Late engine answers show up as ghost entries.** Example: *"Late answer ignored — it suggested Marco Ruiz. You had already offered the task to Ana Lima at 0:22."* They are recorded and drawn on a mini attempt timeline. They are never applied and never shown as a toast.
- **Human outcomes stop and ask.** After a decline, an expiry or an assignment that fell through, a recovery panel shows what happened, who is now excluded, who is still eligible (with their load), one recommended action, and *what the system will not do on its own*.
- **Simulation is kept apart.** *Anything violet with a striped header stands in for the outside world* (the engine and the contributors). Operator controls are never violet.
- **Conflicts get an explanation, never a silent fix.** On a 409 the drawer shows *"This task changed while you were looking:"*, lists the events since your version, and says that your action was not applied.
- **Disconnects and restarts are first-class states.** A banner appears, countdowns switch to absolute due times, and actions pause. After a restart, a toast says which deadlines were enforced at startup, and a marker appears in every affected timeline.
- **UI budget is about 1h30.** MUST is about 75 minutes and SHOULD is done only if MUST is finished by 1h15. The cut order is in §10.4.

---

## 1. Principles (what every screen is checked against)

| # | Principle | What it means in practice |
|---|---|---|
| P1 | **Triage first** | The first row of the queue is always the thing that most needs a human. A "Needs attention" group always sits at the top, even when it is empty. |
| P2 | **Say what we know and what we don't** | We show elapsed time against the expected 5–20s window. We do not guess at the cause. "Overdue" never means "failed". |
| P3 | **No surprises** | Each automatic action (retry, escalation, expiry) appears as a countdown *before* it happens and as a history event *after*. |
| P4 | **The operator wins races, and the record keeps everything** | The first terminal transition wins. Anything that arrives later is recorded and visible, but never applied. |
| P5 | **Simulation is visibly fake** | Violet, stripes and the label "SIMULATION" mark it. Simulated actions carry a SIM chip in history. |
| P6 | **Calm density** | Colour means status and nothing else. Priority is shown with shape and weight. Nothing blinks, and nothing moves except countdown digits. |

---

## 2. Brief capabilities mapped to UI

| Brief: "The product should let an operator…" | Where it lives | MUST pieces |
|---|---|---|
| **See tasks with their time since created, contributors, and the current state of the operation** | Summary strip (counts by state, overdue and high-priority alerts, engine health, live indicator, last restart), queue (**Age** column, status line naming the contributor, **Next** column), contributors panel | Strip with clickable counts. Queue with Age, Status + who, and Next. A basic contributors list (expertise, availability, active load). |
| **Create a task and submit it for assignment** | `+ New task` (shortcut **N**) opens a dialog with **Create & route** (primary) and **Save as draft** (secondary) | Title, expertise and priority fields; a live eligible-contributor count with a warning at zero; per-task simulation scenario (violet, collapsed). |
| **Intervene in an assignment whenever they want** | A state-aware action bar in the drawer: **Offer to someone…**, **Re-route now**, **Stop routing**, **Withdraw offer**, **Release assignment…**, **Cancel task**, **Add note** | The action matrix (§6.1). The offer dialog explains what happens to a pending engine request. A 409 banner. |
| **Recover a task from an assignment that failed or was declined** | Recovery panel in the drawer when the task needs attention | What happened, who is excluded, who is still eligible (with load), the recommended action, other actions, and "what we won't do automatically". |
| **Inspect enough history to understand what happened** | Drawer: attempt list plus a mini attempt timeline, and a full history with actor icons, ghost entries for late answers and restart markers. A global activity feed on the side. | Attempt list and history with ghost styling (MUST). Mini timeline and activity feed (SHOULD). |

---

## 3. Information architecture

### 3.1 Layout (desktop ≥ 1280px. Mobile is out of scope; see §16)

```
+--------------------------------------------------------------------------------------------------------------+
| TERAC ROUTING DESK     ● Live · up since 14:40:12 (restarted 6m ago)      [? How this desk behaves] [+ New task N] |
+--------------------------------------------------------------------------------------------------------------+
| NEEDS ATTENTION | ROUTING          | OFFERED         | ASSIGNED/WORKING | DONE  | ENGINE · last 20 requests       |
|  2   (▲ 1 high) |  4   (1 overdue) |  1   next 0:41  |  3               |  6    | 15 answered (median 11s)        |
|                 |                  |                 |                  |       | 4 unanswered · 1 late · 1 pending|
+--------------------------------------------------------------------------------------------------------------+
| ▲ HIGH  T-107 Adverse event signal review — no engine answer for 27s · auto-retry in 0:03          [Open]    |
+------------------------------------------------------------------------------+-------------------------------+
| [All 16] [Needs attention 2] [Routing 4] [Offered 1] [Working 3] [Done 6]    | CONTRIBUTORS · 6              |
| Expertise [Any ▾]   Priority [Any ▾]                                         | Priya Shah        ● Available |
|                                                                              |  Healthcare · Data  1 active  |
| NEEDS ATTENTION · 2                                                          | Marco Ruiz        ● Available |
|  ▲  Adverse event signal review     NEEDS ATTENTION     Waiting for you  6m  |  Operations · Hlth  0 active  |
|     T-104 · Healthcare              Engine didn't answer (3 tries)           | Dev Kapoor        ● Available |
|  –  Hospital claims cost analysis   NEEDS ATTENTION     Waiting for you  4m  |  Finance · Data  1 decline    |
|     T-112 · Finance                 Declined by Dev Kapoor                   | Ana Lima          ● Available |
|                                                                              |  Finance · Ops      2 active  |
| IN FLIGHT · 3                                                                | Lena Fischer      ● Available |
|  ▲  Adverse event signal review 2   OVERDUE             Retry in 0:03    1m  | Sam Okafor        ○ Away       |
|     T-107 · Healthcare              No answer 27s · try 1/3  [#####////|  ]  +-------------------------------+
|  –  Clinic staffing model           ROUTING             Overdue in 0:12  8s  | ACTIVITY                      |
|     T-109 · Operations              Waiting 8s · try 1/3     [###      |  ]  | 14:41:22 T-107 no answer in   |
|  –  Q3 revenue variance review      OFFERED             Expires in 0:41 31s  |   the usual 20s               |
|     T-111 · Finance                 Offered to Lena Fischer (engine #1)      | 14:41:15 T-111 offered to     |
|                                                                              |   Lena Fischer (engine #1)    |
| ASSIGNED & WORKING · 3                                              [▾]      | 14:41:09 T-109 attempt #1 sent|
| DRAFTS · 1                                                          [▾]      | 14:40:51 T-098 late answer    |
| SETTLED · 6                                                         [▸]      |   ignored (Priya Shah)        |
|                                                                              | ── server restarted 14:40:12 ─|
+------------------------------------------------------------------------------+-------------------------------+
| ▨▨▨ SIMULATION — stands in for the engine and contributors. Not operator controls.            [Expand ▴] ▨▨▨ |
+--------------------------------------------------------------------------------------------------------------+
```

When a task is selected, the **drawer** (560px wide) slides in from the right. It covers the contributors and activity column plus a slice of the queue. It has **no backdrop**, so the queue stays live and clickable, and clicking another row switches the drawer to that task. **[MUST]**

URL state: `/?task=T-107&filter=attention`. A browser refresh or a server restart puts the operator back where they were. **[SHOULD]** (about 5 minutes of work)

### 3.2 Top bar **[MUST]**

- Product name, then the **live indicator**:
  - `● Live`: emerald. The last successful poll was under 3s ago. Tooltip: "Synced 0.4s ago".
  - `◐ Reconnecting…`: amber. One or two polls in a row have failed. No banner yet.
  - `○ Offline since 14:39:54`: rose. Three or more polls have failed, or more than 3s has passed without a successful one. This triggers the disconnected banner (§9.3).
- `up since 14:40:12 (restarted 6m ago)` comes from `serverStartedAt`. "(restarted …)" appears only if the desk has seen more than one boot.
- `? How this desk behaves` opens the policy panel (§3.7). `+ New task` opens the create dialog (§8).

### 3.3 Summary strip **[MUST]**, engine tile **[SHOULD]**, alert line **[SHOULD]**

| Tile | Big number | Sub-line | Click |
|---|---|---|---|
| Needs attention (rose number when > 0) | count | `▲ 1 high` when any are high priority | filters the queue to that group |
| Routing | count | `1 overdue` in amber when any attempt is past 20s | filter |
| Offered | count | `next 0:41`: the soonest offer expiry | filter |
| Assigned / working | count of assigned + in_progress | none | filter |
| Done | completed + cancelled since the desk started | none | filter |
| **Engine · last 20 requests** | none | `15 answered (median 11s)` / `4 unanswered · 1 late · 1 pending` | no filter; tooltip explains the counts |

Engine tile, degraded state: when 3 or more requests in a row went unanswered, the tile turns amber and reads *"3 requests in a row unanswered — the engine may be degraded."* It says "may". We are reporting what we observe, not making a diagnosis. The server computes these numbers (FLAG-11).

Alert line (one row, at most 3 items, then "+2 more"): this shows **high-priority** tasks that are overdue or need attention. Copy: `▲ HIGH  T-107 Adverse event signal review — no engine answer for 27s · auto-retry in 0:03  [Open]`. If it gets cut, the `▲ 1 high` sub-line on the tiles stays.

### 3.4 Task queue **[MUST]**

**Columns** (dense rows of about 44px, each with a title line and a detail line):

| Column | Line 1 | Line 2 |
|---|---|---|
| Pri | `▲` High (bold) · `–` Normal · `▽` Low (muted). **No colour.** | none |
| Task | Title, truncated with a tooltip | `T-107 · Healthcare` (ID in mono) |
| Status | Status badge (§4.1) | Detail line: who and what, e.g. `Offered to Lena Fischer (engine #1)`, `No answer 27s · try 1/3` |
| Next | The next **automatic** action and its countdown: `Retry in 0:03`, `Expires in 0:41`, `Overdue in 0:12`, or `Waiting for you` (rose text), or `—` | Optional row progress bar while routing **[SHOULD]** |
| Age | Time since created: `8s`, `3m`, `1h 4m`. Tooltip shows the absolute time. | none |

**Groups**, in this order. Each group can collapse, and empty groups are hidden except the first:

1. **Needs attention.** It is always shown. When empty it reads *"Nothing needs you right now."*
2. **In flight.** Routing and offered tasks. The system or a contributor owes us an answer.
3. **Assigned & working.** Assigned and in progress.
4. **Drafts.**
5. **Settled.** Completed and cancelled. Collapsed by default.

**Sort within a group** (triage order, and stable so rows don't jump every second):

- Needs attention: priority (high first), then the time it entered needs-attention (oldest first).
- In flight: overdue routing first (longest overdue first), then offers by soonest expiry, then routing within the window by soonest overdue. Ties break by `created_at`, then `id`.
- Others: priority, then newest first.
- *Rows change position only when their status band changes* (for example, within window → overdue). They never re-sort on every tick.

**Filters:** clicking a summary tile is the main filter **[MUST]**. Expertise and priority dropdowns **[SHOULD]**. Text search on `/` **[COULD]**.

**Row progress bar** (routing rows only) **[SHOULD]**: `[#####////|  ]`. A sky fill runs from 0 to 20s and an amber hatch shows the overdue part. The `|` tick marks the attempt timeout for this priority. It is aria-hidden because the detail line says the same thing in text.

### 3.5 Task drawer **[MUST]** (wireframes in §5)

From top to bottom:

1. **Header.** `T-107 · Adverse event signal review`, priority, expertise, `created 1m 12s ago (14:31:02)`, and a close button (Esc).
2. **Status hero.** A large badge, a one-sentence explanation (§4.1), and the attempt counter when routing (`attempt 1 of 3`).
3. **"What happens next" box.** Always present. It comes from the server's `nextAutomaticAction` (FLAG-7). It holds either a countdown and consequence, or *"Nothing automatic. This task waits for you."* (§4.2).
4. **Conflict banner** (only after a 409, §4.5).
5. **Recovery panel** (only in needs-attention, §7), or the **action bar** (§6) for every other state. The recommended action is the one dark primary button.
6. **Attempts.** A text list **[MUST]** plus the mini attempt timeline **[SHOULD]** (§5.1). The timeline makes a late return after an intervention obvious at a glance.
7. **Offers / assignments.** These appear inline in history as typed events. A separate table is **[COULD]**: contributor, source (`engine #1` / `you`), offered at, outcome, response time.
8. **History.** Every event, oldest first so it reads like a story, auto-scrolled to the bottom. Each entry has an actor icon, a time and a sentence (§4.4). Late and ignored entries use the ghost style. Restart markers appear as full-width dividers.
9. **Simulation box.** Violet, dashed border, at the bottom: "Respond as Lena Fischer: Accept / Decline… / Withdraw before start", and "Make attempt #1 answer now: match ▾ / no match" (§3.8).

Detail data is fetched with `GET /api/tasks/:id` and polled every second while the drawer is open.

### 3.6 Contributors panel (basic **[MUST]**, details **[SHOULD]**)

Each row shows the name, availability (`● Available` / `○ Away`), expertise chips, and **load**: `1 active` counts offers out plus accepted and in-progress work. SHOULD adds `1 decline today`, and hovering shows that contributor's current tasks. Clicking a contributor filters the queue to their tasks **[COULD]**.
The operator can't edit availability here. Availability is the contributor's own statement, so it is changed in Simulation (FLAG-14).

### 3.7 "How this desk behaves" policy panel **[MUST]**

This is a slide-over from the top bar. Every number in it is read from `GET /api/policy`, so the copy can never drift from what the code does. The text:

> **How this desk behaves**
>
> **Routing.** When you route a task, we send the engine the task and every *available* contributor with matching expertise. If nobody matches, we don't call the engine; the task comes straight to you.
>
> **Waiting.** The engine usually answers in **5–20s**. Some requests never answer, and nothing tells us which ones. After **20s** we mark the request **Overdue**. That's a label, not a verdict — nothing changes yet.
>
> **Retrying.** If there's still no answer at **30s (High) / 45s (Normal) / 60s (Low)**, we stop waiting and send a fresh request — up to **2 retries** (3 attempts). After that the task comes to you. You'll always see the countdown before it happens.
>
> **You can step in at any time.** Offer, re-route, stop or cancel whenever you like. Your action wins.
>
> **Late answers.** If an engine request answers after we've moved on (you acted, it timed out, or the task was cancelled), we record what it suggested in the history but **never apply it**.
>
> **People, not timeouts, need you.** When a contributor declines, doesn't reply within **60s** (compressed for this demo; in production think hours), or drops out before starting, we **don't** re-route automatically — the task comes to you, and that person is excluded from engine routing for this task. You can still offer it to them yourself.
>
> **One assignee.** A task has at most one active offer or assignee. Once someone accepts, routing is done.
>
> **Restarts.** Every deadline is saved. If the server stops, anything that came due while it was down is enforced the moment it starts again, and the history shows the gap.
>
> **Conflicts.** If a task changes while you're deciding, your action is not applied; we show you what changed.

### 3.8 Simulation: dock **[MUST]**, per-task box **[MUST]**, extras **[COULD]**

The visual quarantine works like this. The `violet-600` accent is used **only** here. The header has a diagonal stripe (`repeating-linear-gradient`), borders are dashed `violet-300`, and a flask icon sits next to the label **"SIMULATION — stands in for the engine and contributors. Not operator controls."** Events caused by a simulation control (a forced engine answer, a manual "respond as contributor") show a small violet `SIM` chip in history.

**Bottom dock** (collapsed to a 32px bar; expands to about 200px):

```
▨▨ SIMULATION — stands in for the engine and contributors. Not operator controls. ▨▨▨▨▨▨▨▨▨▨▨▨ [Collapse ▾]
 ENGINE                          CONTRIBUTORS                                     DEMO
 Never-return rate  [20% ▾]      Auto-respond  [● on]                             [Reset demo data…]
   0% · 20% · 50% · 100% (outage)  accept 70% · decline 20% · no reply 10%        [Route 4 tasks at once] (COULD)
 Latency 5–20s (fixed)            replies after 3–12s                             [Skip ahead 10s] (COULD, FLAG-16)
                                  Availability: Priya ● Marco ● Dev ● Ana ● Lena ● Sam ○
```

- **[MUST]**: Reset demo data (with confirm: *"Delete all tasks and history and reload the seed? This can't be undone."*), the auto-respond toggle, the never-return rate, and the availability toggles.
- **[COULD]**: "Route 4 tasks at once" (a concurrency demo), "Skip ahead 10s" (time warp; only if Engine uses an offset clock for both the simulated engine and the reconciler).
- **[WON'T]**: a "restart server" button. A restart is shown in the terminal with Ctrl+C and `npm run dev`, which is more convincing on the Loom anyway.

**Per-task simulation box** in the drawer:

- When a task is offered: `Respond as Lena Fischer: [Accept] [Decline…] (asks for an optional reason)`.
- When assigned: `[Start work as Lena]` `[Lena withdraws before starting…]`.
- When in progress: `[Mark complete as Lena]`.
- For any **unresolved attempt**, including one that was superseded or timed out: `Attempt #1 is scripted to: never answer. [Make it answer now: Lena Fischer ▾] [Make it answer: no match]`. **This is how a late return is demoed on cue**, with no waiting (FLAG-10).

---

## 4. Status vocabulary, colours and microcopy

### 4.1 Status badges **[MUST]**

User-facing labels differ from internal names where that reads better (FLAG-1). "Overdue" is a **display sub-state** of `routing`. It is derived from the current attempt's dispatch time and never stored.

| Internal | Badge | Colour (Tailwind) | Queue detail line | Drawer hero sentence |
|---|---|---|---|---|
| `new` | DRAFT | zinc-600 on zinc-100 | `Not submitted · 3 eligible` | "Not routed yet. Nothing happens until you route it." |
| `routing` (≤ 20s) | ROUTING | sky-800 on sky-50 | `Waiting 8s · try 1/3` | "Waiting for the engine (8s). It usually answers in 5–20s." |
| `routing` (> 20s) | OVERDUE | amber-900 on amber-50, amber-400 left rule | `No answer 27s · try 1/3` | "**No answer for 27s.** The engine may be slow or the request may be lost — we can't tell from here." |
| `routing` (attempt ≥ 2, ≤ 20s) | ROUTING | sky | `Retry 2/3 · 4s` | "Retrying. Attempt #1 got no answer in 30s; attempt #2 was sent 4s ago." |
| `awaiting_response` | OFFERED | teal-800 on teal-50 | `Offered to Lena Fischer (engine #1)` or `(by you)` | "Offered to Lena Fischer 18s ago, chosen by engine attempt #1. Waiting for a reply." |
| `assigned` | ASSIGNED | emerald-800 on emerald-50 | `Lena Fischer accepted · not started` | "Lena Fischer accepted 1m ago. Routing is complete. Work hasn't started." |
| `in_progress` | IN PROGRESS | white on emerald-700 | `Lena Fischer · working 3m` | "Lena Fischer started work 3m ago." |
| `completed` | DONE | zinc-700 on zinc-100 with a check icon | `Completed by Lena Fischer` | "Completed by Lena Fischer at 14:52." |
| `needs_attention` | NEEDS ATTENTION | rose-800 on rose-50 | short reason (§4.3) | reason title (§4.3) |
| `cancelled` | CANCELLED | zinc-500 on zinc-50 | `Cancelled by you · "Duplicate"` | "Cancelled by you at 14:50: 'Duplicate.'" |
| *(history only)* late or ignored | IGNORED | zinc-400 text, dashed zinc-300 border, italic | none | none |
| *(simulation only)* | SIM | violet-700 on violet-50 | none | none |

Contributors are never referred to with pronouns. Copy always uses their name.

### 4.2 "What happens next" copy **[MUST]**

Times are shown both ways: absolute (`14:31:32`) and relative (`in 0:24`). Countdowns use `m:ss` with tabular numerals.

| Situation | Copy |
|---|---|
| Draft | "Nothing automatic. Route it when you're ready." |
| Routing, retries remain | "**Retry in 0:24** (at 14:31:32). If attempt #1 hasn't answered by then, we'll send attempt #2 of 3." + muted "You don't have to wait — offer it or re-route now." |
| Routing, last attempt | "**Comes to you in 0:24** (at 14:32:32). This is attempt 3 of 3; if it doesn't answer, we stop retrying and the task will need you." |
| Offered | "**Offer expires in 0:41** (at 14:42:30). If Lena Fischer doesn't reply by then, the task comes to you." |
| Assigned | "Nothing automatic. Waiting for Lena Fischer to start." |
| In progress | "Nothing automatic. Lena Fischer is working on it." |
| Needs attention | "**Nothing automatic. This task waits for you.**" (and the recovery panel's "won't do" line) |
| Done / cancelled | "Closed. If an engine request answers late, we'll record it and not apply it." |
| Countdown reached 0, server has not applied it yet (≤ 3s) | "Due now — applying…". The countdown never shows a negative number. |
| Still unapplied more than 5s after the due time while Live | "Due 6s ago — the server hasn't applied this yet." This is an honest bug signal and should never show up in the demo. |
| Disconnected | "Due at 14:31:32 (we're offline; it'll be enforced when the server is back)." |

### 4.3 Needs-attention reasons **[MUST]** (codes owned by Domain & State)

| Code | Queue detail | Drawer title | Drawer body (example) | Recommended | Also offered |
|---|---|---|---|---|---|
| `no_eligible_contributors` | `No one covers Legal` | **No available contributor covers Legal** | "We didn't call the engine. It can only choose among available contributors with Legal expertise, and right now there are none." | Cancel task. Simulation hint: "Make someone available, then re-route." | Re-route (enabled once someone is eligible) |
| `no_match` | `Engine found no match` | **The engine found no match** | "Attempt #2 answered after 9s: none of the 3 eligible contributors was a match. We don't retry a definite 'no match' automatically." | **Offer to someone…** | Re-route, Cancel |
| `routing_exhausted` | `Engine didn't answer (3 tries)` | **The engine didn't answer 3 requests** | "Attempts #1–#3 each got no answer within 30s. They may still answer late; if they do, we'll record it and not apply it. We've stopped retrying." | **Offer to someone…** (least-loaded preselected) | Re-route (a new round of 3), Cancel |
| `declined` | `Declined by Dev Kapoor` | **Dev Kapoor declined** | "Offered by engine attempt #1 at 14:36:06; declined 34s later: 'At capacity this week.' Dev is now excluded from engine routing for this task." | **Re-route with engine (excludes Dev)** | Offer to someone…, Cancel |
| `offer_expired` | `Lena Fischer didn't reply` | **The offer to Lena Fischer expired** | "No reply within 60s of 14:41:30. Lena is excluded from engine routing for this task; you can still offer it to Lena yourself." | **Re-route with engine** | Offer…, Cancel |
| `failed_before_start` | `Fell through before start` | **Lena Fischer's assignment fell through before work started** | "Lena accepted at 14:42:01. At 14:44:10 you released it: 'Contributor unreachable.'" (or "…Lena withdrew: 'Family emergency.'") "Lena is excluded from engine routing for this task." | **Re-route with engine** | Offer…, Cancel |
| `invalid_engine_result` | `Engine's pick wasn't usable` | **The engine's answer couldn't be used** | "Attempt #1 chose Sam Okafor, who was marked Away at 14:39, after the request was sent. We didn't apply it." | **Re-route** | Offer…, Cancel |
| `routing_stopped` | `Routing stopped by you` | **You stopped routing** | "Stopped at 14:35:12 — 'Waiting on client scope.' If the pending request answers, we'll record it and not apply it." | **Offer to someone…** | Re-route, Cancel |
| `offer_withdrawn` *(FLAG-2)* | `Offer withdrawn by you` | **You withdrew the offer to Lena Fischer** | "Withdrawn at 14:42:15 — 'Client changed scope.' Lena is not excluded." | **Offer to someone…** | Re-route, Cancel |

If **every** eligible contributor is excluded, the recommended action becomes: *"Everyone with Finance has declined, expired or is away. Offer it to an excluded contributor anyway, or cancel."*

### 4.4 History entries **[MUST]** (event names are owned by Domain & State; this is the rendering)

Actor icons come from lucide: **You** (`User`), **Engine** (`Cpu`), **System** (`Clock`, for the desk's own timers), **Contributor** (`UserRound`, with the name), **Simulation** (`FlaskConical`, violet), **Server** (`Power`).

| Event | Actor | Rendered sentence |
|---|---|---|
| task created | You | "Created task · High · Healthcare" (+ "· saved as draft") |
| routing submitted | You | "Routed · 3 eligible: Priya Shah, Marco Ruiz (Sam Okafor is away)" |
| no eligible | System | "No available contributor covers Legal — engine not called" |
| attempt dispatched | System | "Sent engine attempt #1 · times out at 14:31:32 if unanswered" |
| attempt overdue *(FLAG-13)* | System | "Attempt #1: no answer in the usual 20s" |
| attempt timed out | System | "Attempt #1 timed out after 30s with no answer · retrying (2 of 3)" |
| attempt matched (applied) | Engine | "Attempt #2 answered after 7.2s: **Marco Ruiz**" |
| attempt no match | Engine | "Attempt #2 answered after 9.1s: no match among 3 eligible" |
| attempt superseded | You | "Stopped waiting for attempt #1 (you offered manually). If it answers, we'll record it and not apply it." |
| **late answer ignored** | Engine (ghost) | "*Late answer ignored.* Attempt #1 answered after 40s and suggested **Marco Ruiz**. **Not applied:** you had already offered the task to Ana Lima at 14:31:24." Variants for the "Not applied" clause: "…it had already timed out and attempt #2 replaced it", "…the task was cancelled", "…you stopped routing", "…the task had been re-routed". |
| offer created | Engine or You | "Offered to Lena Fischer (chosen by attempt #1) · expires 14:42:30" / "You offered it to Ana Lima — 'Client asked for Ana' · expires …" |
| accepted | Contributor | "Lena Fischer accepted after 12s · routing complete" |
| declined | Contributor | "Dev Kapoor declined: 'At capacity this week.'" |
| expired | System | "Offer to Lena Fischer expired (no reply in 60s)" |
| withdrawn | You | "You withdrew the offer to Lena Fischer — 'Client changed scope'" |
| started / completed | Contributor | "Lena Fischer started work" / "Lena Fischer completed the task" |
| released / fell through | You or Contributor | "You released Lena Fischer's assignment before work started — 'Contributor unreachable'" |
| response rejected | Contributor (ghost) | "*Not applied:* Lena Fischer tried to accept at 14:42:33, but the offer had expired at 14:42:30." |
| invalid result | Engine | "Attempt #1 chose Sam Okafor, who is no longer eligible (Away since 14:39) — not applied" |
| needs attention | System | merged into the event that caused it, as a `→ Needs attention: Declined` suffix chip |
| note | You | "Note: 'Client prefers someone with payer experience.'" |
| cancelled | You | "Cancelled — 'Duplicate of T-101'" |
| **restart marker** | Server | full-width divider: `──── Server offline 14:39:54 → 14:40:12 (~18s) · deadlines enforced at startup ────` |
| deadline enforced at boot | System | "Attempt #2 timed out while the server was offline (deadline 14:40:01) · enforced at startup · retrying (3 of 3)" |

The ghost style uses a dashed left border, zinc-400 text, an italic lead-in and a `Ignored` chip, so it is **visible without looking like something happened to the task**. A ghost entry gets a link-style button **[COULD]**: `Use this suggestion →`. It opens the offer dialog with that contributor preselected. The answer is recorded but not applied, and the operator can still act on it.

### 4.5 Conflict, disconnect and restart copy **[MUST]**

**409 conflict.** This appears inline at the top of the drawer, or inside the open dialog. It is never a toast, because toasts disappear.

```
┌ This task changed while you were looking ─────────────────────────────────┐
│ 14:41:30  Engine attempt #1 answered: Lena Fischer                         │
│ 14:41:30  Offered to Lena Fischer · expires 14:42:30                       │
│ Your offer to Ana Lima was not sent.                    [Review latest]    │
└────────────────────────────────────────────────────────────────────────────┘
```
The banner is built from the server's `changesSince` events (FLAG-9). We **never retry the action automatically**. "Review latest" refreshes the drawer and keeps the operator's note text.

**Dialog pre-warning** **[SHOULD]**: while a dialog is open, polling continues. If the task's version changes, an amber line appears inside the dialog before submit: *"Heads up — this task just changed: it's now offered to Lena Fischer. Sending will fail; close and review."*

**Disconnected banner** (rose, sits below the top bar):
> **Can't reach the desk server since 14:39:54 (18s).** Showing the last known state; countdowns are replaced with due times. Nothing is lost — deadlines are stored on the server and are enforced as soon as it's running again. Actions are paused until we reconnect.

**Restart toast** (persists until dismissed) plus a timeline marker:
> **The desk server restarted at 14:40:12** (offline about 18s). At startup it enforced deadlines that passed while it was down: **1 routing attempt timed out** (T-107, now retrying) and **0 offers expired**. [See activity]

The in-flight engine requests line depends on the restart model Engine chooses (baseline open question 11):
- (A) in-process engine: *"Engine requests that were in flight were lost with the server. As with any unanswered request, they time out at their deadline."*
- (B) external engine (persisted jobs): *"Engine requests sent before the restart may still answer. If one answers for a request we've already moved past, it's recorded and not applied."*
- *UX preference:* **B** produces a richer demo (late returns across a restart), but A is acceptable. The copy covers both.

---

## 5. Wireframes

### 5.1 Drawer: routing, overdue (high priority, attempt 1 of 3)

```
┌ T-107 · Adverse event signal review ───────────────────────────────── [×] ┐
│ ▲ High · Healthcare · created 1m 12s ago (14:31:02)                       │
│                                                                           │
│ [OVERDUE]                                              attempt 1 of 3     │
│ No answer for 27s. The engine may be slow or the request may be lost —    │
│ we can't tell from here.                                                  │
│                                                                           │
│ ┌ What happens next ───────────────────────────────────────────────────┐  │
│ │ Retry in 0:03 (at 14:31:32). If attempt #1 hasn't answered by then,  │  │
│ │ we'll send attempt #2 of 3. After 3 unanswered attempts it comes to  │  │
│ │ you.                                                                  │  │
│ │ You don't have to wait — high priority tasks can be offered directly. │  │
│ └───────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│ [Offer to someone…]  [Re-route now]  [⋯ Stop routing · Cancel · Add note] │
│                                                                           │
│ ATTEMPTS                    0s        10s       20s       30s       40s   │
│ #1 engine                   ████████████████████▓▓▓▓▓▓▓▓|                 │
│                             └ usual 5–20s ┘    overdue  timeout 30s       │
│ #1 · sent 14:31:02 · no answer yet (27s) · times out 14:31:32             │
│                                                                           │
│ HISTORY                                                                   │
│ 14:31:02  [You]     Created task · High · Healthcare                      │
│ 14:31:02  [You]     Routed · 2 eligible: Priya Shah, Marco Ruiz           │
│                     (Sam Okafor is away)                                  │
│ 14:31:02  [System]  Sent engine attempt #1 · times out at 14:31:32        │
│ 14:31:22  [System]  Attempt #1: no answer in the usual 20s                │
│                                                                           │
│ ╭┄ SIMULATION ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮ │
│ ┆ Attempt #1 is scripted to: never answer                               ┆ │
│ ┆ [Make it answer now: Priya Shah ▾]   [Make it answer: no match]       ┆ │
│ ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯ │
└───────────────────────────────────────────────────────────────────────────┘
```

**Mini attempt timeline [SHOULD]**: how it looks after an intervention followed by a late return (use case 3):

```
ATTEMPTS                    0s        10s       20s       30s       40s
#1 engine                   ██████████████████████░░░░░░░░░░░░░░░░░░◇ 40s → Marco Ruiz · IGNORED
                                                  ┆
                                                  ┆ 22s  You offered Ana Lima
```

And after an automatic retry:

```
#1 engine                   ██████████████████████████████✕ 30s timed out, no answer
#2 engine                                                 ███████● 7s → Marco Ruiz · applied
```

Timeline rules:
- The x-axis starts at the first dispatch of the current routing round. The span is `max(now, last event) + 10%`, with a minimum of 45s.
- Each attempt gets a lane. A solid bar means it is the current attempt and pending. A light bar (`░`) means it is still out there but no longer current (superseded or timed out). End markers: `●` matched and applied, `○` no match, `✕` timed out (at the deadline), `◇` late answer ignored (ghost grey, with a label).
- The usual 5–20s window is shaded on each lane, and a tick marks the timeout.
- A dashed vertical line across all lanes marks each operator action ("22s You offered Ana Lima"). A grey hatched band marks server downtime **[COULD]**.
- It is built from absolutely positioned divs with percentage widths. No chart library. Roughly 60 lines of TSX. `aria-hidden`; the text attempt list underneath carries the same information.

### 5.2 Drawer: recovery after a decline

```
┌ T-112 · Hospital claims cost analysis ─────────────────────────────── [×] ┐
│ – Normal · Finance · created 4m 03s ago (14:35:58)                        │
│                                                                           │
│ [NEEDS ATTENTION]  Declined                                               │
│ Dev Kapoor declined                                                       │
│ Offered by engine attempt #1 at 14:36:06; declined 34s later:             │
│ "At capacity this week."                                                  │
│                                                                           │
│ ┌ What happens next ───────────────────────────────────────────────────┐  │
│ │ Nothing automatic. This task waits for you.                          │  │
│ │ We don't re-route after a person declines — their reason might       │  │
│ │ change what you do next. (Engine timeouts are different: those we    │  │
│ │ retry automatically.)                                                │  │
│ └───────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│ PATH SO FAR                                                               │
│ Routed 14:35:58 → engine #1 answered 8s → offered Dev Kapoor → declined   │
│                                                                           │
│ EXCLUDED FROM ENGINE ROUTING (1)                                          │
│ (Dev Kapoor · declined 14:36:40)   You can still offer it to Dev yourself │
│                                                                           │
│ STILL ELIGIBLE (2)                    load         recent                 │
│ ● Lena Fischer   Finance              0 active     —            [Offer]   │
│ ● Ana Lima       Finance · Ops        2 active     1 decline    [Offer]   │
│                                                                           │
│ [Re-route with engine (excludes Dev)]   Offer to someone…   Cancel task   │
│  ^ recommended: 2 eligible contributors remain                            │
│                                                                           │
│ Add a note (optional, saved with your action)                             │
│ [______________________________________________________________]          │
│                                                                           │
│ HISTORY  (…)                                                              │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Create-task dialog

```
┌ New task ───────────────────────────────────────────────────── [×] ┐
│ Title *                                                             │
│ [Q3 revenue variance review_____________________________________]   │
│                                                                     │
│ Expertise *                         Priority                        │
│ [Finance               ▾]           ( High | ●Normal | Low )         │
│ ✓ 3 contributors cover Finance —    Normal: retry if no engine      │
│   all 3 available now               answer in 45s (2 retries)       │
│                                                                     │
│ Brief (optional)                                                    │
│ [________________________________________________________________]  │
│ [________________________________________________________________]  │
│                                                                     │
│ ╭┄ SIMULATION · demo behaviour for this task ┄┄┄┄┄┄┄┄┄┄┄┄ [▸ show] ╮│
│ ┆ Engine          [Realistic — 5–20s, 20% never answer        ▾]    ┆│
│ ┆ Contributor     [Use global setting (auto-respond on)       ▾]    ┆│
│ ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯│
│                                                                     │
│                         [Save as draft]   [Create & route  ⌘↵]      │
└─────────────────────────────────────────────────────────────────────┘
```

When no one is eligible, the ✓ line is replaced by an amber warning:
```
│ ⚠ No available contributor covers Legal. If you route it now, it   │
│   goes straight to Needs attention — the engine won't be called.   │
│   You can still save it as a draft.                                │
```

### 5.4 Offer dialog (while routing is pending)

```
┌ Offer T-109 "Clinic staffing model" to… ───────────────────────── [×] ┐
│ ┌ Engine attempt #1 is still pending (22s) ─────────────────────────┐ │
│ │ If you send this offer, we stop waiting for it. If it answers     │ │
│ │ later, we'll show what it suggested in the history, but we won't  │ │
│ │ apply it.                                                         │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ Operations · 2 eligible                     load       availability   │
│ ( ) Marco Ruiz     Operations · Healthcare  1 active   ● Available    │
│ (●) Ana Lima       Finance · Operations     0 active   ● Available    │
│ ── Excluded earlier on this task ──                                   │
│ ( ) (none)                                                            │
│                                                                       │
│ Note (optional, saved to history)                                     │
│ [Client asked for Ana____________________________________________]   │
│                                                                       │
│ Ana will have 60s to reply. Routing is complete only when Ana         │
│ accepts.                                                              │
│                                   [Back]   [Send offer to Ana Lima]   │
└───────────────────────────────────────────────────────────────────────┘
```

If the operator picks an excluded contributor, an amber line appears and a confirm checkbox is required: *"Dev Kapoor declined this task at 14:36 ('At capacity this week'). ☐ Offer anyway."* (FLAG-4)

### 5.5 Disconnected and post-restart

```
+--------------------------------------------------------------------------------------------------+
| TERAC ROUTING DESK     ○ Offline since 14:39:54                    [? How this desk behaves] [+ New task] (disabled) |
+--------------------------------------------------------------------------------------------------+
| ! Can't reach the desk server since 14:39:54 (18s). Showing the last known state; countdowns are  |
|   replaced with due times. Nothing is lost — deadlines are stored on the server and are enforced  |
|   as soon as it's running again. Actions are paused until we reconnect.                          |
+--------------------------------------------------------------------------------------------------+
|  ▲  Adverse event signal review 2   OVERDUE         Retry due 14:40:01        2m                  |
```
The data area dims to 70% opacity. All action buttons are disabled with the tooltip *"Reconnect to act."* After reconnecting with a new `bootId`, the restart toast (§4.5) appears, the banner clears, and the marker shows up in the activity feed and in every affected task's history.

---

## 6. Intervention UX

### 6.1 Action matrix **[MUST]** (only valid actions are shown; no disabled clutter, except while offline)

| Action | Draft | Routing | Offered | Assigned | In progress | Needs attention | Done / Cancelled |
|---|---|---|---|---|---|---|---|
| **Route** | ● primary | – | – | – | – | – | – |
| **Offer to someone…** | ● | ● (supersedes the attempt) | – (withdraw first; see COULD) | – | – | ● (often recommended) | – |
| **Re-route now** / **Re-route with engine** | – | ● (supersedes; new round) | – | – | – | ● | – |
| **Stop routing** | – | ● (inline confirm) | – | – | – | – | – |
| **Withdraw offer** | – | – | ● (inline confirm) | – | – | – | – |
| **Release assignment…** (fell through before start) | – | – | – | ● (reason required) | – | – | – |
| **Cancel task** | ● | ● | ● (confirm) | ● (confirm + reason) | ● (confirm + reason) | ● | – |
| **Add note** | ● | ● | ● | ● | ● | ● | ● |

- **[COULD]** "Withdraw & offer to someone else" as one command while a task is offered.
- **[COULD]** "They've already agreed — mark as accepted" checkbox in the offer dialog.
- **[COULD]** "Change expertise & re-route", for the no-eligible case.
- **[WON'T]** editing priority while routing (it would move deadlines mid-flight).

### 6.2 Confirmation and notes policy

| Weight | Actions | Pattern |
|---|---|---|
| No confirmation (the dialog *is* the confirmation, or the action is harmless) | Route, Offer (dialog), Re-route, Add note | Optimistic button spinner, then a toast: "Offer sent to Ana Lima · expires in 1:00" |
| Inline two-step | Stop routing, Withdraw offer, Cancel (draft, routing, needs attention) | The button turns into `Confirm stop? [Yes, stop] [Keep routing]` for 5s |
| Confirm plus required reason | Release assignment, Cancel while someone is offered, assigned or working | A small dialog with a reason select (`Contributor unreachable` · `Contributor withdrew` · `Conflict of interest` · `Client changed scope` · `Other`) and free text |

- Every intervention accepts an **optional note** (one line, ≤ 280 chars). It is stored on the event and rendered in history as `— 'Client asked for Ana'`.
- Every state-changing command sends `expectedVersion`. Notes are exempt because they don't depend on state.
- A failed request (500 or network) shows the toast *"Couldn't send the offer — nothing changed. Try again."* This is accurate because each command is a single transaction.

### 6.3 Intervening while routing is pending (the key explanation)

- The offer dialog, Re-route, Stop routing and Cancel all show the same explanation when an attempt is pending:
  *"Engine attempt #1 is still pending (22s). If you [send this offer / re-route / stop / cancel], we stop waiting for it. If it answers later, we'll show what it suggested in the history, but we won't apply it."*
- After the action, history records the supersede event ("Stopped waiting for attempt #1…"). The pending lane in the mini timeline switches from solid to light.
- When the late answer arrives, it shows up **only** as a ghost entry in history and the activity feed, plus a `◇` marker on the timeline. It doesn't trigger a toast, re-sort the queue or change the status. It does increment `1 late` in the engine tile.

### 6.4 Recommended next action logic **[MUST]** (a pure client function `recommend(detail)`, unit-tested)

| Situation | Recommended (dark button) | Helper text |
|---|---|---|
| Draft | Route | "3 eligible contributors." |
| Routing within the window | none (all actions secondary) | "The engine usually answers within 20s." |
| Routing overdue, normal or low priority | none | "Automatic retry in 0:12." |
| Routing overdue, **high** priority | Offer to someone… (secondary styling + ▲) | "High priority: you can skip the wait." |
| Offered | none | "Offer expires in 0:41." |
| Declined, expired, fell through, withdrawn; ≥1 candidate left | Re-route with engine (excludes N) | "2 eligible contributors remain." |
| `routing_exhausted`, `no_match`, `routing_stopped` | Offer to someone… (least-loaded preselected) | "The engine hasn't helped here; your judgment is faster." |
| `invalid_engine_result` | Re-route | "The engine's pick is no longer eligible." |
| `no_eligible_contributors`, or 0 candidates left | Cancel task | "Nobody eligible is available. Make someone available (Simulation) or offer to an excluded contributor." |

Rule: the **server** computes *what will happen automatically* (policy). The **client** computes *what we suggest you do* (presentation). The UI never re-implements a deadline.

---

## 7. Recovery UX (decline, expiry, fell through before start) **[MUST]**

The panel replaces the action bar whenever a task needs attention. It has six parts, in this order:

1. **What happened**: a title plus one or two sentences with times, the actor and the contributor's reason in quotes (§4.3).
2. **Path so far**: a one-line chain, for example `Routed 14:35:58 → engine #1 answered 8s → offered Dev Kapoor → declined`. A longer path wraps. For more than 4 hops it shows the last 3 plus "+2 earlier" **[SHOULD]**.
3. **Excluded from engine routing**: chips like `Dev Kapoor · declined 14:36:40`, with a tooltip: *"The engine won't be asked to choose Dev again for this task. You can still offer it to Dev yourself."*
4. **Still eligible**: each candidate with expertise, availability, **load** (`N active`), and recent declines (`1 decline today`). Sorted by load, then by name. Each row has an `[Offer]` button that opens the offer dialog with that person preselected, so it takes two clicks with the note box in between. Away contributors are listed greyed out at the bottom as "Away — not eligible".
5. **Actions**: the recommended action (§6.4) as the dark button, the rest as secondary buttons, and an optional note box.
6. **What we won't do automatically**, always shown in the "What happens next" box: *"Nothing automatic. This task waits for you. We don't re-route after a person declines — their reason might change what you do next. (Engine timeouts are different: those we retry automatically.)"*

Variants:
- **Expired:** "Lena Fischer didn't reply within 60s." Lena is excluded from the engine.
- **Fell through (operator released it):** this starts with the operator's reason. **(Contributor withdrew, via simulation):** this starts with the contributor's reason and carries a SIM chip.
- **Zero candidates left:** the Still eligible section reads *"Nobody left. Everyone with Finance has declined, let an offer expire, or is away."* It is followed by `[Offer to an excluded contributor…]` and `[Cancel task]`, plus a violet hint: *"Simulation: make a contributor available."*

---

## 8. Create-task form **[MUST]**

| Field | Control | Validation and copy |
|---|---|---|
| Title * | text input, autofocus | Trimmed, 3–120 chars. Error: "Give the task a title (3–120 characters)." |
| Expertise * | select: Finance · Healthcare · Data analysis · Operations · Legal | Required. Each option shows its count, e.g. `Healthcare (2 available)`, so zero is visible before it's picked. |
| Priority | segmented control: High / **Normal** / Low | Helper line under it, from the policy endpoint: "High: retry if no engine answer in 30s (2 retries)". |
| Brief | textarea | Optional, ≤ 1000 chars. A counter appears after 800. |
| Eligibility line | live, computed from the contributors already in the desk snapshot (no extra endpoint) | `✓ 3 contributors cover Finance — all 3 available now` · `✓ 3 cover Healthcare — 2 available (Sam Okafor is away)` · zero: the amber warning (§5.3). Footnote: "Eligibility is checked again when routing starts." |
| Simulation: Engine | violet select, collapsed | `Realistic — 5–20s, 20% never answer` (default) · `Quick match — answers in ~6s` · `No match — answers in ~8s` · `Answers late, at ~40s` (helper: "Normal priority: before the 45s timeout. High: after the 30s timeout, so it's ignored.") · `First request lost, retry matches` · `Every request lost` (FLAG-10) |
| Simulation: Contributor | violet select, collapsed | `Use global setting` (default) · `Accept after ~5s` · `Decline after ~5s` · `Never reply (offer expires)` · `Wait for my click` |

- **Buttons:** `Create & route` (primary; ⌘/Ctrl+Enter) and `Save as draft`. The primary label stays the same when nobody is eligible, because the warning already explains what will happen and routing to needs-attention is a legitimate choice.
- **After submit:** the dialog closes, **the drawer opens on the new task** so the operator watches routing begin, the row appears with a 1s highlight, and a toast reads *"T-113 created · routing started"*.
- **Validation** shows on blur and on submit. The server re-validates with the shared zod schema and maps server errors to the same field messages.
- **Draft persistence across refresh:** [WON'T].

---

## 9. System states, keyboard and accessibility

### 9.1 Empty states **[MUST]**
- No tasks at all: *"The desk is clear. No tasks yet."* `[+ New task]` and a violet `[Load demo data]`.
- Filter with no results: *"No tasks match these filters."* `[Clear filters]`.
- Empty Needs attention group: *"Nothing needs you right now."*
- Contributors list empty: *"No contributors. Reset demo data in Simulation."*
- Activity feed empty: *"Activity will appear here as tasks move."*
- Drawer with an unknown ID in the URL: *"Task T-999 not found. It may have been removed by a demo reset."* `[Close]`.

### 9.2 Loading **[MUST]**
Skeleton rows (3 grey bars) appear on the **first** load only. After that the UI never blanks. It keeps the last data while refetching (TanStack `placeholderData: keepPreviousData`), and the "Live" tooltip shows freshness.

### 9.3 Disconnected and post-restart **[MUST]**
- Detection: every `/api/desk` poll returns `now`, `bootId` and `serverStartedAt`. Three failed polls, or more than 3s without a success, puts the UI in Offline mode (§5.5). `refetchOnWindowFocus` is on, so a backgrounded tab catches up immediately.
- Server-time offset: `offset = serverNow - Date.now()` on every poll. All ages and countdowns use `Date.now() + offset`. A 1s local ticker re-renders the countdowns, independent of polling.
- Restart: a new `bootId` shows the restart toast, and the drawer and filters survive through the URL. Form drafts are lost (WON'T).

### 9.4 Keyboard **[SHOULD]** (a single keydown listener; ignored while an input is focused)
`N` new task · `J` / `K` next or previous row · `Enter` open drawer · `Esc` close drawer or dialog · `?` policy panel. **[COULD]**: `O` offer and `R` re-route in the drawer, `/` search.

### 9.5 Accessibility basics **[MUST]**
- Status never relies on colour alone: badges always carry text, and actor icons have labels.
- Native `<dialog>` for modals, which gives focus trapping and Esc. The drawer is `role="complementary"` with a labelled heading. Focus moves into the drawer on open and returns to the row on close.
- The queue is a real `<table>`. Each row's title is a `<button>` so it is keyboard-reachable. The whole row is also clickable.
- Countdowns are `<time datetime>`. Only **status changes** are announced via `aria-live="polite"`, never per-second ticks.
- Text contrast meets WCAG AA (zinc-600 or darker on white). `prefers-reduced-motion` disables the drawer slide and the row highlight.
- The mini timeline is `aria-hidden`; the text attempt list carries the same information.

---

## 10. Visual direction and component kit

### 10.1 Direction: "calm, dense, honest"
- **Canvas:** page `zinc-50`, panels `white`, 1px `zinc-200` borders, `rounded-md`, no shadows except the drawer (`shadow-xl`, left edge only).
- **Type:** system UI stack (Inter if installed). Base size 13px (`text-[13px]`), 12px for detail lines, 11px uppercase tracking-wide section labels. **`tabular-nums` on every number and timer.** IDs and timestamps use `font-mono`.
- **Colour budget:** status colours from §4.1 only. Buttons are monochrome: primary `zinc-900` filled, secondary white with a border, destructive text-only `rose-700`. **Violet is reserved for simulation.** Priority uses glyph and weight, never colour.
- **Motion:** the drawer slides in over 150ms. Nothing pulses or blinks; only the countdown digits change. A pending request is shown by elapsed seconds, not a spinner. A spinner would suggest "working on it", and we don't know that.
- **Icons:** `lucide-react`.

### 10.2 Kit decision
- **Choice:** Tailwind CSS v4 (Vite plugin) + `lucide-react` + `sonner` (toasts) + native `<dialog>` + about 8 hand-rolled components: `StatusBadge`, `Countdown`, `Button`, `Drawer`, `Dialog`, `EventRow`, `AttemptTimeline`, `SimBox`.
- **Alternatives:** shadcn/ui gives polished primitives, but init plus generated files cost 10–15 minutes and leave lots of code to review. Mantine or MUI are heavy, look generic, and are harder to make dense. Plain CSS is slower to iterate with an agent.
- **Say-it:** *"Tailwind and a handful of tiny components: everything on screen is something I can explain line by line."*

### 10.3 Build order (agent-assisted, about 75 minutes of MUST)
1. App shell, `useDesk()` polling hook with server-time offset, `StatusBadge`, `Countdown`, and the grouped, sorted queue with Age, Status and Next. *(20 min)*
2. Drawer: header, hero, "What happens next", state-aware action bar, history with actor icons and ghost style, text attempt list. *(20 min)*
3. Create dialog with the eligibility line and violet scenario selects. *(10 min)*
4. Offer dialog with the pending explanation, the recovery panel, and the 409 banner. *(15 min)*
5. Summary tiles as filters, policy panel, offline banner, restart toast, simulation dock (reset, auto-respond, never-return rate, availability) and the drawer simulation box. *(10–15 min)*

SHOULD, only if MUST is done by 1h15: the mini attempt timeline (15), engine health tile (5), alert line (5), row progress bar (5), keyboard (5), activity feed (10), contributor detail (5).

### 10.4 Cut first → cut last
1. **Activity feed.** Drawer history already covers inspection; the summary strip covers "what's going on".
2. **Keyboard shortcuts.**
3. **Row progress bars.** The detail line already says "No answer 27s · try 1/3".
4. **Alert line.** The `▲ 1 high` tile sub-line stays.
5. **Engine health tile.** Falls back to the text "Engine: 2 pending".
6. **Mini attempt timeline.** Falls back to the text attempt list. Cut this as late as possible, because it is the clearest late-return visual for the Loom.
7. **Contributor detail.** Falls back to name, availability and active count.

**Never cut:** "What happens next", ghost entries, the recovery panel, the offer-while-pending explanation, the 409 banner, the offline banner, the policy panel, or the simulation quarantine.

---

## 11. Key decisions

| # | Choice | Alternatives considered | Why | Say-it (one sentence for the reviewer) | Tag |
|---|---|---|---|---|---|
| UX-1 | **Single-screen desk with a non-modal drawer** | Multi-page list and detail routes; a kanban board by state | Operators must keep watching the whole operation while inspecting one task. Kanban hides time and wastes width. | "It's a desk: you keep your eyes on the whole queue while you work one task." | MUST |
| UX-2 | **Grouped, triage-ordered queue** (Needs attention → In flight → Working → Drafts → Settled) | Newest first; free column sorting | The first row should always be the most urgent thing for a human. Stable ordering keeps rows from jumping. | "The top row is always the thing that most needs you." | MUST |
| UX-3 | **"What happens next" on every task, computed by the server** | Show status only; derive deadlines on the client | Uncertainty is the core problem, and the fix is making the system's own intentions explicit. Server computation means the UI can't drift from policy. | "Nothing automatic happens that wasn't on screen as a countdown first." | MUST |
| UX-4 | **Honest "Overdue" copy** with no stuck/failed language and no spinner | Mark it "Stuck" at 20s; spin forever; hide elapsed time | The brief says the operator *cannot know*. Claiming more is wrong, and showing less invites guessing. | "We say what we know — no answer for 27s — and what we don't: whether one is coming." | MUST |
| UX-5 | **Late answers are visible ghosts**, never applied and never toasted | Hide them; apply them if still useful; alert on them | Hiding loses the explanation of what happened. Applying breaks one-assignee and the operator's authority. Toasts create noise. | "Late answers go in the record, not the assignment — and you can see exactly what they would have done." | MUST |
| UX-6 | **People stop and ask; timeouts retry** | Auto re-route after a decline; escalate on the first timeout | A decline carries meaning (a reason, scope, rate). A timeout is noise to absorb. | "Machines get retried, people get a human." | MUST (shared with Domain) |
| UX-7 | **Simulation is quarantined in violet** | A hidden `/dev` page; sim buttons mixed into the action bar | Reviewers must never confuse "I, the operator" with "the world responded". | "Anything violet is pretending to be the outside world." | MUST |
| UX-8 | **A manual assignment is an offer**, using the same lifecycle | Direct assignment as "accepted" | One path means fewer states and fewer bugs. The contributor still consents, and expiry and decline recovery work identically. | "Operators choose who; contributors still say yes." | MUST (COULD: "already agreed" checkbox) |
| UX-9 | **Exclusions bind the engine, not the operator** | Hard-block excluded contributors everywhere | Operators know things the system doesn't, such as a phone call where the person changed their mind. An explicit confirm keeps it deliberate. | "The engine won't ask Dev again; you can, with your eyes open." | MUST |
| UX-10 | **Conflicts are explained, never auto-resolved** | Last write wins; silently refetch; retry automatically | Concurrency is a core theme of the brief. A visible 409 with "what changed" is the honest outcome. | "If the task moved under you, we show you how — and do nothing on your behalf." | MUST |
| UX-11 | **Colour means status only.** Priority uses glyph and weight; violet means simulation. | Red for high priority; a brand accent everywhere | A calm desk needs colour to carry one meaning, so that red means *needs you*. | "If it's red, it's waiting for you — nothing else is red." | MUST |
| UX-12 | **1s polling of one snapshot plus a server-time offset**, with absolute due times while offline | SSE/WebSocket push; client wall clock | Polling survives restarts with no reconnection logic, and the offset makes ages correct. (Inherits baseline item 12.) | "The UI is a 1-second window onto the database, so a restart is just a gap in the window." | MUST |
| UX-13 | **URL holds the selection and filter** | Component state only | A refresh or restart lands you where you were, which is part of the restart demo. | "Refresh mid-incident and you're still looking at the same task." | SHOULD |

---

## 12. Edge cases and exact behaviour

| # | Situation | Behaviour |
|---|---|---|
| E1 | The engine answers while the operator's offer dialog is open | The in-dialog pre-warning appears (SHOULD). On send the server returns 409, and the conflict banner lists "Engine attempt #1 answered: Lena Fischer · Offered to Lena Fischer". The operator's offer is **not** sent. |
| E2 | Two tabs (or two operators) act at the same time | The first commit wins. The second gets a 409 with `changesSince`. |
| E3 | A superseded attempt answers | A ghost history entry with the reason "you had already offered…", a `◇` on the timeline, and `+1 late` in the engine tile. No toast, no re-sort, no status change. |
| E4 | An attempt answers after the task was cancelled or completed | A ghost entry: "…Not applied: the task was cancelled." |
| E5 | Attempt #1 answers late while attempt #2 is still pending | Ignored (strict fencing: only the current attempt's answer counts) and recorded as a ghost. COULD: "Use this suggestion →". |
| E6 | The engine's pick became unavailable or excluded after dispatch | `invalid_engine_result` → needs attention, with the "couldn't be used" copy. |
| E7 | A contributor responds after the offer expired (auto-response race) | A ghost entry: "Lena tried to accept at 14:42:33, but the offer had expired at 14:42:30." The task stays where it is. |
| E8 | Withdraw and accept land at the same instant | The first commit wins. If accept wins, the operator's withdraw gets a 409 "Lena Fischer accepted 1s ago". If withdraw wins, the accept is recorded as a rejected response. |
| E9 | Zero eligible at create | Amber warning. Routing anyway goes straight to `no_eligible_contributors`, and the engine is not called. |
| E10 | Every eligible contributor is excluded | Recovery shows "Nobody left" with "Offer to an excluded contributor…" and Cancel. |
| E11 | A countdown hits 0 before the server's next tick | Shows "Due now — applying…" for up to 3s. Never a negative number. |
| E12 | Server unreachable | Offline banner, absolute due times, actions disabled, data dimmed (§5.5). |
| E13 | Server restarted, deadlines passed while it was down | Restart toast with enforced counts. History shows "…timed out while the server was offline · enforced at startup". Restart marker divider. |
| E14 | Browser tab was in the background for minutes | `refetchOnWindowFocus` refetches. The offset is recomputed. Countdowns correct immediately. |
| E15 | Ten tasks routing at once | Stable sort; rows move only on band changes; the summary shows `10 routing · 3 overdue`. The drawer stays on the selected ID even as rows move. |
| E16 | Operator re-routes while an attempt is pending | The old attempt is superseded (light lane) and a new round starts at "try 1/3" with attempt number #2 (FLAG-5). A late answer from the old attempt becomes a ghost. |
| E17 | Operator stops routing, then the attempt answers | Ghost entry "…Not applied: you stopped routing." |
| E18 | Offer dialog targets an excluded contributor | An amber warning with the contributor's earlier reason. The confirm checkbox is required. |
| E19 | Draft saved with a sim scenario | The scenario is stored with the draft and applied when it is routed. Shown in the drawer's simulation box. |
| E20 | Demo reset while the drawer is open | The drawer shows "Task not found. It may have been removed by a demo reset." |
| E21 | Long titles or reasons | Truncated with ellipsis and a `title` tooltip. The drawer shows the full text. |
| E22 | A command fails with a 500 or network error | Toast: "Couldn't send the offer — nothing changed. Try again." Commands are transactional, so this statement is true. |
| E23 | A high-priority task is overdue while the operator is in another drawer | The alert line (SHOULD) and the `▲ 1 high` tile sub-line are visible above the queue. The drawer does not steal focus. |

---

## 13. Click-by-click demo paths

Seed used below (FLAG-12):
- **Contributors**
  - Priya Shah: Healthcare, Data analysis
  - Marco Ruiz: Operations, Healthcare
  - Dev Kapoor: Finance, Data analysis
  - Ana Lima: Finance, Operations
  - Lena Fischer: Finance
  - Sam Okafor: Healthcare, *Away*
- **Expertise areas:** Finance, Healthcare, Data analysis, Operations, and **Legal (nobody)**.
- **Global simulation setting:** auto-respond **off** for recording, so the presenter controls replies.

Exact contributor picks in the steps below are illustrative. The engine's matching rule belongs to Engine.

### UC1: Routine assignment (about 60s)
1. Press `+ New task`.
2. Title: "Q3 revenue variance review". Expertise: **Finance**. The line reads *"✓ 3 contributors cover Finance — all 3 available now."* Priority: Normal.
3. Simulation ▸ Engine: **Quick match**. Contributor: **Wait for my click**. Press **Create & route**.
4. The drawer opens on T-113: `ROUTING · Waiting 2s · try 1/3`. What happens next: "Retry in 0:43…". *Narrate: the countdown is the system announcing its own next move.*
5. At about 6s, history shows "Attempt #1 answered after 6.1s: **Lena Fischer**" and then "Offered to Lena Fischer · expires 14:52:30". The status is `OFFERED` and the next line reads *"Offer expires in 0:59."*
6. Simulation box: **Accept as Lena Fischer**. The status is `ASSIGNED`: "Routing is complete." The history entry carries a SIM chip.
7. **Start work as Lena**, giving `IN PROGRESS`, then **Mark complete as Lena**, giving `DONE`. The row moves to Settled. Scroll the history: every step has an actor.

### UC2: Unresolved routing, high priority (start it first in the Loom and come back to it)
1. `+ New task`: "Adverse event signal review", **Healthcare** (*"3 cover Healthcare — 2 available (Sam Okafor is away)"*), Priority **High**. Engine: **Every request lost**. Press **Create & route**.
2. From 0 to 20s: `ROUTING · Waiting 12s`.
3. At 20s: badge `OVERDUE`. The hero reads *"No answer for 20s. The engine may be slow or the request may be lost — we can't tell from here."* The alert line appears. The tile shows `▲ 1 high` and `1 overdue`.
4. Open **How this desk behaves** and read out the retry policy while the countdown runs: *"Retry in 0:09 (attempt 2 of 3)."*
5. At 30s: "Attempt #1 timed out after 30s with no answer · retrying (2 of 3)". The timeline shows lane #1 ending in `✕` and lane #2 starting.
6. Option (a): let it run. At 90s the task is `NEEDS ATTENTION · Engine didn't answer (3 tries)` and recovery recommends **Offer to someone…** with Marco Ruiz preselected (least loaded). Send it.
   Option (b): the alternative take is the **First request lost, retry matches** scenario. That shows the automatic retry recovering on its own at about 36s.
7. **Bonus:** in the simulation box, press **Make attempt #1 answer now: Priya Shah**. A ghost entry appears: "Late answer ignored… Not applied: it had already timed out and attempt #2 replaced it."

### UC3: Human intervention while routing is pending (about 60s)
1. `+ New task`: "Clinic staffing model", **Operations**, Normal. Engine: **Answers late, at ~40s**. Press **Create & route**.
2. Wait about 22s until `OVERDUE`. Press **Offer to someone…**. The dialog's blue box reads *"Engine attempt #1 is still pending (22s). If you send this offer, we stop waiting for it. If it answers later, we'll show what it suggested in the history, but we won't apply it."*
3. Pick **Ana Lima** (0 active). Note: "Client asked for Ana". Press **Send offer to Ana Lima**.
4. History: "Stopped waiting for attempt #1 (you offered manually)…" and "You offered it to Ana Lima — 'Client asked for Ana'". The timeline lane turns light and a dashed line appears at 22s.
5. At about 40s, a ghost entry appears: "*Late answer ignored.* Attempt #1 answered after 40s and suggested **Marco Ruiz**. **Not applied:** you had already offered the task to Ana Lima at 14:31:24." A `◇` marker shows on the timeline. Point out that the status didn't change and no toast appeared.
   - To avoid waiting, press **Make it answer now** in the simulation box right after step 3.
6. **Accept as Ana Lima** gives `ASSIGNED`.
7. *Contrast:* the same scenario **without** stepping in applies Marco at 40s, because 40s is before the 45s normal-priority timeout. The operator's action is what made the answer stale.

### UC4: Recovery after a decline, plus fell-through-before-start (about 90s)
1. `+ New task`: "Hospital claims cost analysis", **Finance**, Normal. Engine: **Quick match**. Contributor: **Decline after ~5s**. Press **Create & route**.
2. At about 6s it is offered to **Dev Kapoor**. At about 11s: "Dev Kapoor declined: 'At capacity this week.'" The task jumps to the top group, `NEEDS ATTENTION · Declined by Dev Kapoor`, and the tile shows `1`.
3. Recovery panel: what happened, the path so far, **Excluded: Dev Kapoor**, **Still eligible: Lena Fischer (0 active), Ana Lima (2 active, 1 decline today)**, and "Nothing automatic… we don't re-route after a person declines."
4. Press **Re-route with engine (excludes Dev)**. The new attempt shows as try 1/3 (attempt #2). It is offered to Lena Fischer → **Accept as Lena**, giving `ASSIGNED`.
5. **Fell-through variant:** press **Release assignment…**, choose reason **Contributor unreachable**, and confirm. The result is `NEEDS ATTENTION · Fell through before start`. Lena is added to Excluded and only Ana remains. Press **[Offer]** on Ana's row and send. Ana gets the offer.
6. Scroll the full history: it reads top to bottom as the story of the task.

### Bonus: restart (the strongest non-happy path; about 45s)
1. With two tasks routing (one **Every request lost**, one **Answers late, at ~40s**), Ctrl+C the server.
2. The UI shows `○ Offline since …`, the banner, dimmed data, absolute due times and disabled buttons.
3. Wait about 35s, so at least one deadline passes during the downtime. Run `npm run dev`.
4. The restart toast reads *"…1 routing attempt timed out…"*. The `Server offline 14:39:54 → 14:40:12` divider appears in history, and the entry "Attempt #1 timed out while the server was offline · enforced at startup · retrying (2 of 3)". The drawer is still open on the same task, through the URL.
5. Under restart model B, a pre-restart request may still answer and become a ghost entry.

---

## 14. What this UX needs from other sections (contract sketch)

```ts
// GET /api/desk  — polled every 1s (Architecture & Verification)
type DeskSnapshot = {
  now: string; bootId: string; serverStartedAt: string;
  lastRestart?: { at: string; offlineSec: number | null;
                  enforced: { attemptsTimedOut: number; offersExpired: number } };
  summary: { attention: number; attentionHigh: number; routing: number; overdue: number;
             offered: number; nextOfferExpiry?: string; working: number; done: number };
  engineHealth: { window: 20; answered: number; medianMs: number | null; unanswered: number;
                  late: number; pending: number; consecutiveUnanswered: number };
  tasks: TaskRow[];            // includes status, reason, priority, expertise, createdAt, version,
                               // currentAttempt {no, roundTry, roundSize, dispatchedAt, deadlineAt},
                               // offer {contributorId, expiresAt, source}, nextAutomaticAction
  contributors: ContributorRow[]; // expertise[], available, activeLoad, declinesToday
  recentEvents: EventView[];   // last 50, for the activity feed
};

type NextAutomaticAction =
  | { kind: 'attempt_timeout_retry'; dueAt: string; nextTry: number; roundSize: number }
  | { kind: 'attempt_timeout_escalate'; dueAt: string }
  | { kind: 'offer_expiry'; dueAt: string; contributorId: string }
  | { kind: 'none' };

// GET /api/tasks/:id → { task, attempts[], offers[], events[], eligible[], excluded[] }
// GET /api/policy    → { windowMinS:5, windowMaxS:20, overdueS:20, timeoutS:{high:30,normal:45,low:60},
//                        retries:2, offerExpiryS:60, pollMs:1000 }

// Commands (all take expectedVersion except notes; 409 → { error:'version_conflict', task, changesSince: EventView[] })
// POST /api/tasks                      { title, expertise, priority, brief?, route: boolean, sim?: {engine, contributor} }
// POST /api/tasks/:id/route | /offer {contributorId, note?, overrideExclusion?} | /reroute {note?}
//      /stop-routing {note?} | /withdraw-offer {note?} | /release {reason, note?} | /cancel {reason?} | /notes {text}

// Simulation (violet; Engine, Time & Concurrency)
// POST /api/sim/attempts/:id/force-answer {outcome:'match'|'no_match', contributorId?}
// POST /api/sim/offers/:id/respond {response:'accept'|'decline', reason?}
// POST /api/sim/assignments/:id/{start|complete|withdraw} {reason?}
// PATCH /api/sim/settings {neverReturnRate, autoRespond, acceptP, declineP}
// PATCH /api/sim/contributors/:id {available}
// POST /api/sim/reset
```

`EventView` = `{ id, at, type, actor: 'operator'|'engine'|'system'|'contributor'|'server', actorName?, text?, data, ignored?: { reason } , simulated?: boolean, note?: string }`. The client renders sentences from `type` and `data` using the §4.4 table. One `eventSentence(ev)` function is unit-tested.

---

## 15. Divergences and flags for the synthesizer

| Flag | Divergence or addition | Owner to reconcile |
|---|---|---|
| **FLAG-1** | User-facing labels: `new` → **Draft**, `awaiting_response` → **Offered**. **Overdue** is a display-only sub-state of `routing` (not stored). | Domain & State |
| **FLAG-2** | Add reason **`offer_withdrawn`**, separate from `routing_stopped`. A withdrawn contributor is **not** excluded. | Domain & State |
| **FLAG-3** | `failed_before_start` has two triggers: the operator's **Release assignment…** (reason required) and the simulated contributor's "withdraw before start". It is the same command with a different actor. No automatic "start-by" deadline after accept (WON'T). | Domain & State |
| **FLAG-4** | Exclusions bind **engine routing only**. A manual offer to an excluded contributor is allowed with `overrideExclusion: true`. It must not be a database constraint. | Domain & State |
| **FLAG-5** | Operator **Re-route** starts a **new routing round** with a fresh retry budget (3 tries). Attempt numbers keep incrementing (#4, #5, …), so history is unambiguous; "try n/3" is per round. | Engine, Time & Concurrency |
| **FLAG-6** | Offer expiry **60s** (compressed and labelled as such). Contributor auto-reply after 3–12s at 70/20/10 accept/decline/no reply. Auto-respond **off** while recording the Loom. | Engine / Domain |
| **FLAG-7** | The server computes `nextAutomaticAction` per task and returns `now`, `bootId`, `serverStartedAt` and `lastRestart` on every snapshot. The UI never re-derives policy. | Architecture & Verification |
| **FLAG-8** | An estimate of downtime needs a persisted heartbeat (`meta.last_heartbeat_at` written each reconciler tick). The boot-time restart event records the offline span and the deadlines enforced. | Engine, Time & Concurrency |
| **FLAG-9** | The 409 payload includes `changesSince: EventView[]` (events after `expectedVersion`), so the UI can render "This task changed while you were looking: …". | Architecture & Verification |
| **FLAG-10** | Per-task simulation scenarios. Engine: `realistic`, `quick_match`, `no_match`, `answers_at_40s`, `first_lost_retry_matches`, `always_lost`. Contributor: `global`, `accept`, `decline`, `no_reply`, `manual`. Plus **force-answer** for any unresolved attempt, including superseded ones. This is how late returns are demoed on cue. Simulated events carry `simulated: true`. | Engine, Time & Concurrency |
| **FLAG-11** | Server-side engine health over the last 20 attempts: answered (median latency), unanswered, late, pending, `consecutiveUnanswered`. | Engine / Architecture |
| **FLAG-12** | Seed: the 6 contributors above. 5 expertise areas including **Legal with nobody** (the zero-eligible demo). Seeded tasks only in settled, working or draft states (a T-101 completed, a T-102 in progress, a T-110 Legal draft). No seeded tasks in routing, so nothing surprising fires at boot. | Domain & State / Delivery |
| **FLAG-13** | The reconciler writes an informational `attempt.overdue` event at 20s so history reads end to end. This is optional; the UI works without it. | Engine, Time & Concurrency |
| **FLAG-14** | Contributor availability is changed only in Simulation, because it is the contributor's own declaration, not an operator action. | Domain & State |
| **FLAG-15** | Restart model: the UX prefers **B** (the simulated engine outlives the process) for a richer demo. Copy is provided for both A and B. | Engine, Time & Concurrency |
| **FLAG-16** | COULD: a "Skip ahead 10s" time warp, if the injected Clock is a shared offset clock used by both the simulated engine and the reconciler. | Engine, Time & Concurrency |

---

## 16. MUST / SHOULD / COULD / WON'T summary (Operator UX)

**MUST** (about 75 minutes)
- The desk layout.
- Top bar with the live indicator and server start time.
- Summary tiles as filters.
- The grouped triage queue with Age, Status + who, and Next.
- The drawer: hero, **What happens next**, state-aware action bar, text attempt list, history with actor icons, ghost entries and restart markers.
- The create dialog with the eligibility line, zero warning and simulation scenario selects.
- The offer dialog with the pending explanation and the exclusion override.
- The recovery panel.
- The 409 banner.
- Offline banner, restart toast and timeline marker.
- The policy panel.
- The simulation dock (reset, auto-respond, never-return rate, availability) and the drawer simulation box (respond as contributor, force-answer).
- The basic contributors list.
- Empty and loading states and a11y basics.
- The `recommend()` and `eventSentence()` pure functions with unit tests.

**SHOULD**
- Mini attempt timeline.
- Engine health tile.
- High-priority alert line.
- Row progress bars.
- Activity feed.
- Contributor load and declines detail.
- Keyboard N/J/K/Enter/Esc/?.
- URL state.
- Dialog pre-warning on version change.
- "+N earlier" path compression.

**COULD**
- "Use this suggestion →" on ghost entries.
- Withdraw & re-offer as one action.
- "Already agreed" direct accept.
- Change expertise & re-route.
- Separate offers table.
- Text search.
- Contributor click-to-filter.
- Route 4 tasks at once.
- Skip ahead 10s.
- Downtime band on the timeline.
- O/R shortcuts.

**WON'T** (state in the README's intentional omissions)
- Authentication and per-operator identity (every operator action is "You").
- Mobile layout and dark mode.
- Contributor CRUD and editing tasks after creation.
- Changing priority mid-routing.
- Pagination (the demo has fewer than 50 tasks).
- Notifications, email or sound.
- A restart button in the UI.
- Persisting form drafts across refresh.
- Internationalisation.
- Charts beyond the attempt timeline.
