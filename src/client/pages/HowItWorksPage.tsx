// "How routing works": the desk's important choices, stated plainly. Every number is read from the
// server's policy, so this page cannot drift from what is enforced.
import type { ReactNode } from 'react';
import { ArrowRightIcon, FlaskConicalIcon, HandIcon } from 'lucide-react';
import type { Policy } from '../../shared/policy';
import { secs } from '../../shared/format';
import { STATUS, type Display } from '@/lib/copy';
import { PageHeader } from '@/components/AppShell';
import { StatusBadge, Tag } from '@/components/status';

const s = (ms: number) => secs(ms).replace('.0s', 's');

function Flow({ overdueAfterMs }: { overdueAfterMs: number }) {
  const main: Display[] = ['not_routed', 'routing', 'offered', 'assigned', 'in_progress', 'done'];
  return (
    <div className="rounded-xl bg-card p-6 ring-1 ring-border">
      <div className="eyebrow">The lifecycle</div>
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-3">
        {main.map((d, i) => (
          <span key={d} className="flex items-center gap-2">
            <StatusBadge display={d} />
            {i < main.length - 1 && <ArrowRightIcon className="size-3.5 text-[#cfcdc6]" aria-hidden />}
          </span>
        ))}
      </div>
      <div className="mt-5 grid gap-3 text-sm text-ink-2 md:grid-cols-3">
        <p className="flex gap-2">
          <span className="mt-0.5 shrink-0">
            <StatusBadge display="overdue" />
          </span>
          <span>is a label on Routing after {s(overdueAfterMs)}. Nothing changes until the deadline.</span>
        </p>
        <p className="flex gap-2">
          <span className="mt-0.5 shrink-0">
            <StatusBadge display="needs_attention" />
          </span>
          <span>is where automation stops: something happened that a person should decide.</span>
        </p>
        <p className="flex gap-2">
          <span className="mt-0.5 shrink-0">
            <StatusBadge display="cancelled" />
          </span>
          <span>is possible from anywhere before Done, and is final.</span>
        </p>
      </div>
    </div>
  );
}

export function HowItWorksPage({ policy }: { policy: Policy }) {
  const d = policy.requestDeadlineMs;
  const w = policy.expectedWindowMs;
  const rules: { title: string; body: ReactNode }[] = [
    {
      title: 'Routing',
      body: (
        <>
          When you route a task, we send the engine the task and every contributor who has the expertise, is available, has spare capacity, and hasn’t already declined, let an offer expire, or dropped out of{' '}
          <em>this</em> task. If that’s nobody, we don’t call the engine; the task comes straight to you.
        </>
      ),
    },
    {
      title: 'Waiting',
      body: (
        <>
          Most answers arrive in <b>{s(w.min)}–{s(w.max)}</b>. A few come later, and some never come. Nothing tells us which. After <b>{s(policy.overdueAfterMs)}</b> we mark a request <b>Overdue</b>: a label, not a verdict.
        </>
      ),
    },
    {
      title: 'Retrying',
      body: (
        <>
          With still no answer at <b>{s(d.high)}</b> (High), <b>{s(d.normal)}</b> (Normal) or <b>{s(d.low)}</b> (Low), we stop waiting and send a fresh request, up to <b>{policy.retriesPerRound} retries</b>. Then the task comes to
          you. High priority waits <em>less</em>, because we’re less willing to sit on a request that may never answer. You always see the countdown first.
        </>
      ),
    },
    { title: 'You can step in at any time', body: <>Offer to someone, route again, stop routing, revoke an offer, release an assignment, or cancel. Your action wins over anything still pending.</> },
    {
      title: 'Late answers',
      body: (
        <>
          If the engine answers a request we’ve stopped waiting for, we record what it suggested and show it to you. <b>We never apply it.</b> You can adopt the suggestion with one click.
        </>
      ),
    },
    {
      title: 'People, not timeouts, need you',
      body: (
        <>
          When a contributor declines, doesn’t reply within <b>{s(policy.offerTtlMs)}</b> (compressed for this demo; hours in real life), or drops out before starting, we <b>don’t</b> re-route automatically: their reason might
          change what you do. That person is skipped by engine routing for this task, but you can still offer it to them. The engine’s “no match” also comes to you, because asking again would get the same answer.
        </>
      ),
    },
    { title: 'One assignee', body: <>A task has at most one active offer or assignee; the database itself refuses a second one. Once someone accepts, routing is done. Reopening it is your decision.</> },
    {
      title: 'Restarts and refreshes',
      body: <>Every deadline is saved in the database, not held in memory. Anything that came due while the server was down is enforced the moment it starts, before it accepts any request, and the activity says so. Refreshing the page loses nothing.</>,
    },
    { title: 'Conflicts', body: <>If a task changes while you’re deciding, your action isn’t applied. We show you what changed so you can decide again.</> },
  ];
  const legend: Display[] = ['not_routed', 'routing', 'overdue', 'offered', 'assigned', 'in_progress', 'needs_attention', 'done', 'cancelled'];

  return (
    <div className="space-y-5">
      <PageHeader eyebrow={<Tag>How it works</Tag>} title="How routing works" description="The rules this desk follows. Every number on this page is read from the server’s policy, the same values it enforces." />

      <Flow overdueAfterMs={policy.overdueAfterMs} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <ol className="divide-y rounded-xl bg-card px-6 ring-1 ring-border">
          {rules.map((r, i) => (
            <li key={r.title} className="grid grid-cols-[2.25rem_1fr] gap-2 py-5">
              <span className="num pt-0.5 font-mono text-sm font-medium text-brand">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{r.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-2 [&_b]:font-semibold [&_b]:text-foreground">{r.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="space-y-5">
          <div className="rounded-xl bg-card ring-1 ring-border">
            <div className="border-b px-5 py-4">
              <div className="text-sm font-medium">Statuses</div>
              <div className="text-xs text-muted-foreground">What each label on the board means.</div>
            </div>
            <dl className="divide-y">
              {legend.map((k) => (
                <div key={k} className="grid grid-cols-[124px_1fr] items-start gap-3 px-5 py-3">
                  <dt>
                    <StatusBadge display={k} />
                  </dt>
                  <dd className="text-[13px] leading-snug text-ink-2">{STATUS[k].meaning}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="sim-hatch rounded-xl border border-dashed border-sim-border p-5">
            <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-[0.06em] text-sim-foreground uppercase">
              <FlaskConicalIcon className="size-3.5 text-sim" /> Simulation · outside world
            </div>
            <p className="mt-2 text-sm leading-relaxed text-sim-foreground/85">
              Violet, hatched controls stand in for the routing engine and the contributors. They are not operator actions, and they never reveal whether a request will answer: a slow request and one that will never return look
              exactly the same to the desk.
            </p>
          </div>

          <div className="rounded-xl bg-[#fff3f1] p-5 ring-1 ring-[#f6c7c2]">
            <div className="flex items-center gap-1.5 text-sm font-medium text-[#be222a]">
              <HandIcon className="size-4" /> When it’s your call
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-[#7d1418]">A decline, an offer nobody answered, a fall-through before work starts, “no match”, or retries used up. The task stops and waits for you, with the reason and who can take it.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
