/**
 * Domain errors. These carry no AWS or transport concerns — a handler decides
 * how to map them onto an HTTP status or an SQS batch item failure.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The caller sent something that can never become a valid campaign. Not retryable. */
export class InvalidCampaignError extends DomainError {}

/** A message pulled off the queue does not match the expected contract. Not retryable. */
export class MalformedMessageError extends DomainError {}
