import { z } from 'zod'
import { recipientSchema } from './campaign'
import { MalformedMessageError } from './errors'

/**
 * The payload carried by one SQS message: a slice of a campaign's recipients.
 *
 * Kept small on purpose. SQS retries at message granularity, so if any recipient
 * in a message fails, the whole message is redelivered — a fat message means a lot
 * of redundant redelivery. See the "Message sizing" note in the README.
 */
export const deliveryMessageSchema = z.object({
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  recipients: z.array(recipientSchema).min(1),
})

export type DeliveryMessage = z.infer<typeof deliveryMessageSchema>

export function parseDeliveryMessage(input: unknown): DeliveryMessage {
  const result = deliveryMessageSchema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new MalformedMessageError(detail)
  }
  return result.data
}

export type DeliveryStatus = 'delivered' | 'failed'

export interface DeliveryReceipt {
  readonly campaignId: string
  readonly recipientId: string
  readonly address: string
  readonly status: DeliveryStatus
  readonly attemptedAt: string
  readonly error?: string
}

/**
 * Receipt storage key.
 *
 * Deterministic by design: a redelivered message rewrites the same object rather
 * than appending a duplicate, which is what makes the consumer idempotent under
 * SQS at-least-once delivery. Date-partitioned so the prefix stays queryable.
 */
export function receiptKey(receipt: DeliveryReceipt): string {
  const day = receipt.attemptedAt.slice(0, 10)
  return `receipts/dt=${day}/campaign=${receipt.campaignId}/${receipt.recipientId}.json`
}
