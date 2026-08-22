import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
} from 'typeorm';

/**
 * Creates the `idempotency_records` table used by IdempotencyService.
 *
 * Primary key  : (key, route, principal)  — one record per (key × route × caller).
 * Unique index : same — enforced at DB level for atomic claim via INSERT.
 * GIN index    : expiresAt — fast cleanup scans.
 *
 * Retention    : records expire after DEFAULT_RETENTION_MS (24 h) and are
 *                pruned by the IdempotencyService scheduled cleanup.
 */
export class CreateIdempotencyRecordsTable1760000050000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure the enum type exists (idempotent)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'idempotency_state_enum'
        ) THEN
          CREATE TYPE idempotency_state_enum
            AS ENUM ('IN_PROGRESS', 'SUCCESS', 'FAILED', 'RETRYABLE');
        END IF;
      END
      $$;
    `);

    await queryRunner.createTable(
      new Table({
        name: 'idempotency_records',
        columns: [
          // ── Composite PK ────────────────────────────────────────────────
          {
            name: 'key',
            type: 'varchar',
            length: '128',
            isPrimary: true,
            comment: 'Client-supplied Idempotency-Key header value (≤ 128 chars)',
          },
          {
            name: 'route',
            type: 'varchar',
            length: '128',
            isPrimary: true,
            comment: 'Canonical route: "METHOD /path"',
          },
          {
            name: 'principal',
            type: 'varchar',
            length: '64',
            isPrimary: true,
            comment: 'Authenticated user address or "anonymous"',
          },

          // ── Payload fingerprint ──────────────────────────────────────────
          {
            name: 'fingerprint',
            type: 'varchar',
            length: '64',
            isNullable: false,
            comment: 'SHA-256 hex of (principal + route + canonical body)',
          },

          // ── Lifecycle ────────────────────────────────────────────────────
          {
            name: 'state',
            type: 'idempotency_state_enum',
            default: `'IN_PROGRESS'`,
          },
          {
            name: 'httpStatus',
            type: 'int',
            isNullable: true,
            comment: 'HTTP status of the stored response; NULL while IN_PROGRESS',
          },
          {
            name: 'responseBody',
            type: 'jsonb',
            isNullable: true,
            comment: 'Sanitised response body for replay; NULL while IN_PROGRESS',
          },
          {
            name: 'note',
            type: 'text',
            isNullable: true,
            comment: 'Error message for FAILED / RETRYABLE states',
          },

          // ── Timing ───────────────────────────────────────────────────────
          {
            name: 'expiresAt',
            type: 'timestamp with time zone',
            isNullable: false,
            comment: 'Wall-clock expiry; records past this time are pruned',
          },
          {
            name: 'createdAt',
            type: 'timestamp with time zone',
            default: 'now()',
          },
          {
            name: 'updatedAt',
            type: 'timestamp with time zone',
            default: 'now()',
          },
        ],
      }),
      true, // ifNotExists
    );

    // Index for fast expiry-based cleanup
    await queryRunner.createIndex(
      'idempotency_records',
      new TableIndex({
        name: 'IDX_idempotency_records_expires_at',
        columnNames: ['expiresAt'],
      }),
    );

    // Index for principal-scoped lookups
    await queryRunner.createIndex(
      'idempotency_records',
      new TableIndex({
        name: 'IDX_idempotency_records_principal',
        columnNames: ['principal'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex(
      'idempotency_records',
      'IDX_idempotency_records_principal',
    );
    await queryRunner.dropIndex(
      'idempotency_records',
      'IDX_idempotency_records_expires_at',
    );
    await queryRunner.dropTable('idempotency_records', true);
    await queryRunner.query(`DROP TYPE IF EXISTS idempotency_state_enum;`);
  }
}
