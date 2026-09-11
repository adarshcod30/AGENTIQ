/**
 * The permission sheet.
 *
 * docs/03_App_Flow.md B1: "The permission sheet appears BEFORE any packet
 * leaves the server, and network.probe is unchecked by default. This is the
 * moment the architecture becomes visible to a human: do not reduce it to a
 * toast."
 *
 * This is the single most important component in the product. Everything else
 * describes the architecture; this one makes a person participate in it.
 */
import { useState, useEffect, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button, RiskChip } from './index';
import type { RiskClass } from '@/types';

export interface PermissionRequest {
  host: string;
  /** Which classes this action needs. network.probe is opt-in, always. */
  riskClasses: RiskClass[];
}

const COPY: Record<RiskClass, { label: string; description: string }> = {
  'local.compute': {
    label: 'Local computation',
    description: 'Parsing and evaluation only. No network access.',
  },
  'network.read': {
    label: 'Send benign requests',
    description: 'Ordinary requests to this host, reading the responses.',
  },
  'network.probe': {
    label: 'Send attack-indicator payloads',
    description: 'SQL-injection and XSS indicator payloads. Detection only, never destructive.',
  },
  'deploy.write': {
    label: 'Deploy infrastructure',
    description: 'Creates or triggers a deployment. Changes systems outside AGENTIQ.',
  },
};

export function PermissionSheet({
  request, open, onCancel, onAllow, submitting = false,
}: {
  request: PermissionRequest | null;
  open: boolean;
  onCancel: () => void;
  onAllow: (granted: RiskClass[]) => void;
  submitting?: boolean;
}) {
  /**
   * network.probe starts UNCHECKED, every time. Firing SQLi payloads at a host
   * the user did not knowingly nominate is the one mistake in this project that
   * would be genuinely serious rather than merely embarrassing.
   */
  const [checked, setChecked] = useState<Set<RiskClass>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !request) return;
    setChecked(new Set(request.riskClasses.filter((c) => c === 'network.read')));
  }, [open, request]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // Esc cancels. Enter deliberately does NOT allow (docs/04_App_UI.md §8),
      // a consent dialog you can dismiss by reflex is not consent.
      if (e.key === 'Escape') onCancel();
      if (e.key !== 'Tab' || !ref.current) return;
      const nodes = ref.current.querySelectorAll<HTMLElement>('button, input');
      if (!nodes.length) return;
      const [first, last] = [nodes[0], nodes[nodes.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open || !request) return null;

  const toggle = (cls: RiskClass) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) next.delete(cls); else next.add(cls);
      return next;
    });
  };

  return (
    // Never auto-dismissing: no click-outside handler, on purpose.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div
        ref={ref} role="dialog" aria-modal="true" aria-labelledby="permission-title"
        className="w-full max-w-lg rounded-[8px] bg-surface"
        style={{ boxShadow: 'var(--shadow-pop)' }}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden />
          <div>
            <h2 id="permission-title" className="t-h2">
              Allow AGENTIQ to send requests to
            </h2>
            <p className="t-mono mt-0.5 font-semibold break-all text-ink">{request.host}</p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {request.riskClasses.map((cls) => (
            <label key={cls} className="flex cursor-pointer gap-3 rounded-[6px] p-2 hover:bg-surface-2">
              <input
                type="checkbox"
                checked={checked.has(cls)}
                onChange={() => toggle(cls)}
                className="mt-0.5 size-4 shrink-0 rounded-[3px] border-line text-primary focus:ring-2 focus:ring-accent/30"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{COPY[cls].label}</span>
                  <RiskChip riskClass={cls} />
                </span>
                <span className="t-small mt-0.5 block text-ink-muted">{COPY[cls].description}</span>
              </span>
            </label>
          ))}

          <p className="t-small rounded-[6px] bg-warning-50 px-3 py-2 text-ink">
            Only scan hosts you own or are authorised to test.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            onClick={() => onAllow([...checked])}
            loading={submitting}
            disabled={checked.size === 0}
          >
            Allow for this session
          </Button>
        </div>
      </div>
    </div>
  );
}
