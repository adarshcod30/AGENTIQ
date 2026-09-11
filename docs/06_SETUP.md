# 06 · Infrastructure setup

### MongoDB Atlas, AWS credentials for Bedrock, and a budget alarm

For running AGENTIQ against real services. To run it locally with the least setup (a local
MongoDB and a free Groq key, no AWS at all), use
[08_COLLABORATOR_SETUP.md](08_COLLABORATOR_SETUP.md) instead. Google sign-in and verification
email are covered in [06_SETUP_AUTH.md](06_SETUP_AUTH.md).

---

## 1. MongoDB Atlas

### 1.1 Create the cluster

1. Sign in at **https://cloud.mongodb.com** and create a project named `AGENTIQ`. A separate
   project keeps its network and user rules easy to reason about.
2. **Create a deployment → free tier.** Confirm the card shows **$0.00/month**.
3. **Provider AWS, region Mumbai (`ap-south-1`)**, matching the Bedrock region so latency stays
   low. Name the cluster `agentiq`.

### 1.2 Database user

**Database Access → Add New Database User.**

- Username: `agentiq_app`
- Password: **Autogenerate Secure Password**, and copy it. Do not invent one by hand.
- Role: **Read and write to any database**.

> **Password gotcha:** if the password contains `@ : / ? # [ ] %`, it *must* be percent-encoded
> inside the connection string, or the URI parser reads it as a host separator and produces a
> baffling error. `@` becomes `%40`, `#` becomes `%23`, `/` becomes `%2F`.

### 1.3 Network access

**Network Access → Add IP Address.**

- For local development: **Add Current IP Address**.
- For App Runner: it has no stable outbound IP, so the options are `0.0.0.0/0` or VPC peering /
  PrivateLink. `0.0.0.0/0` is a deliberate trade-off rather than an oversight: every connection
  still needs the database user's strong password.

### 1.4 Connection string

**Database → Connect → Drivers → Node.js** gives something like:

```
mongodb+srv://agentiq_app:<db_password>@agentiq.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

Replace `<db_password>` and **add the database name before the `?`**:

```
mongodb+srv://agentiq_app:PASSWORD@agentiq.xxxxx.mongodb.net/agentiq?retryWrites=true&w=majority
```

> Without `/agentiq`, Mongoose connects to a database literally named `test`. Everything appears to
> work and the data ends up in the wrong place.

### 1.5 Verify

Put it in `server/.env` as `MONGO_URI=...`, start the server with `npm run dev:server`, and check:

```bash
curl -s http://localhost:3001/api/health | python3 -m json.tool
```

You want `"status": "ok"` and `"mongo": "connected"`.

---

## 2. AWS credentials for Bedrock

AGENTIQ never reads AWS keys from `.env`. The AWS SDK finds credentials through its default chain:
`~/.aws/credentials`, an SSO session, or an instance role in production.

### 2.1 A dedicated, least-privilege IAM user

Running everything as one over-permissioned identity undercuts a security tool, so give AGENTIQ its
own. **IAM → Users → Create user** → `agentiq-app` → **Attach policies directly → Create policy →
JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvokeOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*"
      ]
    },
    {
      "Sid": "BedrockDiscovery",
      "Effect": "Allow",
      "Action": ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
      "Resource": "*"
    }
  ]
}
```

Note what it does **not** grant: no S3, no IAM, no EC2. It can call models and list them, and
nothing else. The Converse API is authorised by `bedrock:InvokeModel`.

Then **Security credentials → Create access key → Command Line Interface**, and store the key in
the AWS CLI's own file, never in this repository:

```bash
aws configure --profile agentiq
```

Use region `ap-south-1` and output `json`. Prefer `aws login` if your account uses SSO.

### 2.2 Tell the server which profile to use

With a named profile, the SDK only uses it when `AWS_PROFILE` is set. Otherwise it silently falls
back to `[default]`, which may be a different account or region:

```bash
AWS_PROFILE=agentiq npm run dev:server
```

### 2.3 Verify the scope

The first command should succeed and the second should **fail**:

```bash
AWS_PROFILE=agentiq aws bedrock list-inference-profiles --region ap-south-1 \
  --query "inferenceProfileSummaries[?status=='ACTIVE'].inferenceProfileId" --output text
AWS_PROFILE=agentiq aws iam list-users        # AccessDenied means the policy is right
```

Then prove a real model call end to end:

```bash
AWS_PROFILE=agentiq aws bedrock-runtime converse --region ap-south-1 \
  --model-id apac.amazon.nova-lite-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Reply with the word OK."}]}]'
```

### 2.4 Configure the chain

In `server/.env`:

```
LLM_PRIMARY=bedrock
LLM_FALLBACK=groq
BEDROCK_MODEL_ID=apac.amazon.nova-lite-v1:0
GROQ_API_KEY=...        # the fallback; free at console.groq.com
```

`GET /api/health` reports the resolved chain under `llmChain.order`. It confirms configuration is
present, not that credentials are still valid: if an SSO session expires, calls fall through to
Groq, so re-run `aws login` when that happens.

---

## 3. A budget alarm

Set the alarm before the spend, not after.

1. **Billing and Cost Management → Budgets → Create budget.** Budgets always lives in
   `us-east-1`; that is expected.
2. **Cost budget → Monthly → Fixed**, at whatever ceiling suits you.
3. Add **three** alert thresholds, because one says nothing about trajectory: 60% actual, 85%
   actual, and 100% **forecasted**, which warns days before you hit it.

Confirm afterwards:

```bash
aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)"
```

Expected monthly costs are in [05_AWS_ARCHITECTURE.md](05_AWS_ARCHITECTURE.md) §6.
