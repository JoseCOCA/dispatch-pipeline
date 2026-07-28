# Where we left off — 2026-07-27

## Done ✅

- [x] `$5/month` budget guardrail created and verified (alerts at 50 / 80 / 100%)
- [x] `cdk bootstrap` completed for `aws://292874543050/us-east-1`
- [x] `pnpm typecheck` passes
- [x] 29 tests pass
- [x] Pushed public → https://github.com/JoseCOCA/dispatch-pipeline

**Nothing is deployed yet.** No stack exists in AWS. Current AWS spend: ~$0.

## Next command — Step 2c, deploy

```bash
cd /home/jose/Proyectos/dispatch-pipeline
AWS_REGION=us-east-1 pnpm cdk:deploy -- -c alertEmail=josecoca0890@gmail.com
```

- It **will stop and ask permission** for the IAM changes. Read the policy list, type `y`.
- Takes 3–5 minutes.
- Afterwards, **confirm the SNS subscription email** or the alarms fire into the void.
- Save the outputs it prints — you need `CampaignsEndpoint` for Step 3.

## Then

**Step 3 — smoke test.** One campaign, 2 recipients:

```bash
ENDPOINT=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name DispatchPipeline \
  --query 'Stacks[0].Outputs[?OutputKey==`CampaignsEndpoint`].OutputValue' --output text)

curl -X POST "$ENDPOINT" -H 'content-type: application/json' \
  -d '{"name":"smoke test","recipients":[
       {"id":"r1","address":"a@example.com"},
       {"id":"r2","address":"b@example.com"}]}'
```

Expect `202`. Then check the receipts landed:

```bash
BUCKET=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name DispatchPipeline \
  --query 'Stacks[0].Outputs[?OutputKey==`ReceiptsBucketName`].OutputValue' --output text)

aws s3 ls "s3://$BUCKET/receipts/" --recursive
```

**Step 4 — the actual lesson.** Break it on purpose:
1. Set consumer env `REPORT_BATCH_ITEM_FAILURES=false` and `DELIVERY_FAILURE_RATE=0.2`
2. `pnpm loadtest --endpoint "$ENDPOINT" --recipients 10000 --campaign-size 2000`
3. Compare consumer **invocation count** against **messages enqueued**. The gap is the amplification.

**Step 5 — fix and measure.** Flip it back to `true`, rerun, record both numbers in the README Results table.

## Always

```bash
pnpm cdk:destroy    # after every session
```

## Rules for this project

- Only real, measured numbers go in the README Results table.
- `pnpm typecheck` is **your** job — the assistant does not build.
- Ask *why* before *what to type*.
