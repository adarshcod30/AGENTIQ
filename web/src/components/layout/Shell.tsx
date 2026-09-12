/**
 * The application shell: docs/04_App_UI.md §5.
 *
 * TWO NAVIGATION GROUPS (docs/03_App_Flow.md A1):
 *
 *   WORK   Dashboard · Test Runner · Security · Specs · API Client · History · Deploy
 *   TRUST  Tool Registry · Audit Log · About
 *
 * The TRUST group is not filler. It is where anyone goes to check whether the
 * architecture claim is real, and putting it in the primary navigation says the
 * product expects to be checked.
 *
 * THE TOPBAR CARRIES NO DECORATIVE BADGES. A static "Agents Online" chip asserts
 * something nothing ever checked. The only status shown here is the LLM
 * provider, derived from /api/health.
 */
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, PlayCircle, ShieldCheck, FileJson, ArrowLeftRight,
  History, UploadCloud, Wrench, ScrollText, Info, Plus, Menu, Settings, FolderGit2,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { apiGet } from '@/services/api';
import { VerifyBanner } from './VerifyBanner';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui';
import { Wordmark } from '@/components/Brand';
import type { HealthStatus } from '@/types';

const WORK = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/run', label: 'Test Runner', icon: PlayCircle },
  { to: '/security', label: 'Security', icon: ShieldCheck },
  { to: '/specs', label: 'Specs', icon: FileJson },
  { to: '/client', label: 'API Client', icon: ArrowLeftRight },
  { to: '/history', label: 'History', icon: History },
  { to: '/deploy', label: 'Deploy', icon: UploadCloud },
];

const TRUST = [
  { to: '/tools', label: 'Tool Registry', icon: Wrench },
  { to: '/audit', label: 'Audit Log', icon: ScrollText },
  { to: '/about', label: 'About', icon: Info },
];

const ACCOUNT = [
  { to: '/settings', label: 'Settings', icon: Settings },
];

function NavGroup({ title, items, onNavigate }: {
  title: string;
  items: typeof WORK;
  onNavigate?: () => void;
}) {
  return (
    <div className="px-3 py-2">
      <div className="t-label px-2 pb-1.5">{title}</div>
      <nav className="space-y-0.5">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to} to={to} onClick={onNavigate}
            className={({ isActive }) => cn(
              'flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-[13px] transition-colors',
              // Active: primary-50 fill, 2px primary left rule, primary text (§5).
              isActive
                ? 'border-l-2 border-primary bg-primary-50 pl-1.5 font-medium text-primary'
                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** The one status chip in the product, and it is derived from real state. */
function ProviderChip() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<HealthStatus>('/health'),
    refetchInterval: 60_000,
    retry: false,
  });

  if (!data) return null;

  /**
   * The RESOLVED chain, not the first configured entry in array order.
   *
   * This used to read `llmProviders.find(p => p.configured)`, which returned
   * whichever provider happened to be first in the array. With both configured
   * it displayed "groq · fallback" while Bedrock was actually answering every
   * request: the chip contradicted reality, which is worse than showing
   * nothing. /api/health now reports the order providerOrder() will really use.
   */
  const [primary, ...rest] = data.llmChain?.order ?? [];

  if (!primary) {
    return <span className="t-small text-danger">no LLM provider configured</span>;
  }

  return (
    <span className="t-small text-ink-subtle" title={rest.length ? `falls back to ${rest.join(', ')}` : 'no fallback configured'}>
      {primary} · primary
      {/* A chain with nothing to fall back to is worth seeing at a glance. */}
      {rest.length === 0 && <span className="text-warning"> · no fallback</span>}
    </span>
  );
}

export function Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { user } = useAuthStore();
  const { pathname } = useLocation();
  const title = [...WORK, ...TRUST].find((i) => pathname.startsWith(i.to))?.label ?? 'AGENTIQ';

  return (
    <div className="min-h-screen bg-surface-2">
      {/* Sidebar: 240px, white, right border. Drawer below 1024. */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-60 border-r border-line bg-surface',
          'flex flex-col transition-transform lg:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center border-b border-line px-4">
          <Wordmark markSize={26} />
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <NavGroup title="Work" items={WORK} onNavigate={() => setDrawerOpen(false)} />
          <div className="mx-3 my-1 border-t border-line" />
          <NavGroup title="Trust" items={TRUST} onNavigate={() => setDrawerOpen(false)} />
          <div className="mx-3 my-1 border-t border-line" />
          <NavGroup title="Account" items={ACCOUNT} onNavigate={() => setDrawerOpen(false)} />
        </div>

        <div className="border-t border-line px-4 py-2.5">
          <ProviderChip />
        </div>
      </aside>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-surface/70 sm:px-6">
          <button
            type="button"
            className="rounded p-1 text-ink-muted hover:bg-surface-2 lg:hidden"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            <Menu size={18} aria-hidden />
          </button>

          <span className="flex-1 truncate text-sm font-semibold">{title}</span>

          <Button size="sm" onClick={() => { window.location.href = '/run'; }}>
            <Plus size={14} aria-hidden /> New run
          </Button>

          {user && (
            <div
              className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-50 text-[11px] font-semibold text-primary"
              title={user.email}
            >
              {user.displayName.slice(0, 2).toUpperCase()}
            </div>
          )}
        </header>

        {/* Directly under the header, above every page. Renders nothing once
            the address is verified. */}
        <VerifyBanner />

        <main className="mx-auto max-w-[1280px] px-6 py-6 xl:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
