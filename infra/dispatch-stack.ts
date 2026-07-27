import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch'
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions'
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions'
import { Queue } from 'aws-cdk-lib/aws-sqs'
import type { Construct } from 'constructs'

/**
 * Consumer timeout. Everything downstream is derived from it, so it is declared once.
 */
const CONSUMER_TIMEOUT = Duration.seconds(30)

/**
 * Ceiling on concurrent consumer executions.
 *
 * This is the knob that protects downstream systems. Lambda will happily scale to
 * a thousand concurrent executions and exhaust a database connection pool long
 * before the queue drains — the same constraint that makes a serverless HTTP driver
 * necessary in front of Postgres. Cap it here, deliberately, rather than discovering
 * the limit in production.
 */
const MAX_CONSUMER_CONCURRENCY = 10

export interface DispatchPipelineStackProps extends StackProps {
  /** Where alarms are sent. Pass with: cdk deploy -c alertEmail=you@example.com */
  readonly alertEmail?: string
}

export class DispatchPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: DispatchPipelineStackProps = {}) {
    super(scope, id, props)

    // ---------------------------------------------------------------- storage --

    const receiptsBucket = new Bucket(this, 'ReceiptsBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      // This is a teardownable demo, not a system of record. Both flags exist so
      // `cdk destroy` actually leaves a clean account behind — never do this on a
      // bucket that holds anything you would miss.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'expire-receipts',
          expiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    })

    // ----------------------------------------------------------------- queues --

    const deadLetterQueue = new Queue(this, 'DeliveryDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    })

    const deliveryQueue = new Queue(this, 'DeliveryQueue', {
      // Must exceed the consumer timeout, or SQS hands the same message to a second
      // consumer while the first is still working on it. AWS recommends 6x to leave
      // room for retries inside the invocation.
      visibilityTimeout: Duration.seconds(CONSUMER_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    })

    // -------------------------------------------------------------- functions --

    const bundling = {
      format: OutputFormat.ESM,
      minify: true,
      sourceMap: true,
      target: 'node22',
    }

    const producer = new NodejsFunction(this, 'Producer', {
      entry: 'src/handlers/producer.ts',
      runtime: Runtime.NODEJS_22_X,
      // ARM64 is ~20% cheaper per GB-second than x86 and, for this workload, no
      // slower. Measure both before writing the number in the README.
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      logRetention: RetentionDays.ONE_WEEK,
      bundling,
      environment: {
        QUEUE_URL: deliveryQueue.queueUrl,
        RECIPIENTS_PER_MESSAGE: '25',
      },
    })

    const consumer = new NodejsFunction(this, 'Consumer', {
      entry: 'src/handlers/consumer.ts',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: CONSUMER_TIMEOUT,
      reservedConcurrentExecutions: MAX_CONSUMER_CONCURRENCY,
      logRetention: RetentionDays.ONE_WEEK,
      bundling,
      environment: {
        RECEIPTS_BUCKET: receiptsBucket.bucketName,
        DELIVERY_LATENCY_MS: '50',
        DELIVERY_FAILURE_RATE: '0.02',
        REPORT_BATCH_ITEM_FAILURES: 'true',
      },
    })

    // ------------------------------------------------------------------- IAM --

    // Least privilege, generated from intent. grantSendMessages produces a policy
    // scoped to this one queue ARN — the same discipline as a hand-written inline
    // policy, minus the chance of a typo widening it to "*".
    deliveryQueue.grantSendMessages(producer)
    deliveryQueue.grantConsumeMessages(consumer)

    // grantPut, not grantWrite: the consumer never needs s3:DeleteObject.
    receiptsBucket.grantPut(consumer)

    // ---------------------------------------------------------- event source --

    consumer.addEventSource(
      new SqsEventSource(deliveryQueue, {
        batchSize: 10,
        // Waits up to 5s to fill a batch. Fewer, fuller invocations cost less and
        // raise throughput; the cost is up to 5s of added latency per message.
        maxBatchingWindow: Duration.seconds(5),
        // The whole point. Without this, one bad message in a batch of ten forces
        // all ten to be redelivered — including the nine that already succeeded.
        reportBatchItemFailures: true,
        maxConcurrency: MAX_CONSUMER_CONCURRENCY,
      }),
    )

    // ------------------------------------------------------------------- API --

    const api = new HttpApi(this, 'DispatchApi', {
      apiName: 'dispatch-pipeline',
      description: 'Accepts campaigns and fans them out onto SQS',
    })

    api.addRoutes({
      path: '/campaigns',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('ProducerIntegration', producer),
    })

    // --------------------------------------------------------------- alarming --

    const alarmTopic = new Topic(this, 'AlarmTopic', {
      displayName: 'dispatch-pipeline alarms',
    })

    if (props.alertEmail) {
      alarmTopic.addSubscription(new EmailSubscription(props.alertEmail))
    }

    const alarms = [
      new Alarm(this, 'DlqNotEmpty', {
        alarmDescription: 'A message failed 3 times and landed in the DLQ',
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),

      new Alarm(this, 'ConsumerErrors', {
        alarmDescription: 'Consumer is throwing, not just reporting item failures',
        metric: consumer.metricErrors({ period: Duration.minutes(1), statistic: 'Sum' }),
        threshold: 5,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),

      new Alarm(this, 'QueueBacklogAging', {
        alarmDescription: 'Oldest message is over 60s old — consumers are not keeping up',
        metric: deliveryQueue.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 60,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    ]

    for (const alarm of alarms) {
      alarm.addAlarmAction(new SnsAction(alarmTopic))
    }

    // -------------------------------------------------------------- dashboard --

    const dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: 'dispatch-pipeline',
    })

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Queue depth',
        left: [
          deliveryQueue.metricApproximateNumberOfMessagesVisible(),
          deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: 'Consumer duration (p50 / p99)',
        left: [
          consumer.metricDuration({ statistic: 'p50' }),
          consumer.metricDuration({ statistic: 'p99' }),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: 'Invocations and errors',
        left: [consumer.metricInvocations(), consumer.metricErrors()],
        width: 12,
      }),
      new GraphWidget({
        title: 'Oldest message age (s)',
        left: [deliveryQueue.metricApproximateAgeOfOldestMessage()],
        width: 12,
      }),
    )

    // ---------------------------------------------------------------- outputs --

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint })
    new CfnOutput(this, 'CampaignsEndpoint', { value: `${api.apiEndpoint}/campaigns` })
    new CfnOutput(this, 'QueueUrl', { value: deliveryQueue.queueUrl })
    new CfnOutput(this, 'DlqUrl', { value: deadLetterQueue.queueUrl })
    new CfnOutput(this, 'ReceiptsBucketName', { value: receiptsBucket.bucketName })
  }
}
