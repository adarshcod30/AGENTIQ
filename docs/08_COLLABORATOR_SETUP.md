# 08 · Local development setup

The fastest way to a running copy: a local MongoDB and a free Groq key, no AWS account needed.
Every key below you create yourself, on your own accounts, in about ten minutes, and they are all
free. For real infrastructure (Atlas, Bedrock), see [06_SETUP.md](06_SETUP.md).

If someone hands you a filled-in `.env`, don't use it: it would point your
machine at their database and let your local server send email as them.

---

## 1. Prerequisites

- Node 22.12 or later (`node -v`); `.nvmrc` pins 22
- A MongoDB: either Docker or a free Atlas cluster (step 3)

```bash
git clone <repo-url> && cd AGENTIQ
npm ci
```

## 2. Generate your own JWT secret

This is **not** a shared secret. It signs session tokens on your machine only.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 3. Get a database

Easiest: run one locally:

```bash
docker run -d --name agentiq-mongo -p 27017:27017 mongo:7
```

That gives you `mongodb://127.0.0.1:27017/agentiq`. Alternatively create a free
M0 cluster at cloud.mongodb.com and use its connection string.

## 4. Get an LLM key

Sign up at console.groq.com and create an API key. The free tier is enough for
development.

Bedrock is the primary provider in production, but it is **optional**: the
provider chain drops any provider that isn't configured, so Groq alone works.
Skip AWS entirely unless you're specifically working on the Bedrock path.

## 5. Write `server/.env`

```bash
cp .env.example server/.env
```

Then set these six values and leave everything else blank:

```
MONGO_URI=mongodb://127.0.0.1:27017/agentiq
JWT_SECRET=<the string from step 2>
GROQ_API_KEY=<your own key from step 4>
LLM_PRIMARY=groq
LLM_FALLBACK=bedrock
ALLOW_PRIVATE_TARGETS=true
```

`ALLOW_PRIVATE_TARGETS=true` is needed only to scan the local fixture apps. The
schema **refuses** it when `NODE_ENV=production`, so it cannot leak upward.

## 6. Run

```bash
npm run dev
```

App on http://localhost:5173, API on http://localhost:3001/api. Register a new
account through the UI with any email and password.

For the fixture targets to scan, in a second terminal:

```bash
npm run fixtures
```

That serves a deliberately vulnerable app on :4001 and a hardened one on :4002.

---

## What you're intentionally missing, and why it doesn't matter

At boot the server prints:

```
Disabled (optional config absent): Google OAuth sign-in, Deployment agent, Verification email
```

That is the expected, correct state for a local dev setup:

| Disabled | Consequence |
|---|---|
| Google OAuth sign-in | The "Sign in with Google" button won't work. Email + password login does: `loginUser` never checks `emailVerified`. |
| Deployment agent | The deploy tool can't reach Render. Nothing else is affected. |
| Verification email | No mail is sent. Registration and login still work. |

Bedrock is not in that list, because `.env.example` ships a Bedrock model id, so it stays in the
chain as the fallback. Without AWS credentials it only matters if Groq fails, and then the run
ends in a visible `GEN_FAILED`. To keep Bedrock out of the chain entirely, blank
`BEDROCK_MODEL_ID` in `server/.env`.

## Verify it's healthy

```bash
curl -s http://localhost:3001/api/health | python3 -m json.tool
```

`mongo` should read `connected`, and `llmChain.order` should be `["groq", "bedrock"]` (or
`["groq"]` if you blanked `BEDROCK_MODEL_ID`).

## Tests

```bash
npm test --workspace server
```

441 tests, no credentials required: the suite never reads a developer's `.env`.
