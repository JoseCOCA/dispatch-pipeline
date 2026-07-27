import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs'
import type { SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs'
import { chunk } from '../domain/campaign'
import type { DeliveryMessage } from '../domain/delivery'
import type { MessagePublisher } from '../application/ports'

/**
 * Hard AWS limit: SendMessageBatch accepts at most 10 entries per call.
 *
 * This lives here and not in the domain on purpose — it is a property of SQS, not
 * of what a campaign is. The domain-level "recipients per message" knob is separate.
 */
const SQS_MAX_BATCH_ENTRIES = 10

export class SqsPublisher implements MessagePublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly DeliveryMessage[]): Promise<void> {
    if (messages.length === 0) return

    const batches = chunk(messages, SQS_MAX_BATCH_ENTRIES)

    // Batches are sent concurrently; a 100k-recipient campaign is 160 calls at
    // 25 recipients/message, and doing those serially would blow the API Gateway
    // 30s integration timeout.
    await Promise.all(batches.map((batch, index) => this.sendBatch(batch, index)))
  }

  private async sendBatch(batch: readonly DeliveryMessage[], batchIndex: number): Promise<void> {
    const entries: SendMessageBatchRequestEntry[] = batch.map((message, index) => ({
      Id: `${batchIndex}-${index}`,
      MessageBody: JSON.stringify(message),
    }))

    const response = await this.client.send(
      new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: entries }),
    )

    // SendMessageBatch returns 200 even when individual entries fail. Ignoring
    // `Failed` is the classic way to silently drop messages while the caller sees
    // a success — so treat any failed entry as a failure of the whole publish.
    if (response.Failed && response.Failed.length > 0) {
      const detail = response.Failed.map(
        (failure) => `${failure.Id}: ${failure.Code} ${failure.Message ?? ''}`.trim(),
      ).join('; ')
      throw new Error(`SQS rejected ${response.Failed.length} message(s): ${detail}`)
    }
  }
}
