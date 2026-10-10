# Agentic development setup

> Draft from the session's facts. **Author: edit into your own words and add what worked / what you'd change.**

- **Tool:** Claude Code (CLI), run from the project directory. Model(s): as recorded in the session transcripts.
- **Planning:** a background multi-agent workflow — 5 parallel dimension planners, 2 critics, 1 synthesizer — produced
  `PLAN.md`; the main agent then reviewed it against the brief before any code was written.
- **Context handoff:** `CLAUDE.md` (glossary, rules R1–R13, never-do list) and `PLAN.md` (§15 amendments win).
- **Guardrails the agent had to satisfy:** `npm run check` (typecheck + tests) as the definition of done; a test harness
  that checks every invariant after every simulated half-second; an architecture test (no `sim_` access outside the
  simulator, no wall clock, no timers outside `main.ts`); a seeded random-walk test.
- **Checking the checks:** a mutation check — deliberately breaking the fencing rule, the deadline rule and the pick
  re-check and confirming the suite fails each time.
- **UI verification:** a scripted headless Chrome (playwright-core against the installed Chrome, kept outside the repo)
  clicked through the use cases, a real server restart and a two-tab conflict; screenshots were reviewed and led to
  fixes (`docs/CORRECTIONS.md` C-4). Later this became a committed Playwright suite (`npm run test:e2e`, 16 tests) that
  runs in CI.
- **Subagents:** used for planning (workflow), read-only reviews, and three focused delegations later on:
  - two **design-research** agents (read-only; headless-Chrome screenshots of real product UIs and terac.com; a static
    mock of the proposed direction) whose findings set the visual language (`docs/DECISIONS.md` D15);
  - one **test-writing** agent with hard rules: never touch `src/`, never weaken a test, keep a test that exposes a bug
    failing and report it with a diagnosis. It added ~980 cases (state × command matrix, presets, recovery, API, units)
    and surfaced three real bugs, which the main agent fixed in `src/` (`docs/CORRECTIONS.md` C-7).
  Code in `src/` had one writer at a time; delegated agents worked in separate files or read-only.
- **Integrations:** none used for the build. [Author: note any MCP servers/settings you disabled or changed.]
- **What worked / what I'd change:** [author]
