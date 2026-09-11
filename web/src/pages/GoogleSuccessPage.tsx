/**
 * /google-success: catches the redirect from the API after Google sign-in.
 *
 * The server mints a JWT and redirects here with it in the query string. This
 * page stores it, fetches the profile, and gets the token OUT of the URL
 * immediately: a token sitting in the address bar ends up in browser history,
 * in the Referer header of the next outbound request, and in any screenshot
 * taken during a demo.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, setAuthToken, ApiError } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Alert, Button, Card } from '@/components/ui';
import type { User } from '@/types';

export function GoogleSuccessPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useAuthStore((s) => s.signIn);
  const [error, setError] = useState<string | null>(null);
  // React 18+ runs effects twice in development; without this the profile is
  // fetched twice and the redirect races itself.
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const token = params.get('token');
    if (!token) {
      setError('Google sign-in did not return a token. Try again.');
      return;
    }

    // Replace the history entry before anything else, so the token cannot be
    // recovered with the back button.
    window.history.replaceState({}, '', '/google-success');

    (async () => {
      try {
        setAuthToken(token);
        const { user } = await apiGet<{ user: User }>('/auth/me');
        signIn(user, token);
        navigate('/dashboard', { replace: true });
      } catch (err) {
        setAuthToken(null);
        setError(err instanceof ApiError ? err.message : 'Could not complete Google sign-in.');
      }
    })();
  }, [params, navigate, signIn]);

  return (
    <div className="grid min-h-screen place-items-center bg-surface-2 p-4">
      <div className="w-full max-w-[400px]">
        <Card className="p-6 text-center">
          {error ? (
            <>
              <Alert tone="danger" title="Sign-in failed">{error}</Alert>
              <Button className="mt-4 w-full" onClick={() => navigate('/login', { replace: true })}>
                Back to sign in
              </Button>
            </>
          ) : (
            <p className="t-small text-ink-muted">Completing sign-in…</p>
          )}
        </Card>
      </div>
    </div>
  );
}
