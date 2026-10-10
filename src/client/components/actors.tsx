// Who did something: the operator, the engine, the system on its own, a contributor, or the simulation.
import { BotIcon, CogIcon, FlaskConicalIcon, UserIcon, UserRoundIcon } from 'lucide-react';
import type { EventDto } from '../../shared/schemas';
import { cn } from '@/lib/utils';

type Actor = EventDto['actor'];

export const ACTOR: Record<Actor, { label: string; chip: string }> = {
  operator: { label: 'Operator', chip: 'border-brand/30 bg-brand-soft text-brand-strong' },
  engine: { label: 'Engine', chip: 'border-sky-200 bg-sky-50 text-sky-700' },
  system: { label: 'System', chip: 'border-border bg-muted text-muted-foreground' },
  contributor: { label: 'Contributor', chip: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  simulator: { label: 'Simulation', chip: 'border-sim-border bg-sim-muted text-sim-foreground' },
};

const ICON: Record<Actor, typeof BotIcon> = { operator: UserRoundIcon, engine: BotIcon, system: CogIcon, contributor: UserIcon, simulator: FlaskConicalIcon };

export function ActorIcon({ actor, chip, ghost, className }: { actor: Actor; chip?: boolean; ghost?: boolean; className?: string }) {
  const Icon = ICON[actor];
  if (!chip) return <Icon className={className} aria-hidden />;
  return (
    <span className={cn('relative z-10 grid size-7 shrink-0 place-items-center rounded-full border [&_svg]:size-3.5', ghost ? 'border-dashed bg-background text-muted-foreground' : ACTOR[actor].chip, className)} title={ACTOR[actor].label}>
      <Icon aria-hidden />
    </span>
  );
}
