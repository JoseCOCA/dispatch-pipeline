import { S3Client } from '@aws-sdk/client-s3'
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda'
import { processDelivery } from '../application/process-delivery'
import { systemClock } from '../application/ports'
import { S3ReceiptWriter } from '../infrastructure/s3-receipt-writer'
import { SimulatedDeliveryChannel } from '../infrastructure/simulated-delivery-channel'
import { requireEnv } from './env'

const s3 = new S3Client({})
const bucket = requireEnv('RECEIPTS_BUCKET')

const receipts = new S3ReceiptWriter(s3, bucket)
const channel = new SimulatedDeliveryChannel({
  latencyMs: Number(process.env.DELIVERY_LATENCY_MS ?? '50'),
  failureRate: Number(process.env.DELIVERY_FAILURE_RATE ?? '0.02'),
})

/**
 * Teaching switch — see README §"The partial batch failure experiment".
 *
 * When false, the handler returns an empty response, which is what a naive SQS
 * consumer does. AWS then treats the ENTIRE batch as failed if anything went wrong,
 * redelivering the messages that already succeeded. Flip this to observe duplicate
 * delivery under load, then flip it back.
 *
 * Defaults to true. The correct behaviour is the default; the bug is opt-in.
 */
const reportBatchItemFailures = process.env.REPORT_BATCH_ITEM_FAILURES !== 'false'

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = []

  // Records within a batch are processed concurrently: they are independent units
  // of work, and this Lambda is I/O bound, so serialising them would waste most of
  // the billed duration waiting on the network.
  await Promise.all(
    event.Records.map(async (record) => {
      const failure = await handleRecord(record)
      if (failure) {
        batchItemFailures.push(failure)
      }
    }),
  )

  if (!reportBatchItemFailures) {
    // Deliberately wrong path, kept for the experiment. AWS reads an empty response
    // as "the whole batch succeeded" only when the invocation itself did not throw —
    // combined with a thrown error it means "retry everything".
    return {} as SQSBatchResponse
  }

  return { batchItemFailures }
}

async function handleRecord(record: SQSRecord): Promise<SQSBatchItemFailure | undefined> {
  try {
    const result = await processDelivery(JSON.parse(record.body), {
      channel,
      receipts,
      clock: systemClock,
    })

    // Embedded Metric Format: CloudWatch extracts metrics from the log line itself,
    // so there is no PutMetricData call on the hot path — no added latency, no
    // throttling risk, and it costs a fraction as much at this volume.
    emitMetrics(result.delivered, result.failed)

    if (result.failed > 0) {
      // SQS retries at message granularity, so any failed recipient means this
      // message must be retried. Receipts are idempotent, so the recipients that
      // already succeeded are simply rewritten rather than double-delivered.
      console.warn('partial delivery failure', {
        messageId: record.messageId,
        campaignId: result.campaignId,
        delivered: result.delivered,
        failed: result.failed,
      })
      return { itemIdentifier: record.messageId }
    }

    return undefined
  } catch (error) {
    console.error('record failed', {
      messageId: record.messageId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return { itemIdentifier: record.messageId }
  }
}

function emitMetrics(delivered: number, failed: number): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'DispatchPipeline',
            Dimensions: [[]],
            Metrics: [
              { Name: 'MessagesDelivered', Unit: 'Count' },
              { Name: 'MessagesFailed', Unit: 'Count' },
            ],
          },
        ],
      },
      MessagesDelivered: delivered,
      MessagesFailed: failed,
    }),
  )
}
