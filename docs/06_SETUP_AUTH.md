# 06 · Authentication setup

Two independent things. Google sign-in needs a Google Cloud project; verification
email needs a mail sender. Neither blocks the app from running, without them the
Google button returns a clear 503 and the verification link goes to the server log.

---

## Part 1 · Google OAuth 2.0

### Why the credentials must be yours

An OAuth client belongs to the Google account that created it. Whoever owns the project
controls the consent screen, sees the usage, and can revoke the client at any moment. With
someone else's client:

- you cannot change the redirect URIs when you deploy;
- you cannot add test users;
- if they delete the project, your sign-in stops working without warning.

Create your own. It takes about ten minutes and costs nothing.

### 1 · Create a project

1. Sign in to <https://console.cloud.google.com/> with **your** account.
2. Click the project dropdown in the top bar → **New Project**.
3. Name it `AGENTIQ` → **Create**.
4. Wait for the notification, then make sure the project dropdown now shows **AGENTIQ**.
   Everything below applies to the *selected* project, and configuring the wrong one is
   the most common way to lose half an hour here.

### 2 · Configure the consent screen

This is the page users see when they click "Continue with Google".

1. Left menu → **APIs & Services** → **OAuth consent screen**.
2. User type: **External** → **Create**.
   *Internal* is only available to Google Workspace organisations and would restrict
   sign-in to your college domain.
3. Fill in the three required fields:
   - **App name**: `AGENTIQ`
   - **User support email**: your address
   - **Developer contact information**: your address
4. **Save and Continue**.
5. **Scopes** → **Add or Remove Scopes** → tick these two, then **Update**:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`

   Nothing else. AGENTIQ reads your email address, name and avatar; requesting more
   would be unnecessary, and scopes beyond these basic ones pull the app into Google's
   verification review.
6. **Save and Continue**.
7. **Test users** → **Add Users** → add your own address, and any address that needs to
   sign in before publishing (a teammate's, a reviewer's).

   While the app is in **Testing**, only listed test users can sign in. Everyone else
   gets `Error 403: access_denied`. This is the single most common Google OAuth
   surprise, and it is why the list matters.

   The list caps at 100 users. Because AGENTIQ requests only the non-sensitive `profile`
   and `email` scopes, you can lift that limit by publishing the app (**Google Auth
   Platform → Audience → Publish app**) without any scope verification review. The account
   that owns the project can always sign in, even while testing.
8. **Save and Continue** → **Back to Dashboard**.

### 3 · Create the OAuth client

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. Application type: **Web application**.
3. Name: `AGENTIQ web`.
4. **Authorised JavaScript origins** → Add URI:

   ```
   http://localhost:5173
   ```

5. **Authorised redirect URIs** → Add URI:

   ```
   http://localhost:3001/api/auth/google/callback
   ```

   This must match **byte for byte**: scheme, host, port, path. Google compares the
   whole string, so a trailing slash or `127.0.0.1` instead of `localhost` fails with
   `Error 400: redirect_uri_mismatch`.

   The value comes from `API_BASE_URL` in your `.env`, so if you change that, change
   this too. Confirm what the server will send with:

   ```bash
   curl -s localhost:3001/api/health > /dev/null && node -e "console.log(process.env.API_BASE_URL || 'http://localhost:3001')"
   ```

6. **Create**. A dialog shows your **Client ID** and **Client secret**.

### 4 · Put them in `.env`

In `server/.env`, replace the existing values:

```
GOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your client secret>
```

No quotes needed. Restart the server: `.env` is read at boot and nodemon does not
watch it.

### 5 · Check it

```bash
curl -s localhost:3001/api/health | grep -o '"googleOAuth":"[a-z]*"'
```

`"configured"` means the strategy registered. Then open <http://localhost:5173/login>
and click **Continue with Google**.

### When you deploy

Add the production URLs alongside the local ones: do not replace them, or local
development stops working:

| Field | Add |
| --- | --- |
| Authorised JavaScript origins | `https://your-app-domain` |
| Authorised redirect URIs | `https://your-api-domain/api/auth/google/callback` |

And set `API_BASE_URL` and `APP_BASE_URL` in the production environment to match.

### Common failures

| Symptom | Cause |
| --- | --- |
| `Error 400: redirect_uri_mismatch` | The URI in the console differs from `API_BASE_URL` + `/api/auth/google/callback`. Compare character by character. |
| `Error 403: access_denied` | The app is in Testing and this address is not a test user. |
| 503 `OAUTH_NOT_CONFIGURED` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing, or the server was not restarted. |
| Signs in but lands on `/login` | `APP_BASE_URL` is wrong, so the callback redirected to the wrong origin. |

### What happens after consent

1. The browser goes to Google; the password is typed on **Google's** page, never on ours.
2. Google redirects to `/api/auth/google/callback` with a one-time code.
3. The server exchanges it for the profile, finds or creates the user, and **links** the
   Google provider, so signing in with Google on an address that already has a password
   joins the same account rather than creating a second one.
4. A JWT is minted and the browser is sent to `/google-success`, which stores the token
   and immediately clears it from the URL so it does not linger in history.
5. The account is marked verified, because Google has already proved ownership, but only
   when Google's own `email_verified` flag is not false.

---

## Part 2 · Verification email over Gmail SMTP

Gmail sends to **any** recipient and needs no domain, so anyone can register with their own
address. (Resend's free tier only delivers to the account owner; see `.env.example`.)

### 1 · Enable 2-Step Verification

App passwords do not exist without it. <https://myaccount.google.com/security> →
**2-Step Verification** → turn on.

### 2 · Create an app password

1. Go to <https://myaccount.google.com/apppasswords>.
2. Name it `AGENTIQ` → **Create**.
3. Copy the 16 characters. Google shows them as four groups: `abcd efgh ijkl mnop`.
   Paste them exactly; the spaces are stripped for you.

You cannot view it again after closing the dialog, so if you lose it, delete the entry
and make a new one.

### 3 · Configure

In `server/.env`:

```
MAIL_DRIVER=smtp
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
```

Remove or comment out `RESEND_API_KEY`, or the resend driver keeps winning.

Restart the server, then:

```bash
curl -s localhost:3001/api/health | grep -o '"mail":{[^}]*}'
```

Expect `{"configured":true,"driver":"smtp"}`.

### 4 · Send a real one

Register an account and check the inbox. Or from the app, use the **Resend** button in
the banner.

### Common failures

| Symptom | Cause |
| --- | --- |
| `535 Username and Password not accepted` | Using the account password instead of an app password, or 2-Step Verification is off. |
| `driver` stays `resend` | `RESEND_API_KEY` is still set and `MAIL_DRIVER` is not `smtp`. |
| `driver` stays `console` | `GMAIL_USER` or `GMAIL_APP_PASSWORD` is missing. The driver refuses to pretend it can send. |
| Mail lands in spam | Expected from a personal Gmail. Fine for a demo; a verified domain is the fix. |

### Limits worth knowing

A personal Gmail account allows roughly 500 messages a day. Far beyond anything this
project needs, but not a bulk sender.

---

## What none of this can break

Both are optional by construction:

- No Google credentials → the button returns a clear 503 and email/password still works.
- No mail provider → registration still succeeds, the account is created unverified, and
  outside production the verification link is returned so you can continue.

Verification is **soft**: an unverified account can sign in and use every feature. That is
a deliberate trade: see `README.md` under Known limitations.
