import type { Recipient } from '../domain/campaign'
import type { DeliveryMessage, DeliveryReceipt } from '../domain/delivery'

/**
 * Ports. The application layer depends on these interfaces only; the concrete
 * SQS / S3 adapters live in src/infrastructure and are injected at the handler
 * boundary. This is what lets every test below run with zero AWS involved.
 */

export interface MessagePublisher {
  /** Publishes every message, or throws. Batching is the adapter's concern. */
  publish(messages: readonly DeliveryMessage[]): Promise<void>
}

export interface DeliveryChannel {
  /** Delivers to one recipient. Throwing means "failed, may be retried". */
  deliver(recipient: Recipient): Promise<void>
}

export interface ReceiptWriter {
  write(receipts: readonly DeliveryReceipt[]): Promise<void>
}

export interface Clock {
  now(): Date
}

export interface IdGenerator {
  next(): string
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export const uuidGenerator: IdGenerator = {
  next: () => globalThis.crypto.randomUUID(),
}
