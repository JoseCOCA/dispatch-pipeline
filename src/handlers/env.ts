/**
 * Fails at container init rather than mid-invocation. A missing env var should
 * break the very first request loudly, not surface as a confusing runtime error
 * on message number 40,000.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`)
  }
  return value
}
