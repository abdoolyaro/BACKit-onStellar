/* eslint-disable @typescript-eslint/no-unsafe-argument */
/**
 * IdempotencyService tests.
 *
 * Uses fully mocked repository and DataSource so there is no database
 * dependency. Each test section exercises the key acceptance-criteria
 * scenarios documented in issue #572:
 *
 *   1. Sequential replay   – duplicate with same payload returns stored response.
 *   2. Concurrent duplicates – only the first claim wins; second gets inProgress.
 *   3. Payload mismatch    – same key, different body → conflict.
 *   4. Expiry              – cleanupExpired() only removes terminal records.
 *   5. Retryable failure   – retryable HTTP statuses allow re-claim.
 *   6. Terminal failure    – non-retryable statuses lock the key.
 *   7. Fingerprint stability – key ordering does not affect the digest.
 *   8. Sanitise response   – sensitive keys are stripped before storage.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IdempotencyService } from './idempotency.service';
import {
  IdempotencyRecord,
  IdempotencyState,
} from './idempotency-record.entity';

// ── Constants ────────────────────────────────────────────────────────────────

const KEY = 'test-key-1';
const ROUTE = 'POST /relay/tx';
const PRINCIPAL = 'GTEST1234567890';
const BODY = { amount: '100' };

// ── Helper: build a minimal IdempotencyRecord ─────────────────────────────

function makeRecord(
  overrides: Partial<IdempotencyRecord> = {},
): IdempotencyRecord {
  return Object.assign(new IdempotencyRecord(), {
    key: KEY,
    route: ROUTE,
    principal: PRINCIPAL,
    fingerprint: 'fp-aaa',
    state: IdempotencyState.IN_PROGRESS,
    httpStatus: null,
    responseBody: null,
    note: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

// ── Helper: build mocked repo ─────────────────────────────────────────────

function mockRepo(existingRecord: IdempotencyRecord | null = null) {
  const saved: IdempotencyRecord[] = existingRecord ? [existingRecord] : [];

  return {
    findOne: jest.fn(() => Promise.resolve(saved[0] ?? null)),
    save: jest.fn((r: IdempotencyRecord) => {
      if (saved[0]) {
        Object.assign(saved[0], r);
      } else {
        saved.push(r);
        saved[0] = r;
      }
      return Promise.resolve(saved[0]);
    }),
    createQueryBuilder: jest.fn(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    })),
    _saved: saved,
  };
}

// ── Helper: build mocked DataSource (transaction) ────────────────────────

function mockDataSource(existingRecord: IdempotencyRecord | null = null) {
  const saved: IdempotencyRecord[] = existingRecord ? [existingRecord] : [];

  return {
    transaction: jest.fn(
      (_isolation: string, fn: (em: Record<string, unknown>) => unknown) => {
        const em = {
          findOne: jest.fn(() => Promise.resolve(saved[0] ?? null)),
          create: jest.fn(
            (_entity: unknown, data: Partial<IdempotencyRecord>) => {
              return Object.assign(new IdempotencyRecord(), data);
            },
          ),
          save: jest.fn((_entity: unknown, record: IdempotencyRecord) => {
            if (saved[0]) {
              Object.assign(saved[0], record);
            } else {
              saved.push(record);
              saved[0] = record;
            }
            return Promise.resolve(saved[0]);
          }),
        };
        return fn(em);
      },
    ),
    _saved: saved,
  };
}

// ── Build service helper ──────────────────────────────────────────────────

function buildService(
  repo: ReturnType<typeof mockRepo>,
  ds: ReturnType<typeof mockDataSource>,
) {
  const emitter = new EventEmitter2();

  return new IdempotencyService(repo as any, ds as any, emitter);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('IdempotencyService', () => {
  // ── 1. Sequential replay ─────────────────────────────────────────────────

  describe('sequential replay', () => {
    it('first claim returns "claimed"', async () => {
      const repo = mockRepo(null);
      const ds = mockDataSource(null);
      const service = buildService(repo, ds);

      const fp = service.fingerprint(PRINCIPAL, ROUTE, BODY);
      const result = await service.claimOrReplay(KEY, ROUTE, PRINCIPAL, fp);
      expect(result.status).toBe('claimed');
    });

    it('completing a key then replaying returns the stored response', async () => {
      const fp = 'fixed-fp-aaa';
      const successRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.SUCCESS,
        httpStatus: 201,
        responseBody: { txHash: 'abc123' },
      });
      const repo = mockRepo(successRecord);
      const ds = mockDataSource(successRecord);
      const service = buildService(repo, ds);

      const replay = await service.claimOrReplay(KEY, ROUTE, PRINCIPAL, fp);
      expect(replay.status).toBe('replayed');
      if (replay.status === 'replayed') {
        expect(replay.httpStatus).toBe(201);
        expect(replay.body).toMatchObject({ txHash: 'abc123' });
      }
    });

    it('replayed response preserves non-sensitive fields', async () => {
      const fp = 'fixed-fp-bbb';
      const successRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.SUCCESS,
        httpStatus: 200,
        responseBody: { txHash: 'abc', signature: '[REDACTED]' },
      });
      const repo = mockRepo(successRecord);
      const ds = mockDataSource(successRecord);
      const service = buildService(repo, ds);

      const replay = await service.claimOrReplay(KEY, ROUTE, PRINCIPAL, fp);
      if (replay.status === 'replayed') {
        expect(replay.body).toHaveProperty('txHash', 'abc');
      }
    });
  });

  // ── 2. Concurrent duplicates ─────────────────────────────────────────────

  describe('concurrent duplicates', () => {
    it('returns "inProgress" when record is IN_PROGRESS and fingerprint matches', async () => {
      const fp = 'fixed-fp-ccc';
      const inProgressRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.IN_PROGRESS,
      });
      const repo = mockRepo(inProgressRecord);
      const ds = mockDataSource(inProgressRecord);
      const service = buildService(repo, ds);

      const result = await service.claimOrReplay(KEY, ROUTE, PRINCIPAL, fp);
      expect(result.status).toBe('inProgress');
    });

    it('returns "replayed" after the first request completes', async () => {
      const fp = 'fixed-fp-ddd';
      const successRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.SUCCESS,
        httpStatus: 200,
        responseBody: { ok: true },
      });
      const repo = mockRepo(successRecord);
      const ds = mockDataSource(successRecord);
      const service = buildService(repo, ds);

      const result = await service.claimOrReplay(KEY, ROUTE, PRINCIPAL, fp);
      expect(result.status).toBe('replayed');
    });
  });

  // ── 3. Payload mismatch ──────────────────────────────────────────────────

  describe('payload mismatch', () => {
    it('returns "conflict" when same key is reused with a different fingerprint', async () => {
      const originalFp = 'fp-original';
      const existingRecord = makeRecord({
        fingerprint: originalFp,
        state: IdempotencyState.SUCCESS,
      });
      const repo = mockRepo(existingRecord);
      const ds = mockDataSource(existingRecord);
      const service = buildService(repo, ds);

      const differentFp = 'fp-different';
      const result = await service.claimOrReplay(
        KEY,
        ROUTE,
        PRINCIPAL,
        differentFp,
      );
      expect(result.status).toBe('conflict');
    });
  });

  // ── 4. Expiry / cleanup ──────────────────────────────────────────────────

  describe('expiry', () => {
    it('cleanupExpired calls the query builder with correct conditions', async () => {
      const repo = mockRepo(null);
      const ds = mockDataSource(null);
      const service = buildService(repo, ds);

      await service.cleanupExpired();

      expect(repo.createQueryBuilder).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const qb = repo.createQueryBuilder.mock.results[0].value;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(qb.delete).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(qb.where).toHaveBeenCalledWith(
        'expiresAt < :now',
        expect.any(Object),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(qb.andWhere).toHaveBeenCalledWith('state != :state', {
        state: IdempotencyState.IN_PROGRESS,
      });
    });
  });

  // ── 5. Retryable failure ─────────────────────────────────────────────────

  describe('retryable failure', () => {
    it.each([408, 429, 502, 503, 504])(
      'HTTP %d marks the key RETRYABLE and allows re-claim',
      async (status) => {
        const fp = 'fp-retryable';
        const inProgressRecord = makeRecord({
          fingerprint: fp,
          state: IdempotencyState.IN_PROGRESS,
        });
        const repo = mockRepo(inProgressRecord);
        const ds = mockDataSource(inProgressRecord);
        const service = buildService(repo, ds);

        await service.fail(KEY, ROUTE, PRINCIPAL, status, 'transient error');

        expect(repo.save).toHaveBeenCalled();
        const savedRecord = repo._saved[0];
        expect(savedRecord.state).toBe(IdempotencyState.RETRYABLE);

        // Now the record is RETRYABLE; claimOrReplay should allow re-claim
        // We need a new ds that returns the RETRYABLE record
        const retryRepo = mockRepo(savedRecord);
        const retryDs = mockDataSource(savedRecord);
        const retryService = buildService(retryRepo, retryDs);
        const retry = await retryService.claimOrReplay(
          KEY,
          ROUTE,
          PRINCIPAL,
          fp,
        );
        expect(retry.status).toBe('claimed');
      },
    );
  });

  // ── 6. Terminal failure ──────────────────────────────────────────────────

  describe('terminal failure', () => {
    it.each([400, 401, 403, 404, 409, 422, 500])(
      'HTTP %d marks the key FAILED',
      async (status) => {
        const fp = 'fp-terminal';
        const inProgressRecord = makeRecord({
          fingerprint: fp,
          state: IdempotencyState.IN_PROGRESS,
        });
        const repo = mockRepo(inProgressRecord);
        const ds = mockDataSource(inProgressRecord);
        const service = buildService(repo, ds);

        await service.fail(KEY, ROUTE, PRINCIPAL, status, 'terminal error');

        expect(repo.save).toHaveBeenCalled();
        const savedRecord = repo._saved[0];
        expect(savedRecord.state).toBe(IdempotencyState.FAILED);
      },
    );

    it('replays the FAILED state on second attempt', async () => {
      const fp = 'fp-failed-replay';
      const failedRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.FAILED,
        httpStatus: 400,
        responseBody: null,
      });
      const repo = mockRepo(failedRecord);
      const ds = mockDataSource(failedRecord);
      const service = buildService(repo, ds);

      const result = await service.claimOrReplay(KEY, ROUTE, PRINCIPAL, fp);
      expect(result.status).toBe('replayed');
    });
  });

  // ── 7. Fingerprint stability ─────────────────────────────────────────────

  describe('fingerprint stability', () => {
    let service: IdempotencyService;
    beforeEach(() => {
      const repo = mockRepo(null);
      const ds = mockDataSource(null);
      service = buildService(repo, ds);
    });

    it('same body with different insertion order produces the same fingerprint', () => {
      const fp1 = service.fingerprint(PRINCIPAL, ROUTE, { a: 1, b: 2 });
      const fp2 = service.fingerprint(PRINCIPAL, ROUTE, { b: 2, a: 1 });
      expect(fp1).toBe(fp2);
    });

    it('different principals produce different fingerprints', () => {
      const fp1 = service.fingerprint('PRINCIPAL_A', ROUTE, BODY);
      const fp2 = service.fingerprint('PRINCIPAL_B', ROUTE, BODY);
      expect(fp1).not.toBe(fp2);
    });

    it('different routes produce different fingerprints', () => {
      const fp1 = service.fingerprint(PRINCIPAL, 'POST /relay/tx', BODY);
      const fp2 = service.fingerprint(PRINCIPAL, 'POST /calls/prepare', BODY);
      expect(fp1).not.toBe(fp2);
    });

    it('fingerprint is a 64-char hex string', () => {
      const fp = service.fingerprint(PRINCIPAL, ROUTE, BODY);
      expect(fp).toHaveLength(64);
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it('fingerprint is deterministic across calls', () => {
      expect(service.fingerprint(PRINCIPAL, ROUTE, BODY)).toBe(
        service.fingerprint(PRINCIPAL, ROUTE, BODY),
      );
    });
  });

  // ── 8. Sanitise response ─────────────────────────────────────────────────

  describe('sanitise response storage', () => {
    it('xdr field is redacted before storing', async () => {
      const fp = 'fp-sanitise';
      const inProgressRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.IN_PROGRESS,
      });
      const repo = mockRepo(inProgressRecord);
      const ds = mockDataSource(inProgressRecord);
      const service = buildService(repo, ds);

      await service.complete(KEY, ROUTE, PRINCIPAL, 201, {
        txHash: 'xyz',
        xdr: 'SENSITIVE_XDR_PAYLOAD',
      });

      expect(repo.save).toHaveBeenCalled();
      const savedRecord = repo._saved[0];
      expect(savedRecord.responseBody?.['txHash']).toBe('xyz');
      expect(savedRecord.responseBody?.['xdr']).toBe('[REDACTED]');
    });

    it('signature and token fields are redacted', async () => {
      const fp = 'fp-sensitive';
      const inProgressRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.IN_PROGRESS,
      });
      const repo = mockRepo(inProgressRecord);
      const ds = mockDataSource(inProgressRecord);
      const service = buildService(repo, ds);

      await service.complete(KEY, ROUTE, PRINCIPAL, 200, {
        result: 'ok',
        signature: 'secret-sig',
        token: 'bearer-token',
      });

      const savedRecord = repo._saved[0];
      expect(savedRecord.responseBody?.['result']).toBe('ok');
      expect(savedRecord.responseBody?.['signature']).toBe('[REDACTED]');
      expect(savedRecord.responseBody?.['token']).toBe('[REDACTED]');
    });

    it('non-sensitive fields are preserved', async () => {
      const fp = 'fp-preserve';
      const inProgressRecord = makeRecord({
        fingerprint: fp,
        state: IdempotencyState.IN_PROGRESS,
      });
      const repo = mockRepo(inProgressRecord);
      const ds = mockDataSource(inProgressRecord);
      const service = buildService(repo, ds);

      await service.complete(KEY, ROUTE, PRINCIPAL, 200, {
        txHash: 'abc',
        jobId: '123',
        status: 'submitted',
      });

      const savedRecord = repo._saved[0];
      expect(savedRecord.responseBody?.['txHash']).toBe('abc');
      expect(savedRecord.responseBody?.['jobId']).toBe('123');
      expect(savedRecord.responseBody?.['status']).toBe('submitted');
    });
  });
});
