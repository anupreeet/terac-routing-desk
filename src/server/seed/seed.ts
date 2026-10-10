// Demo data. Seeded history is produced by REPLAYING THE REAL COMMANDS under a backdated fake
// clock, so every line in a seeded timeline is exactly what the system itself writes. After the
// replay, two live tasks are started with the real simulator so the board is moving on first load.
import type { AppCore } from '../app';
import { createDesk } from '../commands/desk';
import { FakeClock } from '../infra/clock';
import { silentLogger } from '../infra/log';
import { checkInvariants } from '../infra/invariants';
import { SpyChannel, SpyEngine } from '../engine/port';
import { createRepo } from '../store/repo';
import type { Priority, ContributorAction } from '../../shared/policy';
import { plural } from '../../shared/format';

const S = 1_000;
const M = 60 * S;

export const EXPERTISE = [
  { id: 'finance', label: 'Finance' },
  { id: 'healthcare', label: 'Healthcare' },
  { id: 'data_analysis', label: 'Data analysis' },
  { id: 'operations', label: 'Operations' },
  { id: 'regulatory', label: 'Regulatory affairs' }, // deliberately nobody: demonstrates "no eligible contributors"
] as const;

export const CONTRIBUTORS = [
  { id: 1, name: 'Priya Raman', headline: 'Former revenue-cycle director, 400-bed hospital system', expertise: ['healthcare', 'data_analysis'], maxActive: 2 },
  { id: 2, name: 'Marcus Chen', headline: 'Ex-sell-side analyst, software & fintech', expertise: ['finance'], maxActive: 2 },
  { id: 3, name: 'Amara Okafor', headline: 'Clinical pharmacist, oncology', expertise: ['healthcare'], maxActive: 1 },
  { id: 4, name: 'Diego Fernández', headline: 'Former supply-chain finance lead, consumer goods', expertise: ['operations', 'finance'], maxActive: 2 },
  { id: 5, name: 'Lena Fischer', headline: 'Biostatistician, clinical trials', expertise: ['data_analysis'], maxActive: 1 },
  { id: 6, name: 'Kenji Watanabe', headline: 'Warehouse automation consultant', expertise: ['operations'], maxActive: 2 },
  { id: 7, name: 'Fatima Al-Sayed', headline: 'Credit-risk modeller, SME lending', expertise: ['finance', 'data_analysis'], maxActive: 3 },
  { id: 8, name: 'Sofia Rossi', headline: 'Hospital operations manager', expertise: ['healthcare', 'operations'], maxActive: 2 },
] as const;

type Who = (typeof CONTRIBUTORS)[number]['id'];

interface TaskSpec {
  key: string;
  title: string;
  expertiseId: string;
  priority: Priority;
  requestedBy: string;
  brief: string;
}

/** Seed a freshly reset database. Throws (loudly) if the result breaks any invariant. */
export function seedDemo(app: AppCore, now: number): void {
  const sql = app.sql;
  const repo = createRepo(sql);
  const clock = new FakeClock(now);
  // A private desk for the replay: same database and rules, a clock we control, and an engine that
  // never answers on its own (the script delivers every answer explicitly).
  const desk = createDesk({ sql, clock, engine: new SpyEngine(), channel: new SpyChannel(), log: silentLogger, policy: app.policy });

  sql.tx(() => {
    EXPERTISE.forEach((e, i) => repo.insertExpertise(e.id, e.label, i));
    for (const c of CONTRIBUTORS) {
      repo.insertContributor({ id: c.id, name: c.name, headline: c.headline, availability: 'available', maxActive: c.maxActive, expertise: [...c.expertise], now: now - 30 * 24 * 60 * M });
    }
  });

  const ids = new Map<string, number>();
  const steps: { at: number; order: number; run: (at: number) => void }[] = [];
  let order = 0;
  const step = (at: number, run: (at: number) => void) => steps.push({ at, order: order++, run });

  const taskId = (key: string) => ids.get(key)!;
  const currentAttempt = (key: string) => {
    const t = repo.getTask(taskId(key))!;
    if (t.currentAttemptId === null) throw new Error(`seed: ${key} has no pending request`);
    return repo.getAttempt(t.currentAttemptId)!;
  };
  const reasonFor = (attemptId: number, who: Who) => {
    const a = repo.getAttempt(attemptId)!;
    const c = a.candidates.find((x) => x.contributorId === who)!;
    const label = repo.expertiseLabel(repo.getTask(a.taskId)!.expertiseId)!;
    return `Lowest current load among ${plural(a.candidates.length, `eligible ${label} contributor`)} (${c.name}: ${c.load} of ${c.maxActive} active).`;
  };

  const create = (spec: TaskSpec, at: number) =>
    step(at, (t) => {
      const task = desk.createTask({ title: spec.title, brief: spec.brief, requestedBy: spec.requestedBy, expertiseId: spec.expertiseId, priority: spec.priority }, {}, t);
      ids.set(spec.key, task.id);
    });
  const submit = (key: string, at: number) =>
    step(at, (t) => desk.command(taskId(key), { type: 'submit', expectedVersion: repo.getTask(taskId(key))!.version }, t));
  const answer = (key: string, at: number, who: Who) =>
    step(at, (t) => {
      const a = currentAttempt(key);
      desk.applyEngineResult(a.id, { kind: 'match', contributorId: who, reason: reasonFor(a.id, who) }, t, t);
    });
  const lateAnswer = (key: string, seq: number, at: number, who: Who) =>
    step(at, (t) => {
      const a = repo.attemptsForTask(taskId(key)).find((x) => x.seq === seq)!;
      desk.applyEngineResult(a.id, { kind: 'match', contributorId: who, reason: reasonFor(a.id, who) }, t, t);
    });
  const respond = (key: string, action: ContributorAction, at: number, note?: string) =>
    step(at, (t) => {
      const asg = repo.activeAssignment(taskId(key)) ?? repo.lastAssignment(taskId(key))!;
      const r = desk.respond(asg.id, action, { note }, t);
      if (!r.ok) throw new Error(`seed: ${key} ${action} refused: ${r.message}`);
    });
  const cancel = (key: string, at: number, note: string) =>
    step(at, (t) => desk.command(taskId(key), { type: 'cancel', expectedVersion: repo.getTask(taskId(key))!.version, note }, t));
  const away = (who: Who, at: number) => step(at, (t) => desk.setAvailability(who, 'away', t));
  const wait = (at: number) => step(at, () => {}); // lets the scheduler enforce deadlines at exactly this time

  const N = now;

  // T-101 · routine, completed
  const t101 = N - 190 * M;
  create({ key: '101', title: 'Expert call: revenue-cycle software adoption in mid-size hospitals', expertiseId: 'healthcare', priority: 'normal', requestedBy: 'Northwind Health Partners · Strategy', brief: '60-minute call with a former hospital revenue-cycle leader on how mid-size systems evaluate and roll out RCM software.' }, t101);
  submit('101', t101);
  answer('101', t101 + 9_200, 1);
  respond('101', 'accept', t101 + 45 * S);
  respond('101', 'start', t101 + 10 * M);
  respond('101', 'complete', t101 + 60 * M);

  // T-102 · first request lost, retry matched, late answer to #1 recorded and ignored; in progress
  const t102 = N - 150 * M;
  create({ key: '102', title: 'Review the feature set of an SME credit-default model', expertiseId: 'finance', priority: 'high', requestedBy: 'Northgate Lending · Credit', brief: 'Independent review of the 40 input features in a small-business default model before a regulator walk-through.' }, t102);
  submit('102', t102);
  wait(t102 + 30 * S); // request #1 times out; #2 is sent automatically
  answer('102', t102 + 41_300, 7);
  lateAnswer('102', 1, t102 + 47 * S, 2);
  respond('102', 'accept', t102 + 80 * S);
  respond('102', 'start', t102 + 15 * M);

  // T-103 · assigned, not started
  const t103 = N - 120 * M;
  create({ key: '103', title: 'Map last-mile delivery operations for a regional grocer', expertiseId: 'operations', priority: 'normal', requestedBy: 'Halcyon Capital · Consumer', brief: 'Walk through route density, store-pick vs dark-store fulfilment, and driver utilisation for a 120-store grocer.' }, t103);
  submit('103', t103);
  answer('103', t103 + 7_800, 4);
  respond('103', 'accept', t103 + 50 * S);

  // T-104 · declined → needs attention (recovery demo)
  const t104 = N - 100 * M;
  create({ key: '104', title: 'Clean and summarise a 40k-row insurance claims extract', expertiseId: 'data_analysis', priority: 'normal', requestedBy: 'Meridian Bio · Market access', brief: 'De-duplicate, code and summarise a claims extract into a short memo on utilisation by plan type.' }, t104);
  submit('104', t104);
  answer('104', t104 + 8 * S, 1);
  respond('104', 'decline', t104 + 42 * S, 'Conflict: I advise a competitor of this insurer.');

  // T-105 · three requests, no answer → needs attention; a late answer to #3 arrives as advice
  const t105 = N - 90 * M;
  create({ key: '105', title: 'Oncology pharmacist interview: biosimilar switching', expertiseId: 'healthcare', priority: 'high', requestedBy: 'Meridian Bio · Market access', brief: 'How hospital pharmacy committees decide when to switch oncology patients to biosimilars.' }, t105);
  submit('105', t105);
  wait(t105 + 30 * S);
  wait(t105 + 60 * S);
  wait(t105 + 90 * S);
  lateAnswer('105', 3, t105 + 142 * S, 3);

  // T-106 · accepted, then withdrew before starting → needs attention
  const t106 = N - 80 * M;
  create({ key: '106', title: 'Benchmark warehouse-automation vendors for a 3PL', expertiseId: 'operations', priority: 'low', requestedBy: 'Halcyon Capital · Industrials', brief: 'Compare four AMR vendors on cost per pick, integration effort and uptime guarantees.' }, t106);
  submit('106', t106);
  answer('106', t106 + 12 * S, 6);
  respond('106', 'accept', t106 + 55 * S);
  respond('106', 'withdraw', t106 + 20 * M, 'Travelling for two weeks; I can no longer take this on.');
  away(6, t106 + 20 * M + 1 * S);

  // T-107 · in progress (puts Lena at capacity, 1/1)
  const t107 = N - 70 * M;
  create({ key: '107', title: 'Statistical review of a phase II trial readout', expertiseId: 'data_analysis', priority: 'high', requestedBy: 'Meridian Bio · Clinical', brief: 'Sanity-check the primary endpoint analysis and multiplicity handling before the board meeting.' }, t107);
  submit('107', t107);
  answer('107', t107 + 6_100, 5);
  respond('107', 'accept', t107 + 40 * S);
  respond('107', 'start', t107 + 5 * M);

  // T-108 · offered, then cancelled by the operator
  const t108 = N - 60 * M;
  create({ key: '108', title: 'EU payments pricing survey (10 interviews)', expertiseId: 'finance', priority: 'low', requestedBy: 'Northgate Lending · Strategy', brief: 'Ten 30-minute interviews with payments product leads on interchange pass-through pricing.' }, t108);
  submit('108', t108);
  answer('108', t108 + 9 * S, 2);
  cancel('108', t108 + 30 * S, 'Client paused the project.');

  // Not routed yet: ready for the live demo
  create({ key: '109', title: 'Expert call: hedge accounting at a mid-cap airline', expertiseId: 'finance', priority: 'normal', requestedBy: 'Northgate Lending · Credit', brief: 'How a treasury team documents fuel hedges for hedge-accounting treatment.' }, N - 10 * M);
  create({ key: '110', title: 'Clinician panel: remote patient-monitoring reimbursement', expertiseId: 'healthcare', priority: 'high', requestedBy: 'Meridian Bio · Market access', brief: 'Three clinicians on how RPM billing codes changed their programme economics.' }, N - 8 * M);
  create({ key: '111', title: 'EU MDR pathway for a glucose-monitoring wearable', expertiseId: 'regulatory', priority: 'normal', requestedBy: 'Halcyon Capital · Medtech', brief: 'Classification and notified-body timeline under EU MDR for a CGM wearable.' }, N - 6 * M);

  // Run every step in time order, letting deadlines fire exactly as the real scheduler would.
  steps.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const s of steps) {
    clock.set(s.at);
    desk.enforceDeadlines(s.at);
    s.run(s.at);
  }
  desk.enforceDeadlines(N);

  const unsettled = repo.listTasks().filter((t) => t.status === 'routing' || t.status === 'offered');
  if (unsettled.length) throw new Error(`seed left tasks in flight: ${unsettled.map((t) => `T-${t.id}:${t.status}`).join(', ')}`);
  const violations = checkInvariants(sql, app.policy);
  if (violations.length) throw new Error(`seed broke invariants: ${JSON.stringify(violations, null, 2)}`);

  // Demo presets: T-104's "Route again" resolves quickly in a live demo.
  app.sim?.setScenario(taskId('104'), 'quick_match', 'manual');

  // Two live tasks, started now with the real simulator, so the board moves on first load.
  if (app.sim) {
    const sim = app.sim;
    app.desk.createTask(
      { title: 'Adverse-event signal review for a GLP-1 launch', expertiseId: 'healthcare', priority: 'high', requestedBy: 'Meridian Bio · Safety', brief: 'Pharmacovigilance view on early adverse-event signals in the first 90 days after launch.' },
      { submit: true, onCreated: (id) => sim.setScenario(id, 'lost_always', 'manual') },
      now,
    );
    app.desk.createTask(
      { title: 'Q3 revenue variance review for a SaaS portfolio company', expertiseId: 'finance', priority: 'normal', requestedBy: 'Halcyon Capital · Software', brief: 'Walk the CFO bridge from plan to actual and flag one-offs.' },
      { submit: true, onCreated: (id) => sim.setScenario(id, 'quick_match', 'manual') },
      now,
    );
  }
  // Written last: without it, the next start treats the database as half-seeded and starts over.
  repo.setMeta('seeded_at', String(now));
}
