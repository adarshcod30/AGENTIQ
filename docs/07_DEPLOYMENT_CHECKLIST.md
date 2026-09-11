# 07 · Deployment checklist

Check every item against a real boot with `NODE_ENV=production`, not by reading the code.

---

## Before deploying

| Check | Expected |
| --- | --- |
| Boots under `NODE_ENV=production` | Connects to Atlas, registers its tools, listens |
| `ALLOW_PRIVATE_TARGETS=true` in production | **Refused**: the server exits 1 and names the reason |
| CORS locked to `CORS_ORIGIN` | Unknown origins get no `Access-Control-Allow-Origin` |
| Security headers | CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`; no `X-Powered-By` |
| Cookie flags | `HttpOnly; Secure; SameSite=None` |
| Error responses | Code and message only, never a stack trace |
| Protected routes, anonymous | 401 on `/runs`, `/mcp/audit`, `/mcp/grants`, `/deployments`, `/specs` |
| SSRF guard | The metadata address, loopback, RFC 1918 and `metadata.google.internal` are all refused |
| Public hosts | Still reachable: `api.github.com` resolves and the connection is pinned |
| Secrets in logs | None: the boot table masks every secret |
| Frontend bundle | `VITE_API_URL` baked in, no localhost fallback, no secrets |
| Graceful shutdown | Exits cleanly on `SIGTERM`, which is what App Runner sends |
| `trust proxy` | Set to `1`, so rate limits key on the real client IP behind the load balancer |
| Database indexes | All present, including the TTL index that expires verification tokens |
| Runtime dependencies | None hiding in `devDependencies` |
| Fresh clone | `npm ci`, lint, typecheck, test and build all pass with no `.env` and no code edits |
| CI | Green, including the coverage gate and `npm audit` |
| The `Dockerfile` | Builds locally before the image is pushed to ECR |
| Google sign-in | A full consent round trip against the production redirect URI |

---

## What must be set on the host

`config/env.js` validates all of it at boot and exits non-zero if a required value is missing, so
a misconfigured deploy fails loudly rather than serving half a product.

### Required

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3001` (App Runner routes to it) |
| `MONGO_URI` | The Atlas SRV string |
| `JWT_SECRET` | **A new one.** Never reuse the development secret. |

### Origins: wrong values here break auth in ways that look like other bugs

| Variable | Value |
| --- | --- |
| `CORS_ORIGIN` | The CloudFront domain. Anything else and the browser blocks every call. |
| `APP_BASE_URL` | The CloudFront domain. The Google callback and verification links use it. |
| `API_BASE_URL` | The App Runner domain. The OAuth `redirect_uri` is built from it. |

### Features

| Variable | Note |
| --- | --- |
| `BEDROCK_MODEL_ID` | `apac.amazon.nova-lite-v1:0`. Without it the chain drops to Groq alone, and the boot log warns. |
| `AWS_REGION` | `ap-south-1` |
| `GROQ_API_KEY` | The fallback provider. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Add the production redirect URI in the Google Console **as well as** the local one. |
| `MAIL_DRIVER` / `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Verification email. |
| `RENDER_API_KEY` | The deployment agent. |
| `ALLOW_PRIVATE_TARGETS` | **Leave unset.** The schema refuses `true` in production. |

Secrets are supplied as plain environment variables on the host. Secrets Manager is planned, and
would need a resolver in `config/env.js` first; see [05_AWS_ARCHITECTURE.md](05_AWS_ARCHITECTURE.md).

---

## Order of operations

1. **Build the frontend with the real API URL.** It is baked in at build time, so building before
   the API domain exists produces a bundle that calls the wrong host:
   ```bash
   VITE_API_URL=https://<app-runner-domain>/api npm run build
   ```
2. Upload `web/dist` to S3 and invalidate CloudFront.
3. Build and push the image to ECR; create the App Runner service.
4. Set every variable above on the service.
5. **Atlas IP access list.** App Runner has no static egress IP, so `0.0.0.0/0` is required. It is
   a deliberate trade-off: access is still controlled by the database user's credentials.
6. **Google Console.** Add `https://<app-runner-domain>/api/auth/google/callback` to the
   authorised redirect URIs and the CloudFront domain to the JavaScript origins. Keep the localhost
   entries so local development still works.
7. Set the repository variable `HEALTH_URL` to `https://<app-runner-domain>/api/health` so the
   keep-warm workflow starts pinging.

## After deploying

```bash
curl -s https://<app-runner-domain>/api/health | python3 -m json.tool
```

Expect `status: ok`, `mongo: connected`, `llmChain.order: ["bedrock","groq"]` and
`mail.configured: true`. The chain is reported because configuration naming a provider does not
mean that provider is answering.

Then sign in with Google, register an account and confirm the verification email arrives, and run
one test against a public API.

Expected running costs are in [05_AWS_ARCHITECTURE.md](05_AWS_ARCHITECTURE.md) §6. The one to
watch is App Runner, which bills for provisioned capacity rather than requests.
