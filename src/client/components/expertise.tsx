// Expertise areas get an icon and a colour. The colour only ever appears in the icon tile, never as a
// filled chip, so it can't be confused with a status.
import { BriefcaseIcon, ChartScatterIcon, HeartPulseIcon, LandmarkIcon, ScaleIcon, WorkflowIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const AREAS: Record<string, { icon: LucideIcon; tile: string; fg: string }> = {
  finance: { icon: LandmarkIcon, tile: 'bg-[#06915f]/12', fg: 'text-[#06915f]' },
  healthcare: { icon: HeartPulseIcon, tile: 'bg-[#d14186]/12', fg: 'text-[#d14186]' },
  data_analysis: { icon: ChartScatterIcon, tile: 'bg-[#0085bc]/12', fg: 'text-[#0085bc]' },
  operations: { icon: WorkflowIcon, tile: 'bg-[#dd6f23]/12', fg: 'text-[#dd6f23]' },
  regulatory: { icon: ScaleIcon, tile: 'bg-[#908126]/14', fg: 'text-[#7d7020]' },
};
const FALLBACK = { icon: BriefcaseIcon, tile: 'bg-[#a19d92]/15', fg: 'text-[#57554f]' };

export const areaStyle = (id: string) => AREAS[id] ?? FALLBACK;

export function ExpertiseTile({ id, size = 'md', className }: { id: string; size?: 'sm' | 'md'; className?: string }) {
  const a = areaStyle(id);
  const Icon = a.icon;
  return (
    <span className={cn('grid shrink-0 place-items-center', size === 'sm' ? 'size-5 rounded-[5px] [&_svg]:size-3' : 'size-8 rounded-lg [&_svg]:size-4', a.tile, a.fg, className)} aria-hidden>
      <Icon />
    </span>
  );
}

/** Icon + label, no fill. */
export function ExpertiseChip({ id, label, className }: { id: string; label: string; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-ink-2', className)}>
      <ExpertiseTile id={id} size="sm" />
      {label}
    </span>
  );
}
