import type { Recipient } from '../domain/campaign'
import type { DeliveryChannel } from '../application/ports'

export interface SimulatedDeliveryOptions {
  /** Simulated per-recipient latency, in milliseconds. */
  readonly latencyMs: number
  /** Fraction of deliveries that fail, 0..1. Drives DLQ and alarm behaviour. */
  readonly failureRate: number
}

/**
 * Stands in for a real email/SMS provider.
 *
 * The point of this project is the pipeline, not the delivery mechanism — but the
 * failure rate is load-bearing: it is what pushes messages into the DLQ and makes
 * the CloudWatch alarms fire, so the failure path can actually be observed.
 */
export class SimulatedDeliveryChannel implements DeliveryChannel {
  constructor(private readonly options: SimulatedDeliveryOptions) {}

  async deliver(recipient: Recipient): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs))

    if (Math.random() < this.options.failureRate) {
      throw new Error(`downstream provider rejected ${recipient.address}`)
    }
  }
}
