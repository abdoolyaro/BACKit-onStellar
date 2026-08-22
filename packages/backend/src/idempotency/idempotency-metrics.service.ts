import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IDEMPOTENCY_EVENTS,
  IdempotencyMetricsEvent,
} from './idempotency.events';

/**
 * IdempotencyMetricsService
 *
 * Listens to idempotency lifecycle events and maintains in-process counters.
 * These are exposed via GET /idempotency/metrics so the ops team can scrape
 * them without a full Prometheus stack.
 *
 * Counter semantics:
 *   - claimed    : first successful claim (new key, or retryable re-claim).
 *   - replayed   : stored response returned to a duplicate request.
 *   - conflicted : key reused with a different request payload.
 *   - inProgress : duplicate request arrived while another was executing.
 *   - failed     : operation ended with a terminal (non-retryable) failure.
 *   - retryable  : operation ended with a transient, retryable failure.
 */
@Injectable()
export class IdempotencyMetricsService {
  private readonly logger = new Logger(IdempotencyMetricsService.name);

  readonly counters = {
    claimed: 0,
    replayed: 0,
    conflicted: 0,
    inProgress: 0,
    failed: 0,
    retryable: 0,
  };

  @OnEvent(IDEMPOTENCY_EVENTS.CLAIMED)
  onClaimed(): void {
    this.counters.claimed++;
  }

  @OnEvent(IDEMPOTENCY_EVENTS.REPLAYED)
  onReplayed(): void {
    this.counters.replayed++;
  }

  @OnEvent(IDEMPOTENCY_EVENTS.CONFLICTED)
  onConflicted(e: IdempotencyMetricsEvent): void {
    this.counters.conflicted++;
    this.logger.warn(
      `Idempotency conflict: key="${e.key}" route="${e.route}" principal="${e.principal}"`,
    );
  }

  @OnEvent(IDEMPOTENCY_EVENTS.IN_PROGRESS)
  onInProgress(): void {
    this.counters.inProgress++;
  }

  @OnEvent(IDEMPOTENCY_EVENTS.FAILED)
  onFailed(): void {
    this.counters.failed++;
  }

  @OnEvent(IDEMPOTENCY_EVENTS.RETRYABLE)
  onRetryable(): void {
    this.counters.retryable++;
  }

  /** Snapshot the current counter values. */
  getSnapshot() {
    return { ...this.counters };
  }
}
