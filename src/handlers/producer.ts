import { SQSClient } from '@aws-sdk/client-sqs'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { dispatchCampaign } from '../application/dispatch-campaign'
import { systemClock, uuidGenerator } from '../application/ports'
import { InvalidCampaignError } from '../domain/errors'
import { SqsPublisher } from '../infrastructure/sqs-publisher'
import { requireEnv } from './env'

// Created once per container, not per invocation. Reusing the client across warm
// invocations is the single cheapest cold-path optimisation in Lambda: it keeps the
// TLS handshake and credential resolution out of the request path.
const client = new SQSClient({})
const queueUrl = requireEnv('QUEUE_URL')
const recipientsPerMessage = Number(process.env.RECIPIENTS_PER_MESSAGE ?? '25')

const publisher = new SqsPublisher(client, queueUrl)

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  let payload: unknown

  try {
    payload = JSON.parse(event.body ?? '')
  } catch {
    return json(400, { error: 'request body must be valid JSON' })
  }

  try {
    const result = await dispatchCampaign(payload, {
      publisher,
      clock: systemClock,
      ids: uuidGenerator,
      recipientsPerMessage,
    })

    // 202, not 201: nothing has been delivered yet. The queue has accepted the work.
    return json(202, result)
  } catch (error) {
    if (error instanceof InvalidCampaignError) {
      return json(400, { error: error.message })
    }

    // Anything else is ours, not the caller's. Log it for CloudWatch and return 500
    // so API Gateway records a 5xx the error-rate alarm can see.
    console.error('dispatch failed', { error: serialise(error) })
    return json(500, { error: 'internal error' })
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function serialise(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
