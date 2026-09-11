# 05 · AWS architecture

### Hosting, the LLM layer, and cost

> **Status.** The LLM layer runs on Amazon Bedrock today. The hosting described below is the
> deployment target: the API is packaged as a container (`Dockerfile`) and CI runs on every push,
> but there is no deploy pipeline yet and no live deployment. Everything in
> [02_TRD.md](02_TRD.md) (the MCP layer, the egress guard, the agent rules, the data model) is
> independent of where it is hosted.

---

## 1. Service map

| Concern | Service | Status | Why this one |
|---|---|---|---|
| **LLM inference** | **Bedrock** (Nova Lite), **Groq** as fallback | In use | Bedrock's Converse API reaches many model families through one interface. See §3. |
| **Database** | **MongoDB Atlas** | In use | DocumentDB was rejected: no free tier, a high minimum monthly cost, and it requires a VPC. The data model does not change. |
| **CI** | **GitHub Actions** | In use | `ci.yml`: install, lint, typecheck, test, the 70% coverage gate, and `npm audit`. |
| **API server** | **App Runner** | Target | Runs the long-lived Express container from the `Dockerfile`. **Not Lambda**; see §2. |
| **Frontend** | **S3 + CloudFront** | Target | A static `web/` build behind a CDN with TLS. |
| **Container images** | **ECR** | Target | App Runner pulls from here. |
| **CD** | **GitHub Actions + OIDC** | Planned | Short-lived credentials assumed through an IAM role, so no AWS keys are ever stored in GitHub. |
| **Secrets** | Environment variables on App Runner | Target | Secrets Manager is a planned upgrade and would need a resolver in `config/env.js` first. |

### Deliberately not used

| | Why not |
|---|---|
| **DocumentDB** | No free tier, a high minimum cost, VPC required. Atlas is sufficient. |
| **Lambda for the API** | See §2. |
| **Cognito** | JWT and Google OAuth already work. Replacing working auth is churn, not progress. |
| **OpenSearch / Kendra** | [01_PRD.md](01_PRD.md) §4 rules out vector RAG. Retrieval here means the endpoint's own specification. |

---

## 2. Why App Runner and not Lambda

"Why not serverless?" is the obvious question, and there are three concrete reasons.

- **A security scan is long-running.** The Security Agent runs six probe families, each with a
  10 s egress timeout ([02_TRD.md](02_TRD.md) §7). A worst-case scan approaches Lambda's practical
  execution window, and a timeout mid-scan leaves partial findings with no clean way to report
  them.
- **The per-host rate limiter (at most 5 requests per second) needs shared state.** Every
  concurrent Lambda invocation is a separate process with its own counter, so the limit would be
  silently multiplied by the concurrency. Enforcing it properly would mean adding ElastiCache or
  DynamoDB: new infrastructure to re-implement something that takes a few lines in one process.
- **Cold starts.** Free-tier hosting already has them; Lambda adds another layer.

App Runner keeps the process model the code already assumes, so supporting it needs **no
application code changes**, only the `Dockerfile`.

On AWS the egress guard matters even more. `169.254.169.254` is the instance metadata endpoint, so
an unguarded SSRF there is a direct path to the service role's credentials. That range stays
blocked even when `ALLOW_PRIVATE_TARGETS` is on.

---

## 3. The LLM layer

### Model choice: Amazon Nova

Anthropic models on Bedrock are delivered through an **AWS Marketplace subscription**, which needs
a valid payment instrument on the account before it can be created. **Amazon Nova is AWS
first-party**, so it needs no subscription. All three tiers produce clean, unfenced JSON:

| Model (inference profile) | Input / output per million tokens | Role |
|---|---|---|
| `apac.amazon.nova-micro-v1:0` | about $0.035 / $0.14 | cheapest |
| **`apac.amazon.nova-lite-v1:0`** | **about $0.06 / $0.24** | **default** |
| `apac.amazon.nova-pro-v1:0` | about $0.80 / $3.20 | quality comparison |

Also verified working as comparators: `qwen.qwen3-32b-v1:0`, `mistral.ministral-3-8b-instruct`,
`google.gemma-3-12b-it` and `openai.gpt-oss-120b-1:0`.

### Use the Converse API, not InvokeModel

`converse` normalises the request and response shape across every model family. `invoke-model`
needs a different body per vendor (`anthropic_version` for Claude, one schema for Nova, another for
Mistral), which would push vendor-specific branching into the adapter. With Converse, switching
model is a **configuration change, not a code change**.

### Bedrock needs an *inference profile*, not a bare model id

Invoking a bare model id fails:

```
ValidationException: Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0
with on-demand throughput isn't supported. Retry your request with the ID or ARN of
an inference profile that contains this model.
```

Newer models are reachable only through a regional or global **inference profile**, whose id
carries a prefix (`global.`, `apac.`, `us.`). `BEDROCK_MODEL_ID` is therefore a profile id. List
what is actually invokable in your region:

```bash
aws bedrock list-inference-profiles --region ap-south-1 \
  --query "inferenceProfileSummaries[?status=='ACTIVE'].inferenceProfileId" --output text
```

**AWS credentials never go in `.env`.** Locally, the default credential chain reads
`~/.aws/credentials` or an SSO session. On App Runner an instance role supplies them, and in CD it
would be OIDC. No path in this design writes a long-lived AWS key to a file the repository can see.

### Routing, decided by measurement

**Bedrock is primary; Groq is the fallback.** `providerOrder()` drops any provider whose
configuration is missing, and the boot log warns when that happens, so a chain that looks
configured but is not says so at startup. (It checks that configuration is present, not that the
credentials are still valid: an expired AWS session shows up only when a call falls through to
Groq.)

| | Bedrock (Nova Lite) | Groq (gpt-oss-120b) |
| --- | --: | --: |
| Cost per generation | **$0.000156** | $0.00055 |
| Latency | **about 2.4 s** | about 4.0 s |
| Free-tier tokens-per-minute limit | never hit | **aborted 3 evaluation runs** |
| Mutation score (grounded) | **46.7%** | 26.7% |

Generation and explanation are different problems, so they route independently (`TASK_MODELS` in
`server/src/services/llm.js`, every entry overridable through the environment):

| Task | What it is | Bedrock | Groq |
| --- | --- | --- | --- |
| `generation` | 5 test cases as structured JSON, once per run; sets suite quality | `nova-lite` | `gpt-oss-120b` |
| `explanation` | 2 sentences on one failure, about 200 tokens, once per failure | `nova-lite` | `gpt-oss-20b` |

Two measurements overturned the obvious assignment.

**The cheapest model for the cheap task was wrong.** On explanation (n=6), `nova-micro` succeeded
3 of 6 times at 1115 ms, and `nova-lite` 6 of 6 at 903 ms. Explanations run with no repair retry by
design, so half of Micro's calls produced nothing while still costing tokens: dearer *and* slower
per successful explanation.

**The most expensive model was also wrong.** The full harness per tier, 3 repeats each:

| Generation model | Mutation score (grounded) | Range | Cost per run |
| --- | --: | --: | --: |
| `nova-lite` | **46.7%** | 40 to 50% | **$0.0042** |
| `nova-pro` | 33.3% | 30 to 40% | $0.0559 |

Lite led on every repeat. Bigger was not better, and it cost 13 times more to be worse.

These figures come from a separate model-comparison sweep. The committed evaluation
([90_EVALUATION.md](90_EVALUATION.md)) is a later run of the same Nova Lite configuration and
measured 50.0%, inside the 40 to 50% range observed here: run-to-run variance, not a
contradiction. On Bedrock
both tasks therefore resolve to the same model, because that is what the evidence supports. The
routing exists so the tiers *can* diverge (the Groq fallback already does), not to manufacture a
split the measurements contradict.

---

## 4. Configuration

All optional: **absence must not break boot**, the same rule as Google OAuth.

```
AWS_REGION=ap-south-1                          # default
BEDROCK_MODEL_ID=apac.amazon.nova-lite-v1:0    # an inference profile id, not a bare model id
BEDROCK_MODEL_EXPLAIN=                         # optional override for the explanation task
LLM_PRIMARY=bedrock
LLM_FALLBACK=groq
```

---

## 5. Manual setup

These need console access and are done by hand:

1. **Bedrock:** confirm the Nova inference profiles are `ACTIVE` in your region (the command in
   §3), and give the calling identity `bedrock:InvokeModel` on the profile and the model behind it.
2. **MongoDB Atlas:** a free-tier cluster, a database user, and a network access entry for
   wherever the API runs.
3. **Local AWS credentials:** `aws configure` with a least-privilege user, or `aws login` for an SSO
   session.
4. **For deployment:** an ECR repository, an App Runner service with an instance role, an S3 bucket
   for the frontend (public access blocked, served through CloudFront), and a GitHub OIDC identity
   provider with a deploy role.

---

## 6. Cost

Estimates at low traffic:

| Service | Per month | Notes |
|---|---|---|
| MongoDB Atlas (free tier) | **$0** | This is why DocumentDB was rejected. |
| S3 + CloudFront | **under $1** | A static build is megabytes, not gigabytes. |
| ECR | **under $1** | One small image, with a lifecycle policy keeping 3 tags. |
| App Runner (0.25 vCPU / 0.5 GB) | **about $5 to $9** | Provisioned memory plus active compute. The only fixed cost. |
| Bedrock | **under $1** | One run is about $0.0004 (1 generation plus up to 3 explanations), so even a thousand runs a month stays under a dollar. |
| **Total** | **about $6 to $11** | Dominated by App Runner. |

### Keeping it there

1. **AWS Budgets alerts**, set up before the first Bedrock call.
2. **A token cap on every call.** `maxTokens` is passed on every request to both providers, so a
   runaway prompt cannot produce a runaway bill.
3. **Measured spend.** The evaluation harness records tokens and cost per run
   ([90_EVALUATION.md](90_EVALUATION.md)), so cost is a number, not a guess.
4. **Pause App Runner** between sessions if the fixed cost matters. It is the one charge that
   accrues while nothing is happening.

### Cheaper alternatives

- **Lightsail containers**, flat monthly pricing with the same `Dockerfile`.
- **A free-tier container host for the API**, keeping AWS only for Bedrock, S3 and CloudFront. That
  keeps every AWS benefit that matters and drops the fixed cost to near zero.
