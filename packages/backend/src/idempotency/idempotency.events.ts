/** Payload emitted with every idempotency metrics event. */
export interface IdempotencyMetricsEvent {
  key: string;
  route: string;
  principal: string;
}

/** Event names emitted by IdempotencyService via EventEmitter2. */
export const IDEMPOTENCY_EVENTS = {
  CLAIMED: 'idempotency.claimed',
  REPLAYED: 'idempotency.replayed',
  CONFLICTED: 'idempotency.conflicted',
  IN_PROGRESS: 'idempotency.in_progress',
  FAILED: 'idempotency.failed',
  RETRYABLE: 'idempotency.retryable',
} as const;
