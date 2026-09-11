/**
 * The component library: docs/04_App_UI.md §6.
 *
 * Light only. Colour means something: red is a real finding, amber a real
 * warning, green a real pass. The moment red is used for decoration it stops
 * meaning anything (§1).
 *
 * React 19: `ref` is a normal prop, so forwardRef is gone.
 */
import { type ReactNode, type ComponentProps, useEffect, useRef } from 'react';
import { X, Check, AlertCircle, Info, Copy, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Severity, RiskClass, HttpMethod, AssertionResult, Finding } from '@/types';

/* ── Button ───────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-700 disabled:bg-ink-subtle',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface-3 hover:text-ink',
  danger: 'bg-danger text-white hover:brightness-90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-sm',
  lg: 'h-10 px-5 text-sm',
};

export function Button({
  variant = 'primary', size = 'md', loading = false, className, children, disabled, ...rest
}: ComponentProps<'button'> & {
  variant?: ButtonVariant; size?: ButtonSize; loading?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[6px] font-medium',
        'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className,
      )}
      {...rest}
    >
      {/* Loading shows IN PLACE, never swap the label for a spinner (§6). */}
      {loading && (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

/* ── Card ─────────────────────────────────────────────────────────────────── */

export function Card({ className, children, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('card', className)} {...rest}>{children}</div>;
}

export function CardHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
      <h3 className="t-h3">{title}</h3>
      {actions}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-5', className)}>{children}</div>;
}

/* ── KpiCard ──────────────────────────────────────────────────────────────── */

export function KpiCard({
  label, value, delta, direction,
}: {
  label: string;
  value: string | number;
  delta?: string;
  /**
   * Only set this when the direction GENUINELY means good or bad.
   * More findings is not "green" just because the number went up (§6).
   */
  direction?: 'good' | 'bad';
}) {
  return (
    <Card className="p-5">
      <div className="t-label">{label}</div>
      <div className="mt-1 text-[30px] font-semibold leading-none tabular" data-numeric>
        {value}
      </div>
      {delta && (
        <div
          className={cn(
            't-small mt-2',
            direction === 'good' && 'text-success',
            direction === 'bad' && 'text-danger',
            !direction && 'text-ink-muted',
          )}
        >
          {delta}
        </div>
      )}
    </Card>
  );
}

/* ── Inputs ───────────────────────────────────────────────────────────────── */

const FIELD_BASE =
  'w-full h-9 rounded-[6px] border border-line bg-surface px-3 text-sm text-ink ' +
  'placeholder:text-ink-subtle focus:border-accent focus:outline-none ' +
  'focus:ring-2 focus:ring-accent/30 disabled:bg-surface-3';

export function Field({
  label, hint, error, required, children, htmlFor,
}: {
  label: string; hint?: string; error?: string; required?: boolean;
  children: ReactNode; htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
        {label}
        {required && <span className="ml-1 text-danger" aria-hidden>*</span>}
      </label>
      {children}
      {/* Error REPLACES help text, in danger tone (§6). */}
      {error
        ? <p className="t-small text-danger">{error}</p>
        : hint && <p className="t-small text-ink-muted">{hint}</p>}
    </div>
  );
}

export function Input({ mono, className, ...rest }: ComponentProps<'input'> & { mono?: boolean }) {
  return <input className={cn(FIELD_BASE, mono && 't-mono', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <select className={cn(FIELD_BASE, 'pr-8', className)} {...rest}>{children}</select>
  );
}

export function Textarea({ mono, className, ...rest }: ComponentProps<'textarea'> & { mono?: boolean }) {
  return (
    <textarea
      className={cn(FIELD_BASE, 'h-auto min-h-20 py-2 leading-relaxed', mono && 't-mono', className)}
      {...rest}
    />
  );
}

export function Checkbox({ label, hint, id, ...rest }: ComponentProps<'input'> & {
  label: string; hint?: string;
}) {
  return (
    <div className="flex gap-2.5">
      <input
        id={id} type="checkbox"
        className="mt-0.5 size-4 shrink-0 rounded-[3px] border-line text-primary focus:ring-2 focus:ring-accent/30"
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] text-ink">{label}</label>
        {hint && <p className="t-small text-ink-muted">{hint}</p>}
      </div>
    </div>
  );
}

/* ── Chip ─────────────────────────────────────────────────────────────────── */

const SEVERITY_CHIP: Record<Severity, string> = {
  critical: 'bg-[color-mix(in_srgb,var(--color-sev-critical)_12%,white)] text-sev-critical',
  high: 'bg-danger-50 text-sev-high',
  medium: 'bg-warning-50 text-sev-medium',
  low: 'bg-surface-3 text-sev-low',
};

const RISK_CHIP: Record<RiskClass, string> = {
  'local.compute': 'bg-surface-3 text-ink-muted',
  'local.fs.read': 'bg-surface-3 text-ink-muted',
  'local.process': 'bg-info-50 text-info',
  'network.read': 'bg-info-50 text-info',
  'network.probe': 'bg-warning-50 text-warning',
  'deploy.write': 'bg-danger-50 text-danger',
};

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-method-get', POST: 'text-method-post', PUT: 'text-method-put',
  PATCH: 'text-method-patch', DELETE: 'text-method-delete',
};

export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
      className,
    )}>
      {children}
    </span>
  );
}

export const SeverityChip = ({ severity }: { severity: Severity }) => (
  <Chip className={SEVERITY_CHIP[severity]}>{severity.toUpperCase()}</Chip>
);

export const RiskChip = ({ riskClass }: { riskClass: RiskClass }) => (
  <Chip className={cn(RISK_CHIP[riskClass], 't-mono !text-[11px]')}>{riskClass}</Chip>
);

export const MethodChip = ({ method }: { method: HttpMethod | string }) => (
  <Chip className={cn('bg-surface-3 t-mono !text-[11px]', METHOD_COLOR[method] ?? 'text-ink-muted')}>
    {method}
  </Chip>
);

export function StatusChip({ status }: { status: 'pass' | 'fail' | 'error' | 'skip' }) {
  const styles = {
    pass: 'bg-success-50 text-success',
    fail: 'bg-danger-50 text-danger',
    error: 'bg-warning-50 text-warning',
    skip: 'bg-surface-3 text-ink-subtle',
  } as const;
  return <Chip className={styles[status]}>{status.toUpperCase()}</Chip>;
}

/* ── CodeBlock ────────────────────────────────────────────────────────────── */

export function CodeBlock({ code, label, maxHeight = 400 }: {
  code: string; label?: string; maxHeight?: number;
}) {
  const copy = () => navigator.clipboard?.writeText(code);
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface-3">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="t-label">{label ?? 'Output'}</span>
        <button
          type="button" onClick={copy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface hover:text-ink"
          aria-label="Copy to clipboard"
        >
          <Copy size={12} aria-hidden /> Copy
        </button>
      </div>
      <pre className="t-mono-block overflow-auto p-3" style={{ maxHeight }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ── AssertionRow: the workhorse (§6) ─────────────────────────────────────── */

export function AssertionRow({ assertion }: { assertion: AssertionResult }) {
  const { pass, kind, expected, actual } = assertion;
  return (
    <div
      className={cn(
        'flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[13px]',
        !pass && 'bg-danger-50',
      )}
    >
      {/* Icon AND text, never colour alone (§8, WCAG). */}
      {pass
        ? <Check size={16} className="shrink-0 text-success" aria-hidden />
        : <X size={16} className="shrink-0 text-danger" aria-hidden />}
      <span className="sr-only">{pass ? 'passed' : 'failed'}</span>
      <span className="t-mono min-w-40 text-ink">{kind}</span>
      <span className="t-small text-ink-muted">expected</span>
      <span className="t-mono text-ink" data-numeric>{expected || 'n/a'}</span>
      <span className="t-small text-ink-muted">actual</span>
      <span className={cn('t-mono', pass ? 'text-ink' : 'text-danger font-medium')} data-numeric>
        {actual || 'n/a'}
      </span>
    </div>
  );
}

/* ── FindingCard ──────────────────────────────────────────────────────────── */

const SEVERITY_RULE: Record<Severity, string> = {
  critical: 'border-l-sev-critical', high: 'border-l-sev-high',
  medium: 'border-l-sev-medium', low: 'border-l-sev-low',
};

export function FindingCard({ finding, defaultOpen = false }: {
  finding: Finding; defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className={cn('card border-l-[3px]', SEVERITY_RULE[finding.severity])}>
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4">
        <SeverityChip severity={finding.severity} />
        <Chip className="bg-surface-3 text-ink-muted">{finding.owasp}</Chip>
        <span className="t-h3 ml-1 min-w-0 flex-1 truncate">{finding.family}</span>
        <ChevronDown size={16} className="shrink-0 text-ink-subtle" aria-hidden />
      </summary>

      {/* Evidence, or it is not a finding: docs/03_App_Flow.md B2. */}
      <div className="space-y-3 border-t border-line px-4 py-4">
        <Evidence label="Payload" value={finding.payload} mono />
        <Evidence label="Signal" value={finding.signal} />
        <Evidence label="Baseline" value={finding.baseline} />
        <Evidence label="Meaning" value={finding.explanation} />
        <Evidence label="Fix" value={finding.remediation} />
      </div>
    </details>
  );
}

function Evidence({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid gap-1 sm:grid-cols-[88px_1fr] sm:gap-3">
      <div className="t-label pt-0.5">{label}</div>
      <div className={cn('text-[13px] leading-relaxed text-ink', mono && 't-mono break-all')}>
        {value}
      </div>
    </div>
  );
}

/* ── EmptyState ───────────────────────────────────────────────────────────── */

export function EmptyState({ icon, title, body, action }: {
  icon?: ReactNode; title: string; body: string; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-ink-subtle" aria-hidden>{icon}</div>}
      <h3 className="t-h3">{title}</h3>
      <p className="t-small max-w-sm text-ink-muted">{body}</p>
      {action}
    </div>
  );
}

/* ── Skeleton (never a full-page spinner: §4) ─────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}

/* ── Modal, with a focus trap (§8) ────────────────────────────────────────── */

export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string;
  children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // Esc cancels. Enter must NOT auto-confirm (§8).
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className="w-full max-w-lg rounded-[8px] bg-surface"
        style={{ boxShadow: 'var(--shadow-pop)' }}
      >
        <div className="border-b border-line px-5 py-4">
          <h2 className="t-h2">{title}</h2>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ── Alert ────────────────────────────────────────────────────────────────── */

export function Alert({ tone = 'info', title, children }: {
  tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: ReactNode;
}) {
  const styles = {
    info: 'bg-info-50 border-info/30 text-ink',
    success: 'bg-success-50 border-success/30 text-ink',
    warning: 'bg-warning-50 border-warning/30 text-ink',
    danger: 'bg-danger-50 border-danger/30 text-ink',
  } as const;
  const Icon = tone === 'success' ? Check : tone === 'info' ? Info : AlertCircle;
  const iconColor = {
    info: 'text-info', success: 'text-success', warning: 'text-warning', danger: 'text-danger',
  }[tone];

  return (
    <div className={cn('flex gap-3 rounded-[6px] border p-3', styles[tone])} role="status">
      <Icon size={16} className={cn('mt-0.5 shrink-0', iconColor)} aria-hidden />
      <div className="min-w-0 text-[13px] leading-relaxed">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}
