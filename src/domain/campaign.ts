import { z } from 'zod'
import { InvalidCampaignError } from './errors'

/**
 * Upper bound on a single campaign. This is a *domain* limit (what the business
 * considers one campaign), deliberately independent of the SQS batch limit of 10,
 * which is an infrastructure constraint and lives in the adapter.
 */
export const MAX_RECIPIENTS_PER_CAMPAIGN = 100_000

export const recipientSchema = z.object({
  id: z.string().min(1, 'recipient id is required'),
  address: z.email('recipient address must be a valid email'),
})

export type Recipient = z.infer<typeof recipientSchema>

export const campaignRequestSchema = z.object({
  name: z.string().min(1, 'campaign name is required').max(200),
  recipients: z
    .array(recipientSchema)
    .min(1, 'a campaign needs at least one recipient')
    .max(MAX_RECIPIENTS_PER_CAMPAIGN, `a campaign cannot exceed ${MAX_RECIPIENTS_PER_CAMPAIGN} recipients`),
})

export type CampaignRequest = z.infer<typeof campaignRequestSchema>

export interface Campaign {
  readonly id: string
  readonly name: string
  readonly recipients: readonly Recipient[]
  readonly createdAt: string
}

/**
 * Parses untrusted input into a CampaignRequest, or throws InvalidCampaignError.
 * Every boundary into the domain goes through here.
 */
export function parseCampaignRequest(input: unknown): CampaignRequest {
  const result = campaignRequestSchema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new InvalidCampaignError(detail)
  }
  return result.data
}

/**
 * Builds a Campaign and enforces the invariant that recipient ids are unique.
 *
 * Duplicate ids matter because receipts are keyed by (campaignId, recipientId) in
 * S3 — two recipients sharing an id would silently overwrite each other's receipt
 * and corrupt the delivery record.
 */
export function createCampaign(request: CampaignRequest, id: string, createdAt: Date): Campaign {
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const recipient of request.recipients) {
    if (seen.has(recipient.id)) {
      duplicates.add(recipient.id)
    }
    seen.add(recipient.id)
  }

  if (duplicates.size > 0) {
    const listed = [...duplicates].sort().join(', ')
    throw new InvalidCampaignError(`duplicate recipient ids: ${listed}`)
  }

  return {
    id,
    name: request.name,
    recipients: request.recipients,
    createdAt: createdAt.toISOString(),
  }
}

/** Splits a list into fixed-size groups. The final group may be smaller. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, received ${size}`)
  }

  const groups: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size))
  }
  return groups
}
