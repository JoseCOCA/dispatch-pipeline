import { describe, expect, it, vi } from 'vitest'
import { processDelivery } from '../../src/application/process-delivery'
import type { ProcessDeliveryDeps } from '../../src/application/process-delivery'
import type { DeliveryChannel, ReceiptWriter } from '../../src/application/ports'
import type { DeliveryReceipt } from '../../src/domain/delivery'
import { MalformedMessageError } from '../../src/domain/errors'

class RecordingReceiptWriter implements ReceiptWriter {
  readonly written: DeliveryReceipt[] = []

  async write(receipts: readonly DeliveryReceipt[]): Promise<void> {
    this.written.push(...receipts)
  }
}

/** Fails for the recipient ids it was given, succeeds for everyone else. */
const channelFailing = (...failingIds: string[]): DeliveryChannel => ({
  deliver: async (recipient) => {
    if (failingIds.includes(recipient.id)) {
      throw new Error(`mailbox full: ${recipient.id}`)
    }
  },
})

const message = (ids: string[]) => ({
  campaignId: 'campaign-abc',
  campaignName: 'Launch',
  recipients: ids.map((id) => ({ id, address: `${id}@example.com` })),
})

const buildDeps = (channel: DeliveryChannel, receipts: ReceiptWriter): ProcessDeliveryDeps => ({
  channel,
  receipts,
  clock: { now: () => new Date('2026-07-27T10:00:00.000Z') },
})

describe('processDelivery', () => {
  it('delivers every recipient and records a receipt each', async () => {
    const receipts = new RecordingReceiptWriter()

    const result = await processDelivery(
      message(['r1', 'r2', 'r3']),
      buildDeps(channelFailing(), receipts),
    )

    expect(result.delivered).toBe(3)
    expect(result.failed).toBe(0)
    expect(receipts.written).toHaveLength(3)
    expect(receipts.written.every((r) => r.status === 'delivered')).toBe(true)
  })

  it('keeps delivering siblings after one recipient fails', async () => {
    const receipts = new RecordingReceiptWriter()

    const result = await processDelivery(
      message(['r1', 'r2', 'r3']),
      buildDeps(channelFailing('r2'), receipts),
    )

    expect(result.delivered).toBe(2)
    expect(result.failed).toBe(1)

    const byId = Object.fromEntries(receipts.written.map((r) => [r.recipientId, r]))
    expect(byId.r1.status).toBe('delivered')
    expect(byId.r3.status).toBe('delivered')
    expect(byId.r2.status).toBe('failed')
    expect(byId.r2.error).toBe('mailbox full: r2')
  })

  it('records receipts even when every recipient fails', async () => {
    const receipts = new RecordingReceiptWriter()

    const result = await processDelivery(
      message(['r1', 'r2']),
      buildDeps(channelFailing('r1', 'r2'), receipts),
    )

    expect(result.delivered).toBe(0)
    expect(result.failed).toBe(2)
    expect(receipts.written).toHaveLength(2)
  })

  it('does not throw on partial failure — the handler owns that decision', async () => {
    const receipts = new RecordingReceiptWriter()

    await expect(
      processDelivery(message(['r1', 'r2']), buildDeps(channelFailing('r1'), receipts)),
    ).resolves.toMatchObject({ failed: 1 })
  })

  it('attempts recipients concurrently rather than one after another', async () => {
    const receipts = new RecordingReceiptWriter()
    let inFlight = 0
    let peak = 0

    const channel: DeliveryChannel = {
      deliver: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
      },
    }

    await processDelivery(message(['r1', 'r2', 'r3', 'r4']), buildDeps(channel, receipts))

    expect(peak).toBe(4)
  })

  it('rejects a malformed message without writing receipts', async () => {
    const receipts = new RecordingReceiptWriter()
    const channel = { deliver: vi.fn() }

    await expect(
      processDelivery({ campaignId: 'c1', recipients: [] }, buildDeps(channel, receipts)),
    ).rejects.toThrow(MalformedMessageError)

    expect(channel.deliver).not.toHaveBeenCalled()
    expect(receipts.written).toHaveLength(0)
  })

  it('stamps all receipts in a message with the same attempt time', async () => {
    const receipts = new RecordingReceiptWriter()

    await processDelivery(message(['r1', 'r2']), buildDeps(channelFailing('r2'), receipts))

    expect(new Set(receipts.written.map((r) => r.attemptedAt)).size).toBe(1)
    expect(receipts.written[0].attemptedAt).toBe('2026-07-27T10:00:00.000Z')
  })
})
