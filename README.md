# dispatch-pipeline

Event-driven message fan-out on AWS Lambda and SQS, defined end-to-end with CDK.

Accepts a campaign over HTTP, fans its recipients onto a queue, and drains that queue
with a concurrency-capped consumer that writes an idempotent delivery receipt per
recipient to S3. Dead-letter queue, CloudWatch alarms and dashboard included.

```
POST /campaigns
      │
      ▼
┌──────────────┐    ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│ API Gateway  │───▶│  Producer   │───▶│  SQS Queue   │───▶│  Consumer   │
│  (HTTP API)  │    │   Lambda    │    │ (batch = 10) │    │   Lambda    │
└──────────────┘    └─────────────┘    └──────┬───────┘    └──────┬──────┘
                                              │                   │
                                       maxReceive = 3             ▼
                                              ▼            ┌─────────────┐
                                       ┌─────────────┐     │  S3 bucket  │
                                       │     DLQ     │     │  receipts/  │
                                       └──────┬──────┘     │ dt=…/…json  │
                                              │            └─────────────┘
                                              ▼
                                    CloudWatch alarm ──▶ SNS ──▶ email
```

---

## Results

> Fill these in from your own run. **Never publish a number you did not measure.**

| Metric | Value |
|---|---|
| Recipients drained | _pending_ |
| End-to-end drain time | _pending_ |
| Sustained throughput | _pending_ msg/s |
| Consumer p50 / p99 duration | _pending_ |
| Cold start (ARM64) | _pending_ |
| Cold start (x86_64) | _pending_ |

**Concurrency math.** At 10 reserved concurrent executions × 10 messages/batch ×
25 recipients/message × ~50 ms simulated latency, the ceiling is roughly 2,000
recipients/second. Reaching one million in sixty seconds needs ~280 concurrent
executions — and at that point the constraint is not Lambda, it is whatever the
consumer talks to. This is exactly why `reservedConcurrentExecutions` is set
explicitly rather than left at the account default.

---

## Layout

```
bin/          CDK app entry point
infra/        the stack — queues, buckets, functions, IAM, alarms, dashboard
src/
  domain/     Campaign, Recipient, DeliveryReceipt. Pure. Zero AWS imports.
  application/ use cases + ports. Depends on interfaces, never on the SDK.
  infrastructure/ SQS / S3 / delivery adapters implementing those ports.
  handlers/   Lambda entry points. Thin — wiring only.
test/         domain + application, no AWS, no mocks of AWS needed
scripts/      budget guardrail, load generator
```

The dependency rule runs one way: `handlers → infrastructure → application → domain`.
The domain layer imports nothing from AWS, which is why the entire test suite runs in
under a second with no credentials, no LocalStack and no network.

---

## Setup

```bash
pnpm install
pnpm test          # 29 tests, no AWS required
pnpm typecheck
```

### Deploying

**Set the budget guardrail first. Not second.**

```bash
./scripts/create-budget-alarm.sh you@example.com 5
```

Then:

```bash
npx cdk bootstrap                                   # once per account/region
pnpm deploy -- -c alertEmail=you@example.com
```

`cdk bootstrap` creates a `CDKToolkit` CloudFormation stack — an S3 staging bucket,
an ECR repo and a set of deployment roles. It is a one-time, account-level change and
it persists after `cdk destroy` of this stack.

### Tearing down

```bash
pnpm destroy
```

The receipts bucket is created with `autoDeleteObjects: true` and
`RemovalPolicy.DESTROY` specifically so teardown is clean. Run this after every
session — an idle queue is free, a runaway consumer loop is not.

---

## Trying it

```bash
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name DispatchPipeline \
  --query 'Stacks[0].Outputs[?OutputKey==`CampaignsEndpoint`].OutputValue' \
  --output text)

curl -X POST "$ENDPOINT" \
  -H 'content-type: application/json' \
  -d '{
    "name": "smoke test",
    "recipients": [
      { "id": "r1", "address": "a@example.com" },
      { "id": "r2", "address": "b@example.com" }
    ]
  }'
```

Expect `202 Accepted` with a campaign id. Then load test:

```bash
pnpm loadtest --endpoint "$ENDPOINT" --recipients 100000 --campaign-size 5000
```

Cap it at 100k. That proves the pattern and stays inside the free tier (1M Lambda
requests and 1M SQS requests per month).

---

## The partial batch failure experiment

**This is the point of the project.** Do not skip it.

By default, an SQS-triggered Lambda reports success or failure for the *whole batch*.
One bad message out of ten means all ten are redelivered — including the nine that
already succeeded. At scale that is duplicate delivery plus a retry storm, and it is
the single most common way a first Lambda+SQS pipeline goes wrong in production.

The fix is `reportBatchItemFailures: true` on the event source, plus a handler that
returns the specific message ids that failed:

```ts
return { batchItemFailures }   // src/handlers/consumer.ts
```

**Reproduce the bug on purpose:**

1. Set the consumer's `REPORT_BATCH_ITEM_FAILURES` environment variable to `false`
   (Lambda console, or flip the default in `infra/dispatch-stack.ts` and redeploy).
2. Raise `DELIVERY_FAILURE_RATE` to something loud, like `0.2`.
3. Run the load test.
4. Count objects in S3 and watch the consumer's invocation count against the number
   of messages actually enqueued.

The receipts themselves stay correct — S3 keys are deterministic, so a rewrite is a
no-op rather than a duplicate. What you will see instead is the *wasted work*: the
same recipients delivered again and again, invocations far above what the message
count justifies, and the queue taking much longer to drain.

Then set it back to `true` and compare. Write both numbers in the Results table.

Having reproduced this and fixed it is worth more in an interview than having read
about it. Being able to say "I measured a 4x invocation amplification and traced it to
batch-granularity retries" is a different conversation from "I've used SQS."

---

## Design notes

**Message sizing (25 recipients/message).** SQS retries whole messages, so a fat
message makes every retry expensive. 25 keeps a retry cheap while cutting SQS request
count 25x versus one-message-per-recipient. The knob lives in
`RECIPIENTS_PER_MESSAGE`.

**Idempotency.** Receipts are stored at
`receipts/dt=<day>/campaign=<id>/<recipientId>.json` — a deterministic key. Under
at-least-once delivery a redelivered message rewrites its own objects instead of
duplicating them. This is also why `createCampaign` rejects duplicate recipient ids:
two recipients sharing an id would silently overwrite each other's receipt.

**Visibility timeout = 6 × function timeout.** Below the function timeout, SQS hands
the same message to a second consumer while the first is still working. 6x is the AWS
recommendation and leaves room for in-invocation retries.

**`maxBatchingWindow: 5s`.** Waits to fill a batch before invoking. Fewer, fuller
invocations cost less and raise throughput; the price is up to 5s of added per-message
latency. Worth it for bulk dispatch, wrong for anything interactive.

**`grantPut`, not `grantWrite`.** The consumer never deletes. The generated IAM policy
is scoped to `s3:PutObject` on one bucket ARN.

**EMF over `PutMetricData`.** Custom metrics are emitted by writing a specially shaped
log line, which CloudWatch parses. No extra API call on the hot path — no added
latency, no throttling risk, and materially cheaper at volume.

**ESM output format.** Source is ESM (`"type": "module"`), so the bundler emits ESM
too rather than silently transpiling to CJS. One less mismatch to debug.

---

## Trade-offs

**CDK over SAM / Terraform.** CDK is TypeScript, so infrastructure is written in the
same language as the handlers, and `grant*()` generates least-privilege IAM without
hand-writing policy JSON. The cost is CloudFormation underneath: slow deploys, and
`UPDATE_ROLLBACK_FAILED` when things go sideways. SAM is simpler for pure-Lambda
stacks but runs out of room quickly; Terraform is more portable and more in demand
overall, but learning HCL and Lambda simultaneously is two problems at once.

**Standard queue over FIFO.** FIFO gives exactly-once and ordering but caps at ~3,000
msg/s. Standard is effectively unlimited and at-least-once, which forces the consumer
to be idempotent — the correct habit, and cheap here because the S3 key already
provides it.

**Lambda over Fargate.** Lambda scales to zero and bills per request, which fits bursty
dispatch. Past a certain sustained throughput, a long-running Fargate consumer is
cheaper and has no cold starts or 15-minute ceiling. The crossover is real; Lambda is
the right call for this shape of workload, not for every shape.

---

## Cost

Under $1 for a full weekend of work at 100k messages, assuming teardown after each
session. The free tier covers 1M Lambda requests and 1M SQS requests per month. The
budget alarm exists because "assuming teardown" is doing a lot of work in that
sentence.
