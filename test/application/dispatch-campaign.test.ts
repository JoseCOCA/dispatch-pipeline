import { describe, expect, it, vi } from 'vitest'
import { dispatchCampaign } from '../../src/application/dispatch-campaign'
import type { DispatchCampaignDeps } from '../../src/application/dispatch-campaign'
import type { MessagePublisher } from '../../src/application/ports'
import type { DeliveryMessage } from '../../src/domain/delivery'
import { InvalidCampaignError } from '../../src/domain/errors'

class FakePublisher implements MessagePublisher {
  readonly published: DeliveryMessage[] = []

  async publish(messages: readonly DeliveryMessage[]): Promise<void> {
    this.published.push(...messages)
  }
}

const recipients = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `r${i}`, address: `r${i}@example.com` }))

const buildDeps = (
  publisher: MessagePublisher,
  recipientsPerMessage = 25,
): DispatchCampaignDeps => ({
  publisher,
  clock: { now: () => new Date('2026-07-27T10:00:00.000Z') },
  ids: { next: () => 'campaign-abc' },
  recipientsPerMessage,
})

describe('dispatchCampaign', () => {
  it('accepts a campaign and reports what it enqueued', async () => {
    const publisher = new FakePublisher()

    const result = await dispatchCampaign(
      { name: 'Launch', recipients: recipients(100) },
      buildDeps(publisher, 25),
    )

    expect(result).toEqual({
      campaignId: 'campaign-abc',
      recipientCount: 100,
      messageCount: 4,
      acceptedAt: '2026-07-27T10:00:00.000Z',
    })
  })

  it('splits recipients across messages without losing or duplicating any', async () => {
    const publisher = new FakePublisher()

    await dispatchCampaign({ name: 'Launch', recipients: recipients(57) }, buildDeps(publisher, 25))

    expect(publisher.published).toHaveLength(3)
    expect(publisher.published.map((m) => m.recipients.length)).toEqual([25, 25, 7])

    const ids = publisher.published.flatMap((m) => m.recipients.map((r) => r.id))
    expect(new Set(ids).size).toBe(57)
  })

  it('stamps every message with the same campaign id', async () => {
    const publisher = new FakePublisher()

    await dispatchCampaign({ name: 'Launch', recipients: recipients(60) }, buildDeps(publisher, 25))

    expect(publisher.published.every((m) => m.campaignId === 'campaign-abc')).toBe(true)
    expect(publisher.published.every((m) => m.campaignName === 'Launch')).toBe(true)
  })

  it('publishes nothing when validation fails', async () => {
    const publisher = new FakePublisher()

    await expect(
      dispatchCampaign({ name: '', recipients: recipients(10) }, buildDeps(publisher)),
    ).rejects.toThrow(InvalidCampaignError)

    expect(publisher.published).toHaveLength(0)
  })

  it('propagates a publisher failure rather than reporting a false success', async () => {
    const publisher: MessagePublisher = {
      publish: vi.fn().mockRejectedValue(new Error('SQS unavailable')),
    }

    await expect(
      dispatchCampaign({ name: 'Launch', recipients: recipients(10) }, buildDeps(publisher)),
    ).rejects.toThrow('SQS unavailable')
  })

  it('sends a single message when recipients fit in one chunk', async () => {
    const publisher = new FakePublisher()

    const result = await dispatchCampaign(
      { name: 'Launch', recipients: recipients(1) },
      buildDeps(publisher, 25),
    )

    expect(result.messageCount).toBe(1)
    expect(publisher.published[0].recipients).toHaveLength(1)
  })
})
