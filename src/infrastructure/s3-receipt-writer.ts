import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { receiptKey } from '../domain/delivery'
import type { DeliveryReceipt } from '../domain/delivery'
import type { ReceiptWriter } from '../application/ports'

export class S3ReceiptWriter implements ReceiptWriter {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async write(receipts: readonly DeliveryReceipt[]): Promise<void> {
    if (receipts.length === 0) return

    // One PUT per receipt, keyed deterministically, so a redelivered SQS message
    // overwrites its own objects instead of creating duplicates. That property is
    // what makes the consumer safe under SQS at-least-once delivery.
    await Promise.all(
      receipts.map((receipt) =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: receiptKey(receipt),
            Body: JSON.stringify(receipt),
            ContentType: 'application/json',
          }),
        ),
      ),
    )
  }
}
