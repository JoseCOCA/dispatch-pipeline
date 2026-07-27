import { chunk, createCampaign, parseCampaignRequest } from '../domain/campaign'
import type { DeliveryMessage } from '../domain/delivery'
import type { Clock, IdGenerator, MessagePublisher } from './ports'

export interface DispatchCampaignDeps {
  readonly publisher: MessagePublisher
  readonly clock: Clock
  readonly ids: IdGenerator
  /**
   * How many recipients ride in a single SQS message.
   *
   * Trade-off: larger values mean fewer SQS requests (cheaper, faster to enqueue)
   * but more redundant work when a message is redelivered, since SQS retries whole
   * messages. 25 keeps a retry cheap while cutting request count 25x.
   */
  readonly recipientsPerMessage: number
}

export interface DispatchCampaignResult {
  readonly campaignId: string
  readonly recipientCount: number
  readonly messageCount: number
  readonly acceptedAt: string
}

/**
 * Validates a campaign request, fans it out onto the queue, and returns immediately.
 *
 * Nothing is delivered here — this is the "accept fast, work asynchronously" half of
 * the pipeline. The caller gets a 202 and a campaign id to correlate against.
 */
export async function dispatchCampaign(
  input: unknown,
  deps: DispatchCampaignDeps,
): Promise<DispatchCampaignResult> {
  const request = parseCampaignRequest(input)
  const acceptedAt = deps.clock.now()
  const campaign = createCampaign(request, deps.ids.next(), acceptedAt)

  const messages: DeliveryMessage[] = chunk(campaign.recipients, deps.recipientsPerMessage).map(
    (recipients) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      recipients,
    }),
  )

  await deps.publisher.publish(messages)

  return {
    campaignId: campaign.id,
    recipientCount: campaign.recipients.length,
    messageCount: messages.length,
    acceptedAt: campaign.createdAt,
  }
}
