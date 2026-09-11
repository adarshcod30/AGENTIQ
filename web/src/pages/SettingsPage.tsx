/**
 * Settings: docs/04_App_UI.md §7.
 *
 * "Profile, linked auth providers, LLM provider and key status (NEVER render a
 * key, show gsk_••••4f2a), active host grants with revoke."
 *
 * The grants section is the visible counterpart to the permission sheet: what
 * you approved, and a way to take it back.
 */
import { useHealth, useGrants, useRevokeGrant } from '@/hooks/api';
import { useAuthStore } from '@/store/auth';
import {
  Card, CardHeader, CardBody, Button, Chip, RiskChip, EmptyState, Alert, SkeletonRows,
} from '@/components/ui';

export function SettingsPage() {
  const { user, signOut } = useAuthStore();
  const { data: health } = useHealth();
  const { data: grantsData, isLoading } = useGrants();
  const revoke = useRevokeGrant();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="t-h1">Settings</h1>
        <p className="t-small mt-1 text-ink-muted">Profile, providers and active permissions.</p>
      </div>

      <Card>
        <CardHeader title="Profile" />
        <CardBody className="space-y-2 text-[13px]">
          <Row label="Name" value={user?.displayName ?? 'n/a'} />
          <Row label="Email" value={user?.email ?? 'n/a'} mono />
          <Row label="Role" value={user?.role ?? 'user'} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="LLM providers" />
        <CardBody className="space-y-2">
          {health?.llmProviders.map((p) => (
            <div key={p.name} className="flex items-center gap-3 text-[13px]">
              <span className="t-mono w-24">{p.name}</span>
              <Chip className={p.configured ? 'bg-success-50 text-success' : 'bg-surface-3 text-ink-subtle'}>
                {p.configured ? 'configured' : 'not configured'}
              </Chip>
              <span className="t-small text-ink-muted">{p.role}</span>
            </div>
          ))}
          {/* Keys are NEVER rendered, not even masked from the client: the
              server does not send them at all. */}
          <p className="t-small pt-1 text-ink-subtle">
            API keys are held server-side and are never sent to the browser.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Active host grants" />
        <CardBody>
          {isLoading && <SkeletonRows rows={2} />}

          {!isLoading && (grantsData?.grants.length ?? 0) === 0 && (
            <EmptyState
              title="No active grants"
              body="Permissions you approve in the permission sheet appear here, and expire with your session."
            />
          )}

          <div className="space-y-2">
            {grantsData?.grants.map((g, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 rounded-[6px] border border-line p-3">
                <RiskChip riskClass={g.riskClass} />
                <span className="t-mono min-w-0 flex-1 truncate text-[12.5px]">{g.host ?? 'any host'}</span>
                <span className="t-small text-ink-subtle">
                  expires {new Date(g.expiresAt).toLocaleTimeString()}
                </span>
                <Button size="sm" variant="secondary"
                  loading={revoke.isPending}
                  onClick={() => revoke.mutate({ riskClass: g.riskClass, host: g.host ?? undefined })}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>

          <Alert tone="info">
            Grants live only for this session and are never persisted. Audit rows,
            by contrast, are append-only and cannot be revoked.
          </Alert>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Danger zone" />
        <CardBody>
          <Button variant="danger" onClick={signOut}>Sign out</Button>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3">
      <span className="t-label pt-0.5">{label}</span>
      <span className={mono ? 't-mono' : ''}>{value}</span>
    </div>
  );
}
