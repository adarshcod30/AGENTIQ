/**
 * The AGENTIQ brand mark, in code.
 *
 * A rounded app-icon tile on the brand gradient with a crisp geometric "A".
 * It is drawn (not an <img>) so it inherits crisp rendering at any size and
 * carries no network request on the login page. The gradient id is made unique
 * per instance with useId, so several marks on one page cannot collide.
 *
 * The static twin lives at web/public/favicon.svg (the browser tab icon):
 * keep the two in sync if the mark ever changes.
 */
import { useId } from 'react';
import { cn } from '@/lib/cn';

export function LogoMark({ size = 28, className, title = 'AGENTIQ' }: {
  size?: number; className?: string; title?: string;
}) {
  const gid = `aq-${useId()}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" fill="none"
      role="img" aria-label={title} className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id={gid} x1="2" y1="1" x2="30" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1B4D89" />
          <stop offset="1" stopColor="#2A66CC" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8.5" fill={`url(#${gid})`} />
      {/* A hair of top light gives the tile real depth. */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="#fff" strokeOpacity="0.16" />
      <path d="M8 24.4 L16 7 L24 24.4" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.8 18.1 H20.2" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Mark plus the AGENTIQ wordmark, horizontal. The lockup for headers. */
export function Wordmark({ markSize = 26, className }: { markSize?: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={markSize} />
      <span className="text-[16px] font-semibold tracking-[-0.02em] text-ink">AGENTIQ</span>
    </div>
  );
}
