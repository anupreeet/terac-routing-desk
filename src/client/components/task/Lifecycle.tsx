// Where the task is in its life: Created → Routing → Offered → Accepted → Working → Done.
// When automation stops, the step where it stopped turns into a red ✕ labelled with the reason.
import { CheckIcon, XIcon } from 'lucide-react';
import type { AttentionReason } from '../../../shared/policy';
import type { TaskRowDto } from '../../../shared/schemas';
import { cn } from '@/lib/utils';

const STEPS = ['Created', 'Routing', 'Offered', 'Accepted', 'Working', 'Done'] as const;

const STOP_LABEL: Record<AttentionReason, string> = {
  no_eligible_contributors: 'Nobody eligible',
  no_match: 'No match',
  routing_exhausted: 'No answer',
  declined: 'Declined',
  offer_expired: 'Expired',
  failed_before_start: 'Fell through',
};

function position(t: TaskRowDto): { at: number; stopped: AttentionReason | null } | null {
  switch (t.status) {
    case 'new':
      return { at: 0, stopped: null };
    case 'routing':
      return { at: 1, stopped: null };
    case 'offered':
      return { at: 2, stopped: null };
    case 'assigned':
      return { at: 3, stopped: null };
    case 'in_progress':
      return { at: 4, stopped: null };
    case 'completed':
      return { at: 5, stopped: null };
    case 'needs_attention': {
      const r = t.attention!.reason;
      const at = r === 'declined' || r === 'offer_expired' ? 2 : r === 'failed_before_start' ? 3 : 1;
      return { at, stopped: r };
    }
    case 'cancelled':
      return null;
  }
}

export function Lifecycle({ t }: { t: TaskRowDto }) {
  const pos = position(t);
  if (!pos) {
    return <p className="font-mono text-xs text-muted-foreground">Cancelled · nothing more happens to this task</p>;
  }
  return (
    <ol className="flex items-start" aria-label="Task lifecycle">
      {STEPS.map((label, i) => {
        const done = i < pos.at || (i === pos.at && t.status === 'completed');
        const current = i === pos.at && !done;
        const stopped = current && pos.stopped !== null;
        return (
          <li key={label} className="relative flex flex-1 flex-col items-center gap-1.5 text-center" aria-current={current ? 'step' : undefined}>
            {i > 0 && (
              <span
                className={cn('absolute top-[11px] right-[calc(50%+16px)] left-[calc(-50%+16px)] h-[2px] rounded-full', i <= pos.at ? (stopped ? 'bg-[#e5484d]' : 'bg-foreground') : 'bg-[#e4e2dc]')}
                aria-hidden
              />
            )}
            <span
              className={cn(
                'relative z-10 grid size-[22px] place-items-center rounded-full [&_svg]:size-3',
                done && 'bg-foreground text-white',
                current && !stopped && 'border-2 border-brand bg-white',
                stopped && 'bg-[#e5484d] text-white shadow-[0_0_0_4px_#ffedeb]',
                !done && !current && 'border-2 border-[#dedcd6] bg-white',
              )}
            >
              {done ? <CheckIcon strokeWidth={3} /> : stopped ? <XIcon strokeWidth={3} /> : current ? <span className="size-2 animate-pulse rounded-full bg-brand" /> : null}
            </span>
            <span className={cn('text-[11px] leading-tight', stopped ? 'font-semibold text-[#be222a]' : current ? 'font-semibold text-foreground' : done ? 'text-ink-2' : 'text-muted-foreground')}>
              {stopped ? STOP_LABEL[pos.stopped!] : label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
