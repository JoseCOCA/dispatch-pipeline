import { App } from 'aws-cdk-lib'
import { DispatchPipelineStack } from '../infra/dispatch-stack'

const app = new App()

new DispatchPipelineStack(app, 'DispatchPipeline', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  alertEmail: app.node.tryGetContext('alertEmail'),
  description: 'Event-driven message fan-out: API Gateway -> Lambda -> SQS -> Lambda -> S3',
})
