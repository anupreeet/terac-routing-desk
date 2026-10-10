// Small visual primitives shared by every page: status, priority, people, simulation marker.
import type { ReactNode } from 'react';
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ClockAlertIcon,
  FlaskConicalIcon,
  HandIcon,
  LoaderCircleIcon,
  SendIcon,
  UserRoundCheckIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Priority } from '../../shared/policy';
import { PRIORITY, STATUS, type Display, type Tone } from '@/lib/copy';

/** Soft fill + strong text. No borders: the shape and the icon do the work. */
export const TONE: Record<Tone, { pill: string; text: string; solid: string; soft: string }> = {
  red: { pill: 'bg-[#ffedeb] text-[#be222a]', text: 'text-[#be222a]', solid: 'bg-[#e5484d]', soft: 'bg-[#ffedeb]' },
  amber: { pill: 'bg-[#fff0cc] text-[#ab5900]', text: 'text-[#ab5900]', solid: 'bg-[#f5a524]', soft: 'bg-[#fff0cc]' },
  blue: { pill: 'bg-brand-soft text-brand', text: 'text-brand', solid: 'bg-brand', soft: 'bg-brand-soft' },
  cyan: { pill: 'bg-[#dcf8fb] text-[#007283]', text: 'text-[#007283]', solid: 'bg-[#0797a8]', soft: 'bg-[#dcf8fb]' },
  green: { pill: 'bg-[#d9fae3] text-[#00713e]', text: 'text-[#00713e]', solid: 'bg-[#0c9b5a]', soft: 'bg-[#d9fae3]' },
  gray: { pill: 'bg-[#efeeea] text-[#5f5d56]', text: 'text-[#5f5d56]', solid: 'bg-[#a19d92]', soft: 'bg-[#efeeea]' },
  muted: { pill: 'bg-[#f4f4f1] text-[#74716a]', text: 'text-[#74716a]', solid: 'bg-[#cfcdc6]', soft: 'bg-[#f4f4f1]' },
};

const ICON: Record<Display, LucideIcon> = {
  needs_attention: HandIcon,
  overdue: ClockAlertIcon,
  routing: LoaderCircleIcon,
  offered: SendIcon,
  assigned: UserRoundCheckIcon,
  in_progress: CircleDotIcon,
  not_routed: CircleDashedIcon,
  done: CircleCheckIcon,
  cancelled: CircleSlashIcon,
};

export function TonePill({ tone, children, className, icon }: { tone: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0', TONE[tone].pill, className)}>
      {icon}
      {children}
    </span>
  );
}

export function StatusBadge({ display, className }: { display: Display; className?: string }) {
  const s = STATUS[display];
  const Icon = ICON[display];
  return (
    <TonePill tone={s.tone} className={cn(display === 'done' && 'bg-[#efeeea] text-foreground', className)} icon={<Icon className={cn(display === 'routing' && 'animate-spin [animation-duration:2.4s]')} aria-hidden />}>
      {s.label}
    </TonePill>
  );
}

/** Three signal bars, filled up to the level; red when it's high. Readable without colour too. */
export function PriorityIndicator({ priority, showLabel = true, className }: { priority: Priority; showLabel?: boolean; className?: string }) {
  const p = PRIORITY[priority];
  const high = priority === 'high';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', high ? 'font-medium text-foreground' : 'text-ink-2', className)} title={`${p.label} priority`}>
      <svg viewBox="0 0 12 12" className="size-3.5 shrink-0" aria-hidden>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={1 + i * 4} y={8 - i * 3} width="2.5" height={3 + i * 3} rx="0.75" className={i < p.level ? (high ? 'fill-[#e5484d]' : 'fill-[#1b1b17]') : 'fill-[#dedcd6]'} />
        ))}
      </svg>
      {showLabel && p.label}
    </span>
  );
}

// Avatar tints. Violet (simulation) and red (attention) are deliberately absent.
const AVATAR = [
  'bg-[#e0ecff] text-[#1f3fae]',
  'bg-[#d9fae3] text-[#00713e]',
  'bg-[#fff0cc] text-[#8a4a00]',
  'bg-[#dcf8fb] text-[#00646f]',
  'bg-[#ffe9d9] text-[#a3470f]',
  'bg-[#f0f5d6] text-[#5a6b00]',
  'bg-[#fde8f3] text-[#a1306b]',
  'bg-[#e8eef2] text-[#3f5566]',
];

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)![0] : '')).toUpperCase();
}

/** Colour comes from the name, so a person looks the same on every page. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % AVATAR.length;
}

export type Presence = 'available' | 'away' | 'full';

export function PersonAvatar({ name, size = 'md', muted, presence }: { name: string; size?: 'sm' | 'md' | 'lg'; muted?: boolean; presence?: Presence }) {
  const sz = size === 'sm' ? 'size-6 text-[10px]' : size === 'lg' ? 'size-9 text-xs' : 'size-7 text-[11px]';
  const ring =
    presence === 'available'
      ? 'ring-2 ring-[#0c9b5a] ring-offset-2 ring-offset-background'
      : presence === 'full'
        ? 'ring-2 ring-[#f5a524] ring-offset-2 ring-offset-background'
        : presence === 'away'
          ? 'outline-2 outline-dashed outline-offset-2 outline-[#a19d92]'
          : '';
  return (
    <span className={cn('inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-tight', sz, muted ? 'bg-[#efeeea] text-[#a19d92]' : AVATAR[hue(name)], ring)} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Person({ name, sub, muted, presence }: { name: string; sub?: ReactNode; muted?: boolean; presence?: Presence }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar name={name} muted={muted} presence={presence} />
      <span className="min-w-0">
        <span className={cn('block truncate text-sm font-medium', muted && 'text-muted-foreground')}>{name}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}

export function SimBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('sim-hatch inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-sim-border px-1.5 font-mono text-[10px] font-medium tracking-wide text-sim-foreground uppercase [&_svg]:size-3', className)}>
          <FlaskConicalIcon aria-hidden /> Simulated
        </span>
      </TooltipTrigger>
      <TooltipContent>Triggered from a simulation control, standing in for the engine or a contributor.</TooltipContent>
    </Tooltip>
  );
}

/** Mono tag in the brand tint, like terac.com's section labels. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-6 items-center rounded-md bg-brand-soft px-2 font-mono text-xs text-brand', className)}>{children}</span>;
}
