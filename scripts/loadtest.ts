/**
 * Pushes synthetic campaigns at the deployed API and reports enqueue throughput.
 *
 * This measures the INGEST side only — how fast the producer accepts work. The
 * number that matters for the README is the drain time, which you read off the
 * CloudWatch queue-depth graph after this finishes.
 *
 * Usage:
 *   pnpm loadtest --endpoint https://xxx.execute-api.us-east-1.amazonaws.com/campaigns \
 *                 --recipients 100000 --campaign-size 5000
 */

interface Options {
  endpoint: string
  recipients: number
  campaignSize: number
  concurrency: number
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string, fallback?: string): string => {
    const index = argv.indexOf(flag)
    const value = index >= 0 ? argv[index + 1] : undefined
    if (value === undefined) {
      if (fallback === undefined) {
        throw new Error(`missing required flag ${flag}`)
      }
      return fallback
    }
    return value
  }

  return {
    endpoint: get('--endpoint'),
    recipients: Number(get('--recipients', '100000')),
    campaignSize: Number(get('--campaign-size', '5000')),
    concurrency: Number(get('--concurrency', '4')),
  }
}

function buildCampaign(index: number, size: number) {
  return {
    name: `loadtest-campaign-${index}`,
    recipients: Array.from({ length: size }, (_, i) => ({
      id: `c${index}-r${i}`,
      address: `loadtest-${index}-${i}@example.com`,
    })),
  }
}

async function post(endpoint: string, body: unknown): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const campaigns = Math.ceil(options.recipients / options.campaignSize)

  console.log(
    `Sending ${options.recipients} recipients as ${campaigns} campaign(s) ` +
      `of ${options.campaignSize}, ${options.concurrency} at a time`,
  )

  const started = performance.now()
  let completed = 0
  let failed = 0

  const queue = Array.from({ length: campaigns }, (_, i) => i)

  const workers = Array.from({ length: options.concurrency }, async () => {
    for (;;) {
      const index = queue.shift()
      if (index === undefined) return

      try {
        await post(options.endpoint, buildCampaign(index, options.campaignSize))
        completed += 1
      } catch (error) {
        failed += 1
        console.error(`campaign ${index} failed:`, error instanceof Error ? error.message : error)
      }

      process.stdout.write(`\r  ${completed + failed}/${campaigns} campaigns`)
    }
  })

  await Promise.all(workers)

  const elapsedSeconds = (performance.now() - started) / 1000
  const enqueued = completed * options.campaignSize

  console.log('\n')
  console.log(`Campaigns accepted : ${completed}/${campaigns}${failed ? ` (${failed} failed)` : ''}`)
  console.log(`Recipients enqueued: ${enqueued}`)
  console.log(`Elapsed            : ${elapsedSeconds.toFixed(1)}s`)
  console.log(`Ingest rate        : ${Math.round(enqueued / elapsedSeconds)} recipients/s`)
  console.log('')
  console.log('Now watch the CloudWatch dashboard "dispatch-pipeline" and record the')
  console.log('drain time from the queue-depth graph. That is the number for the README.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
