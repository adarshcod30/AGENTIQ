/**
 * /verify?token=…: the page the emailed link opens.
 *
 * The link is a GET that a human clicks, but the CONSUMPTION is a POST from
 * here: mail clients and corporate link scanners prefetch URLs, and a GET
 * endpoint would burn the single-use token before the recipient ever saw it.
 *
 * It works whether or not the visitor is signed in: people open mail on a
 * different device from the one they registered on.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { apiPost, ApiError } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Button, Card } from '@/components/ui';
import type { User } from '@/types';

type State =
  | { status: 'working' }
  | { status: 'ok'; already: boolean }
  | { status: 'error'; message: string; expired: boolean };

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [state, setState] = useState<State>({ status: 'working' });
  const user = useAuthStore((s) => s.user);
  const signIn = useAuthStore((s) => s.signIn);
  const token = useAuthStore((s) => s.token);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const t = params.get('token');
    if (!t) {
      setState({ status: 'error', message: 'This link is missing its token.', expired: false });
      return;
    }

    (async () => {
      try {
        const data = await apiPost<{ result: string; alreadyVerified: boolean; user: User | null }>(
          '/auth/verify', { token: t },
        );
        // Refresh the cached profile so the banner disappears without a reload.
        if (data.user && token) signIn(data.user, token);
        setState({ status: 'ok', already: data.alreadyVerified });
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : null;
        setState({
          status: 'error',
          message: apiErr?.message ?? 'Could not verify this link.',
          expired: apiErr?.status === 410,
        });
      }
    })();
  }, [params, signIn, token]);

  return (
    <div className="grid min-h-screen place-items-center bg-surface-2 p-4">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid size-7 place-items-center rounded-[4px] bg-primary text-xs font-bold text-white">A</div>
          <span className="text-lg font-semibold tracking-tight">AGENTIQ</span>
        </div>

        <Card className="p-6 text-center">
          {state.status === 'working' && (
            <>
              <Loader2 size={28} className="mx-auto animate-spin text-accent" aria-hidden />
              <p className="t-small mt-3 text-ink-muted">Verifying your email…</p>
            </>
          )}

          {state.status === 'ok' && (
            <>
              <CheckCircle2 size={36} className="mx-auto text-success" aria-hidden />
              <h1 className="t-h2 mt-3">
                {state.already ? 'Already verified' : 'Email verified'}
              </h1>
              <p className="t-small mt-1 text-ink-muted">
                {state.already
                  ? 'This address was already confirmed. Nothing more to do.'
                  : `${user?.email ?? 'Your address'} is confirmed.`}
              </p>
              <Link to={user ? '/dashboard' : '/login'}>
                <Button className="mt-5 w-full">
                  {user ? 'Go to dashboard' : 'Sign in'}
                </Button>
              </Link>
            </>
          )}

          {state.status === 'error' && (
            <>
              <XCircle size={36} className="mx-auto text-danger" aria-hidden />
              <h1 className="t-h2 mt-3">{state.expired ? 'Link expired' : 'Link not valid'}</h1>
              <p className="t-small mt-1 text-ink-muted">{state.message}</p>
              <p className="t-small mt-3 text-ink-subtle">
                {/* Say what to do next, rather than leaving them at a dead end. */}
                Sign in and use the banner at the top of the page to send a new link.
              </p>
              <Link to={user ? '/dashboard' : '/login'}>
                <Button variant="secondary" className="mt-5 w-full">
                  {user ? 'Go to dashboard' : 'Sign in'}
                </Button>
              </Link>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
