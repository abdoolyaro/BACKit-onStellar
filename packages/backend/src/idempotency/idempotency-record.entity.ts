import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Lifecycle states for an idempotency record.
 *
 * - IN_PROGRESS : the first request has claimed the key and is currently executing.
 * - SUCCESS     : the underlying operation completed successfully; response is stored.
 * - FAILED      : the underlying operation failed with a terminal (non-retryable) error.
 * - RETRYABLE   : the underlying operation failed but the caller may retry with the
 *                 same key (e.g., transient network error, 503 from an upstream).
 */
export enum IdempotencyState {
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  RETRYABLE = 'RETRYABLE',
}

/**
 * Persists the idempotency boundary for a single (principal × route × key) tuple.
 *
 * - `key`              : client-supplied Idempotency-Key header value (1–128 chars).
 * - `fingerprint`      : SHA-256 hex of (principal + route + canonical request body).
 *                        Detects payload mismatches for the same key.
 * - `principal`        : authenticated user address or 'anonymous' for unauthenticated routes.
 * - `route`            : canonical route identifier, e.g. "POST /relay/tx".
 * - `state`            : current lifecycle state.
 * - `httpStatus`       : HTTP status code of the stored response (null while IN_PROGRESS).
 * - `responseBody`     : serialised response body for replay (null while IN_PROGRESS).
 *                        Sensitive fields are stripped before storage.
 * - `expiresAt`        : when the record may be cleaned up (default: 24 h after creation).
 */
@Entity('idempotency_records')
@Index('IDX_idempotency_principal_route_key', ['principal', 'route', 'key'], {
  unique: true,
})
@Index('IDX_idempotency_expires_at', ['expiresAt'])
export class IdempotencyRecord {
  /** Natural PK: the Idempotency-Key header value (≤ 128 chars). */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  key: string;

  /** Route that owns this key: "METHOD /path". */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  route: string;

  /** Authenticated user address, or 'anonymous'. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  principal: string;

  /**
   * SHA-256 hex of `principal + route + canonicalisedBody`.
   * Used to detect key-reuse with a different payload (conflict).
   */
  @Column({ type: 'varchar', length: 64, nullable: false })
  fingerprint: string;

  @Column({
    type: 'enum',
    enum: IdempotencyState,
    default: IdempotencyState.IN_PROGRESS,
  })
  state: IdempotencyState;

  /** HTTP status of the stored response. NULL while IN_PROGRESS. */
  @Column({ type: 'int', nullable: true })
  httpStatus: number | null;

  /**
   * Serialised response body for replay.
   * Sensitive fields are stripped before storage.
   * NULL while IN_PROGRESS.
   */
  @Column({ type: 'jsonb', nullable: true })
  responseBody: Record<string, unknown> | null;

  /** Optional human-readable note (e.g. error message for FAILED/RETRYABLE). */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** Wall-clock expiry. Records past this time are eligible for cleanup. */
  @Column({ type: 'timestamp with time zone' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
