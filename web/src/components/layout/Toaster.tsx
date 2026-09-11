import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useToastStore } from '@/store/toast';

const TONE = {
  info: 'bg-surface border-line',
  success: 'bg-success-50 border-success/30',
  warning: 'bg-warning-50 border-warning/30',
  danger: 'bg-danger-50 border-danger/30',
} as const;

export function Toaster() {
  const { toasts, dismiss } = useToastStore();
  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn('flex items-start gap-2 rounded-[6px] border p-3 text-[13px]', TONE[t.tone])}
          style={{ boxShadow: 'var(--shadow-pop)' }}
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          <button
            type="button" onClick={() => dismiss(t.id)}
            className="shrink-0 rounded p-0.5 text-ink-muted hover:bg-surface-3 hover:text-ink"
            aria-label="Dismiss"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
