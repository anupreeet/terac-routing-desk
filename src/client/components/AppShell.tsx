// The frame around every page: sidebar navigation, page header, connection state.
import { useEffect, useRef, type ReactNode } from 'react';
import { BookOpenIcon, FlaskConicalIcon, HistoryIcon, InboxIcon, PlusIcon, UsersIcon, WaypointsIcon, WifiOffIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { SnapshotDto } from '../../shared/schemas';
import { clockTime, duration } from '../../shared/format';
import type { Page } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';

export const PAGE_TITLE: Record<Page, string> = { tasks: 'Tasks', activity: 'Activity', contributors: 'Contributors', 'how-it-works': 'How routing works' };

// The active item is a raised white pill with a blue icon; everything else sits on the paper.
const navButton =
  'h-9 rounded-lg text-[13.5px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-foreground data-[active=true]:bg-white data-[active=true]:text-foreground data-[active=true]:shadow-[0_1px_2px_rgb(27_27_23/0.08),0_0_0_1px_rgb(27_27_23/0.06)] data-[active=true]:[&>svg]:text-brand';

export function AppSidebar({ page, onNavigate, snapshot, offlineSince, now, onOpenSimulation }: { page: Page; onNavigate: (p: Page) => void; snapshot?: SnapshotDto; offlineSince: number | null; now: number; onOpenSimulation: () => void }) {
  const attention = snapshot?.counts.attention ?? 0;
  const nav: { page: Page; icon: ReactNode; badge?: ReactNode }[] = [
    {
      page: 'tasks',
      icon: (
        <>
          <InboxIcon />
          {/* Collapsed to icons, the count still shows: as a dot-badge on the icon. */}
          {attention > 0 && (
            <span className="absolute top-1 right-1 hidden min-w-3.5 rounded-full bg-[#e5484d] px-0.5 text-center font-mono text-[9px] leading-3.5 font-semibold text-white group-data-[collapsible=icon]:block" aria-hidden>
              {attention > 9 ? '9+' : attention}
            </span>
          )}
        </>
      ),
      badge: attention > 0 ? <span className="rounded-full bg-[#e5484d] px-1.5 font-mono text-[11px] leading-5 font-medium text-white">{attention}</span> : null,
    },
    { page: 'activity', icon: <HistoryIcon /> },
    { page: 'contributors', icon: <UsersIcon />, badge: snapshot ? <span className="font-mono text-[11px] text-muted-foreground">{snapshot.contributors.length}</span> : null },
    { page: 'how-it-works', icon: <BookOpenIcon /> },
  ];
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            {/* The product mark, not a control: a div, so it isn't a Tab stop that does nothing. */}
            <SidebarMenuButton asChild size="lg" className="pointer-events-none gap-2.5">
              <div>
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(31_44_244/0.35)]">
                  <WaypointsIcon className="size-4" />
                </span>
                <span className="grid leading-tight">
                  <span className="truncate text-[14px] font-semibold tracking-tight text-foreground">Routing Desk</span>
                  <span className="truncate text-xs text-muted-foreground">Terac operations</span>
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {nav.map((n) => (
                <SidebarMenuItem key={n.page}>
                  <SidebarMenuButton
                    isActive={page === n.page}
                    tooltip={n.page === 'tasks' && attention > 0 ? `${PAGE_TITLE.tasks} · ${attention} need${attention === 1 ? 's' : ''} you` : PAGE_TITLE[n.page]}
                    onClick={() => onNavigate(n.page)}
                    className={cn(navButton, 'relative')}
                  >
                    {n.icon}
                    <span>{PAGE_TITLE[n.page]}</span>
                  </SidebarMenuButton>
                  {n.badge && <SidebarMenuBadge className="top-2">{n.badge}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel className="eyebrow">Outside world</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Simulation controls"
                  onClick={onOpenSimulation}
                  className="sim-hatch h-9 rounded-lg border border-dashed border-sim-border text-[13.5px] font-medium text-sim-foreground hover:text-sim-foreground hover:brightness-[0.98] [&>svg]:text-sim"
                >
                  <FlaskConicalIcon />
                  <span>Simulation controls</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="pb-4">
        <Connection snapshot={snapshot} offlineSince={offlineSince} now={now} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function Connection({ snapshot, offlineSince, now }: { snapshot?: SnapshotDto; offlineSince: number | null; now: number }) {
  const offline = offlineSince !== null;
  const restarted = snapshot?.lastBoot?.offlineMs != null;
  const label = offline ? `Offline · ${duration(now - offlineSince!)}` : snapshot ? 'Live' : 'Connecting…';
  return (
    <>
      {/* Collapsed to icons: the connection state as a dot, named in a tooltip. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} role="status" aria-label={`Connection: ${label}`} className="mx-auto hidden size-8 place-items-center rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-data-[collapsible=icon]:grid">
            {offline ? <WifiOffIcon className="size-4 text-[#be222a]" /> : <span className={cn('size-2 rounded-full', snapshot ? 'bg-[#0c9b5a]' : 'bg-[#cfcdc6]')} />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <ConnectionDetail snapshot={snapshot} offlineSince={offlineSince} now={now} restarted={restarted} label={label} />
    </>
  );
}

function ConnectionDetail({ snapshot, offlineSince, now, restarted, label }: { snapshot?: SnapshotDto; offlineSince: number | null; now: number; restarted: boolean; label: string }) {
  const offline = offlineSince !== null;
  return (
    <div className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2" aria-hidden>
          {!offline && snapshot && <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#0c9b5a] opacity-50" />}
          <span className={cn('relative inline-flex size-2 rounded-full', offline ? 'bg-[#e5484d]' : snapshot ? 'bg-[#0c9b5a]' : 'bg-[#cfcdc6]')} />
        </span>
        <span className={cn('font-medium', offline ? 'text-[#be222a]' : 'text-ink-2')}>{label}</span>
        {snapshot && !offline && <span className="num font-mono">server up {clockTime(snapshot.bootedAt).slice(0, 5)}</span>}
      </div>
      {restarted && !offline && snapshot && <p className="num mt-1 pl-4">Restarted {duration(now - snapshot.bootedAt)} ago</p>}
    </div>
  );
}

export function SiteHeader({ page, onNewTask, offline }: { page: Page; onNewTask: () => void; offline: boolean }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/85 px-4 backdrop-blur-md md:px-6">
      <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList className="text-[13.5px]">
          <BreadcrumbItem className="hidden sm:inline-flex">Desk</BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:inline-flex">/</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage className="font-medium">{PAGE_TITLE[page]}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-3">
        {offline && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#ffedeb] px-2.5 py-1 text-xs font-medium text-[#be222a]">
            <WifiOffIcon className="size-3.5" /> Offline
          </span>
        )}
        <Button onClick={onNewTask} disabled={offline} className="h-9 rounded-lg px-3.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(31_44_244/0.3)]">
          <PlusIcon data-icon="inline-start" /> New task
          <Kbd className="ml-1 hidden h-5 min-w-5 bg-white/20 font-mono text-[11px] text-white sm:inline-flex">N</Kbd>
        </Button>
      </div>
    </header>
  );
}

export function OfflineBanner({ offlineSince, now }: { offlineSince: number; now: number }) {
  return (
    <div className="px-4 pt-4 md:px-8">
      <div role="alert" className="flex items-start gap-3 rounded-xl bg-[#ffedeb] px-4 py-3 text-sm text-[#7d1418]">
        <WifiOffIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" />
        <div>
          <p className="font-medium text-[#be222a]">
            Can’t reach the desk server since {clockTime(offlineSince)} ({duration(now - offlineSince)})
          </p>
          <p className="mt-0.5">You’re seeing the last known state. Deadlines are stored on the server and are enforced as soon as it’s running again. Actions are paused until we reconnect.</p>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: ReactNode; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow}
        <h1 className={cn('font-heading text-[28px] leading-[1.15] font-semibold tracking-[-0.035em] text-balance', eyebrow ? 'mt-3' : undefined)}>{title}</h1>
        <p className="mt-1.5 max-w-2xl text-[15px] text-ink-2">{description}</p>
      </div>
      {actions}
    </div>
  );
}

/** Announces once when the server's boot id changes under an open page (a real restart, not a demo reset). */
export function useRestartNotice(snapshot?: SnapshotDto) {
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    if (seen.current && seen.current !== snapshot.bootId && snapshot.lastBoot && snapshot.lastBoot.offlineMs !== null) {
      toast.info('The desk server restarted', {
        description: `${snapshot.lastBoot.summary} Requests sent before the restart may still answer; an answer to a request we’ve moved past is recorded, not applied.`,
        duration: 12_000,
      });
    }
    seen.current = snapshot.bootId;
  }, [snapshot?.bootId, snapshot?.lastBoot]);
}
