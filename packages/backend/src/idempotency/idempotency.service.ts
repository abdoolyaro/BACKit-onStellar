import {
  Injectable,
  Logger,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IdempotencyRecord,
  IdempotencyState,
} from './idempotency-record.entity';
import {
  IdempotencyMetricsEvent,
  IDEMPOTENCY_EVENTS,
} from './idempotency.events';

/** How long (ms) a completed/failed record is retained before cleanup. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 h

/** Maximum Idempotency-Key length accepted. */
export const MAX_KEY_LENGTH = 128;

/**
 * HTTP status codes that are classified as *retryable* — the caller may
 * safely retry with the same Idempotency-Key after these transient failures.
 */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * Keys in the response body that are stripped before storage to avoid
 * persisting sensitive data.
 */
const SENSITIVE_KEYS = new Set([
  'xdr',
  'signature',
  'secret',
  'privateKey',
  'token',
  'password',
  'mnemonic',
  'seed',
]);

/**
 * Result returned by `IdempotencyService.claimOrReplay`.
 *
 * - `claimed`  : the key was freshly claimed; the caller should execute the
 *                operation and call `complete` or `fail` afterwards.
 * - `replayed` : a stored response was found and should be returned immediately.
 * - `inProgress`: another request is currently executing under this key.
 * - `conflict` : the same key was submitted with a different request fingerprint.
 */
export type ClaimResult =
  | { status: 'claimed' }
  | { status: 'replayed'; httpStatus: number; body: Record<string, unknown> }
  | { status: 'inProgress' }
  | { status: 'conflict' };

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyRecord)
    private readonly repo: Repository<IdempotencyRecord>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Compute a SHA-256 fingerprint for the given (principal, route, body) tuple.
   * The body is JSON-serialised with keys sorted so insertion order does not
   * affect the digest.
   */
  fingerprint(
    principal: string,
    route: string,
    body: Record<string, unknown>,
  ): string {
    const canonical = JSON.stringify(this.sortedKeys(body));
    return crypto
      .createHash('sha256')
      .update(`${principal}:${route}:${canonical}`)
      .digest('hex');
  }

  /**
   * Attempt to atomically claim an idempotency key.
   *
   * Uses an INSERT … ON CONFLICT DO NOTHING inside a serialisable transaction
   * so concurrent identical requests execute the underlying operation exactly once.
   *
   * @returns `ClaimResult` — see type definition for possible states.
   */
  async claimOrReplay(
    key: string,
    route: string,
    principal: string,
    fp: string,
  ): Promise<ClaimResult> {
    // Use a transaction to avoid a TOCTOU race between SELECT and INSERT.
    return this.dataSource.transaction('SERIALIZABLE', async (em) => {
      const existing = await em.findOne(IdempotencyRecord, {
        where: { key, route, principal },
        lock: { mode: 'pessimistic_write' },
      });

      if (!existing) {
        // First request: atomically insert the IN_PROGRESS placeholder.
        const record = em.create(IdempotencyRecord, {
          key,
          route,
          principal,
          fingerprint: fp,
          state: IdempotencyState.IN_PROGRESS,
          httpStatus: null,
          responseBody: null,
          note: null,
          expiresAt: new Date(Date.now() + DEFAULT_RETENTION_MS),
        });
        await em.save(IdempotencyRecord, record);
        this.emit(IDEMPOTENCY_EVENTS.CLAIMED, { key, route, principal });
        return { status: 'claimed' } as const;
      }

      // Key exists — check fingerprint.
      if (existing.fingerprint !== fp) {
        this.emit(IDEMPOTENCY_EVENTS.CONFLICTED, { key, route, principal });
        return { status: 'conflict' } as const;
      }

      // Same fingerprint.
      if (existing.state === IdempotencyState.IN_PROGRESS) {
        this.emit(IDEMPOTENCY_EVENTS.IN_PROGRESS, { key, route, principal });
        return { status: 'inProgress' } as const;
      }

      if (existing.state === IdempotencyState.RETRYABLE) {
        // Allow the caller to retry: reset to IN_PROGRESS.
        existing.state = IdempotencyState.IN_PROGRESS;
        existing.httpStatus = null;
        existing.responseBody = null;
        existing.note = null;
        existing.expiresAt = new Date(Date.now() + DEFAULT_RETENTION_MS);
        await em.save(IdempotencyRecord, existing);
        this.emit(IDEMPOTENCY_EVENTS.CLAIMED, { key, route, principal });
        return { status: 'claimed' } as const;
      }

      // SUCCESS or terminal FAILED — replay stored response.
      this.emit(IDEMPOTENCY_EVENTS.REPLAYED, { key, route, principal });
      return {
        status: 'replayed',
        httpStatus: existing.httpStatus ?? HttpStatus.OK,
        body: existing.responseBody ?? {},
      } as const;
    });
  }

  /**
   * Mark a previously claimed key as successfully completed and store the
   * sanitised response for future replays.
   */
  async complete(
    key: string,
    route: string,
    principal: string,
    httpStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    const sanitised = this.sanitise(responseBody);
    const record = await this.repo.findOne({
      where: { key, route, principal },
    });
    if (!record) return;
    record.state = IdempotencyState.SUCCESS;
    record.httpStatus = httpStatus;
    record.responseBody = sanitised;
    record.note = null;
    record.expiresAt = new Date(Date.now() + DEFAULT_RETENTION_MS);
    await this.repo.save(record);
  }

  /**
   * Mark a previously claimed key as failed.
   * If the HTTP status is in the *retryable* set the record transitions to
   * RETRYABLE so the same key can be used again; otherwise it becomes FAILED.
   */
  async fail(
    key: string,
    route: string,
    principal: string,
    httpStatus: number,
    reason: string,
  ): Promise<void> {
    const state = RETRYABLE_HTTP_STATUSES.has(httpStatus)
      ? IdempotencyState.RETRYABLE
      : IdempotencyState.FAILED;

    this.emit(
      state === IdempotencyState.RETRYABLE
        ? IDEMPOTENCY_EVENTS.RETRYABLE
        : IDEMPOTENCY_EVENTS.FAILED,
      { key, route, principal },
    );

    const record = await this.repo.findOne({
      where: { key, route, principal },
    });
    if (!record) return;
    record.state = state;
    record.httpStatus = httpStatus;
    record.note = reason.slice(0, 1024);
    record.expiresAt = new Date(Date.now() + DEFAULT_RETENTION_MS);
    await this.repo.save(record);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Scheduled cleanup: remove expired records that are no longer IN_PROGRESS.
   * Runs every hour.  Does not touch in-progress records to avoid races.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpired(): Promise<void> {
    const deleted = await this.repo
      .createQueryBuilder()
      .delete()
      .from(IdempotencyRecord)
      .where('expiresAt < :now', { now: new Date() })
      .andWhere('state != :state', { state: IdempotencyState.IN_PROGRESS })
      .execute();

    if (deleted.affected && deleted.affected > 0) {
      this.logger.log(
        `Idempotency cleanup: removed ${deleted.affected} expired records.`,
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private emit(event: string, payload: IdempotencyMetricsEvent): void {
    this.eventEmitter.emit(event, payload);
  }

  /**
   * Deep-clone an object while stripping sensitive keys and limiting depth.
   * Returns `{}` for non-object values.
   */
  private sanitise(value: unknown, depth = 0): Record<string, unknown> {
    if (!value || typeof value !== 'object' || depth > 4) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = '[REDACTED]';
      } else if (typeof v === 'object' && v !== null) {
        out[k] = this.sanitise(v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** JSON.stringify sorts keys for canonical representation. */
  private sortedKeys(obj: Record<string, unknown>): Record<string, unknown> {
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(
      Object.entries(obj)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) =>
          typeof v === 'object' && v !== null
            ? [k, this.sortedKeys(v as Record<string, unknown>)]
            : [k, v],
        ),
    );
  }
}

/**
 * Convert any caught error to a stable (httpStatus, message) pair.
 */
export function extractErrorInfo(err: unknown): {
  httpStatus: number;
  message: string;
} {
  if (err instanceof HttpException) {
    return {
      httpStatus: err.getStatus(),
      message: err.message,
    };
  }
  if (err instanceof ConflictException) {
    return { httpStatus: 409, message: err.message };
  }
  const status = (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : 'Unknown error';
  return { httpStatus: status, message };
}
