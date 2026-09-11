import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { apiPost, ApiError, API_BASE_URL } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Button, Card, Field, Input, Alert } from '@/components/ui';
import type { User } from '@/types';

/** docs/04_App_UI.md §7: centred 400px card, clear error text. */
export function LoginPage({ signup = false }: { signup?: boolean }) {
  const [form, setForm] = useState({ displayName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The server redirects here with ?error=google_auth_failed on a failed consent.
  const oauthError = params.get('error') === 'google_auth_failed';
  const signIn = useAuthStore((s) => s.signIn);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = signup ? '/auth/register' : '/auth/login';
      const body = signup ? form : { email: form.email, password: form.password };
      const data = await apiPost<{ user: User; token: string }>(path, body);
      signIn(data.user, data.token);
      navigate(params.get('next') ?? '/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="grid min-h-screen place-items-center bg-surface-2 p-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid size-7 place-items-center rounded-[4px] bg-primary text-xs font-bold text-white">
            A
          </div>
          <span className="text-lg font-semibold tracking-tight">AGENTIQ</span>
        </div>

        <Card className="p-6">
          <h1 className="t-h1 mb-1">{signup ? 'Create an account' : 'Sign in'}</h1>
          <p className="t-small mb-5 text-ink-muted">
            Executed API tests, real security evidence, an audited tool layer.
          </p>

          {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}
          {oauthError && (
            <div className="mb-4">
              <Alert tone="danger" title="Google sign-in failed">
                Google did not complete the sign-in. Try again, or use email and password.
              </Alert>
            </div>
          )}

          {/*
            A LINK, not a fetch. OAuth is a full-page redirect to Google's own
            consent screen: an XHR would be blocked by CORS and would defeat
            the point, which is that the user types their password into
            Google's page and never into ours.
          */}
          <a href={`${API_BASE_URL}/auth/google`} className="block">
            <Button type="button" variant="secondary" className="w-full">
              <GoogleMark /> Continue with Google
            </Button>
          </a>

          <div className="my-4 flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            <span className="t-small text-ink-subtle">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <form onSubmit={submit} className="space-y-4">
            {signup && (
              <Field label="Name" htmlFor="displayName" required>
                <Input id="displayName" value={form.displayName} onChange={set('displayName')} required />
              </Field>
            )}
            <Field label="Email" htmlFor="email" required>
              <Input id="email" type="email" autoComplete="email"
                value={form.email} onChange={set('email')} required />
            </Field>
            <Field label="Password" htmlFor="password" required
              hint={signup ? 'At least 8 characters.' : undefined}>
              <Input id="password" type="password"
                autoComplete={signup ? 'new-password' : 'current-password'}
                value={form.password} onChange={set('password')} required />
            </Field>
            {signup && (
              <Field label="Confirm password" htmlFor="confirmPassword" required>
                <Input id="confirmPassword" type="password" autoComplete="new-password"
                  value={form.confirmPassword} onChange={set('confirmPassword')} required />
              </Field>
            )}

            <Button type="submit" loading={busy} className="w-full">
              {signup ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <p className="t-small mt-5 text-center text-ink-muted">
            {signup ? 'Already have an account? ' : "Don't have an account? "}
            <Link to={signup ? '/login' : '/signup'} className="font-medium text-accent hover:underline">
              {signup ? 'Sign in' : 'Sign up'}
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}

/**
 * Google's mark, inlined.
 *
 * Loading it from a CDN would mean a third-party request on the sign-in page,
 * which is both a privacy leak and a thing that breaks when offline.
 */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
