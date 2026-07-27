import { parseDeliveryMessage } from '../domain/delivery'
import type { DeliveryReceipt } from '../domain/delivery'
import type { Clock, DeliveryChannel, ReceiptWriter } from './ports'

export interface ProcessDeliveryDeps {
  readonly channel: DeliveryChannel
  readonly receipts: ReceiptWriter
  readonly clock: Clock
}

export interface ProcessDeliveryResult {
  readonly campaignId: string
  readonly delivered: number
  readonly failed: number
  readonly receipts: readonly DeliveryReceipt[]
}

/**
 * Delivers every recipient in one queue message and records a receipt for each.
 *
 * Recipients are attempted concurrently and independently: one failure must not
 * abort the siblings, or a single bad address would drag an entire message through
 * the retry cycle repeatedly. Hence allSettled rather than Promise.all.
 *
 * Returns a result with a `failed` count. It deliberately does NOT throw on partial
 * failure — the caller (the handler) decides what partial failure means for SQS.
 */
export async function processDelivery(
  input: unknown,
  deps: ProcessDeliveryDeps,
): Promise<ProcessDeliveryResult> {
  const message = parseDeliveryMessage(input)
  const attemptedAt = deps.clock.now().toISOString()

  const settled = await Promise.allSettled(
    message.recipients.map(async (recipient) => {
      await deps.channel.deliver(recipient)
    }),
  )

  const receipts: DeliveryReceipt[] = settled.map((outcome, index) => {
    const recipient = message.recipients[index]
    const base = {
      campaignId: message.campaignId,
      recipientId: recipient.id,
      address: recipient.address,
      attemptedAt,
    }

    if (outcome.status === 'fulfilled') {
      return { ...base, status: 'delivered' as const }
    }

    return {
      ...base,
      status: 'failed' as const,
      error: errorMessage(outcome.reason),
    }
  })

  // Receipts are written even when deliveries failed: the record of the attempt is
  // the point. Writing is idempotent (deterministic S3 key), so a redelivered
  // message overwrites rather than duplicates.
  await deps.receipts.write(receipts)

  const failed = receipts.filter((receipt) => receipt.status === 'failed').length

  return {
    campaignId: message.campaignId,
    delivered: receipts.length - failed,
    failed,
    receipts,
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}
