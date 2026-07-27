import { describe, expect, it } from 'vitest'
import {
  MAX_RECIPIENTS_PER_CAMPAIGN,
  chunk,
  createCampaign,
  parseCampaignRequest,
} from '../../src/domain/campaign'
import { InvalidCampaignError } from '../../src/domain/errors'

const recipient = (id: string, address = `${id}@example.com`) => ({ id, address })

describe('parseCampaignRequest', () => {
  it('accepts a well-formed request', () => {
    const request = parseCampaignRequest({
      name: 'Launch announcement',
      recipients: [recipient('r1'), recipient('r2')],
    })

    expect(request.name).toBe('Launch announcement')
    expect(request.recipients).toHaveLength(2)
  })

  it('rejects a campaign with no recipients', () => {
    expect(() => parseCampaignRequest({ name: 'Empty', recipients: [] })).toThrow(
      InvalidCampaignError,
    )
  })

  it('rejects an invalid email address and names the offending path', () => {
    expect(() =>
      parseCampaignRequest({ name: 'Bad', recipients: [{ id: 'r1', address: 'not-an-email' }] }),
    ).toThrow(/recipients\.0\.address/)
  })

  it('rejects a missing campaign name', () => {
    expect(() => parseCampaignRequest({ recipients: [recipient('r1')] })).toThrow(
      InvalidCampaignError,
    )
  })

  it('rejects a campaign over the domain limit', () => {
    const recipients = Array.from({ length: MAX_RECIPIENTS_PER_CAMPAIGN + 1 }, (_, i) =>
      recipient(`r${i}`),
    )

    expect(() => parseCampaignRequest({ name: 'Too big', recipients })).toThrow(
      InvalidCampaignError,
    )
  })
})

describe('createCampaign', () => {
  const at = new Date('2026-07-27T10:00:00.000Z')

  it('stamps the generated id and creation time', () => {
    const request = parseCampaignRequest({ name: 'Launch', recipients: [recipient('r1')] })
    const campaign = createCampaign(request, 'campaign-123', at)

    expect(campaign.id).toBe('campaign-123')
    expect(campaign.createdAt).toBe('2026-07-27T10:00:00.000Z')
  })

  it('rejects duplicate recipient ids, because receipts are keyed by them', () => {
    const request = parseCampaignRequest({
      name: 'Launch',
      recipients: [recipient('r1'), recipient('r2'), recipient('r1', 'other@example.com')],
    })

    expect(() => createCampaign(request, 'c1', at)).toThrow(/duplicate recipient ids: r1/)
  })

  it('reports every duplicated id, not just the first', () => {
    const request = parseCampaignRequest({
      name: 'Launch',
      recipients: [
        recipient('r1'),
        recipient('r1', 'a@example.com'),
        recipient('r2'),
        recipient('r2', 'b@example.com'),
      ],
    })

    expect(() => createCampaign(request, 'c1', at)).toThrow(/r1, r2/)
  })

  it('allows two recipients sharing an address but not an id', () => {
    const request = parseCampaignRequest({
      name: 'Launch',
      recipients: [recipient('r1', 'same@example.com'), recipient('r2', 'same@example.com')],
    })

    expect(() => createCampaign(request, 'c1', at)).not.toThrow()
  })
})

describe('chunk', () => {
  it('splits evenly when the size divides the input', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('leaves a smaller final group', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns no groups for an empty input', () => {
    expect(chunk([], 10)).toEqual([])
  })

  it('handles a size larger than the input', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]])
  })

  it.each([0, -1, 1.5])('rejects an invalid size (%s)', (size) => {
    expect(() => chunk([1, 2], size)).toThrow(RangeError)
  })
})
