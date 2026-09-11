/**
 * The "verify your email" banner.
 *
 * Verification is SOFT in AGENTIQ: an unverified account can sign in and use
 * everything. That is a deliberate trade: a demo that a spam filter can lock
 * you out of is worse than one where verification is advisory, so the banner
 * is how the requirement stays visible without being able to strand anyone.
 *
 * Deliberately NOT dismissible. A banner you can close is a banner nobody ever
 * acts on, and it disappears the moment the address is confirmed anyway.
 */
import { useState } from 'react';
import { MailWarning, CheckCircle2 } from 'lucide-react';
import { apiPost, ApiError } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui';

interface ResendResult {
  alreadyVerified: boolean;
  emailSent: boolean;
  devVerificationUrl?: string | null;
  mailConfigured?: boolean;
  mailError?: string | null;
  mail?: { configured: boolean; driver: string };
}

export function VerifyBanner() {
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [devUrl, setDevUrl] = useState<string | null>(null);

  if (!user || user.emailVerified) return null;

  const resend = async () => {
    setState('sending');
    setNote(null);
    setDevUrl(null);
    try {
      const data = await apiPost<ResendResult>('/auth/verify/resend', {});
      if (data.alreadyVerified) {
        setState('sent');
        setNote('This address is already verified: reload to clear this banner.');
        return;
      }
      setState('sent');
      /**
       * Three outcomes, three different messages.
       *
       * "No provider configured" and "the provider refused this recipient" have
       * different fixes. Saying the former for both would tell a user who hit a
       * Resend free-tier 403 (which only allows the account owner as a
       * recipient) to go configure something that is already configured.
       */
      if (data.emailSent) {
        setNote(`Sent to ${user.email}. Check your inbox, and your spam folder.`);
      } else if (data.mailConfigured) {
        setNote(
          data.mailError
            ? `The mail provider refused to send to ${user.email}: ${data.mailError}`
            : `The mail provider could not send to ${user.email}.`,
        );
        setDevUrl(data.devVerificationUrl ?? null);
      } else {
        setNote('No mail provider is configured on this server, so nothing was sent.');
        setDevUrl(data.devVerificationUrl ?? null);
      }
    } catch (err) {
      setState('error');
      setNote(err instanceof ApiError ? err.message : 'Could not send the email.');
    }
  };

  return (
    <div className="border-b border-warning/30 bg-warning-50 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {state === 'sent'
          ? <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden />
          : <MailWarning size={16} className="shrink-0 text-warning" aria-hidden />}

        <p className="t-small min-w-0 flex-1 text-ink">
          {note ?? (
            <>
              <span className="font-medium">Your email is not verified.</span>{' '}
              We sent a link to {user.email}. Everything still works: this is a reminder, not a lock.
            </>
          )}
          {devUrl && (
            <>
              {' '}
              <a href={devUrl} className="font-medium text-accent underline">
                Open the verification link
              </a>
            </>
          )}
        </p>

        {state !== 'sent' && (
          <Button size="sm" variant="secondary" loading={state === 'sending'} onClick={resend}>
            Resend
          </Button>
        )}
      </div>
    </div>
  );
}
