/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return */
/**
 * Unit tests for IdempotencyInterceptor.
 *
 * We mock IdempotencyService so these tests have no DB dependency.
 * Covers:
 *   - Routes without @UseIdempotency pass through untouched.
 *   - Missing key → BadRequestException.
 *   - Key too long → BadRequestException.
 *   - Claimed → handler is called, SUCCESS persisted.
 *   - Replayed → stored body returned, Idempotency-Replayed header set.
 *   - InProgress → 409 ConflictException.
 *   - Conflict → 409 ConflictException with payload mismatch message.
 *   - Handler error → fail() called, error re-thrown.
 */
import {
  ExecutionContext,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRequest(opts: {
  key?: string | string[];
  body?: Record<string, unknown>;
  user?: { address: string };
  method?: string;
  path?: string;
  route?: { path: string };
}) {
  return {
    headers: opts.key != null ? { 'idempotency-key': opts.key } : {},
    body: opts.body ?? {},
    user: opts.user,
    method: opts.method ?? 'POST',
    path: opts.path ?? '/relay/tx',
    route: opts.route ?? { path: '/relay/tx' },
  };
}

function mockResponse(statusCode = 201) {
  const headers: Record<string, string> = {};
  return {
    statusCode,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    _headers: headers,
  };
}

function mockExecutionContext(
  req: ReturnType<typeof mockRequest>,
  res: ReturnType<typeof mockResponse>,
) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: () => jest.fn(),
  } as unknown as ExecutionContext;
}

function mockCallHandler(value: unknown = { result: 'ok' }) {
  return {
    handle: () => of(value),
  };
}

function mockFailingCallHandler(err: unknown) {
  return {
    handle: () => throwError(() => err),
  };
}

// ── Service mock ─────────────────────────────────────────────────────────────

function buildMockedService(
  claimResult: Awaited<ReturnType<IdempotencyService['claimOrReplay']>>,
) {
  return {
    fingerprint: jest.fn(
      () => 'test-fp-64-chars-hex-padded-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
    claimOrReplay: jest.fn().mockResolvedValue(claimResult),
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  } as unknown as IdempotencyService;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IdempotencyInterceptor', () => {
  let reflector: Reflector;

  function buildInterceptor(
    claimResult: Awaited<ReturnType<IdempotencyService['claimOrReplay']>>,
  ) {
    reflector = new Reflector();

    jest.spyOn(reflector, 'get').mockReturnValue(true); // simulate @UseIdempotency on handler
    const service = buildMockedService(claimResult);
    return {
      interceptor: new IdempotencyInterceptor(service, reflector),
      service,
    };
  }

  // ── Route without @UseIdempotency passes through ──────────────────────────

  it('passes through when @UseIdempotency is not present', (done) => {
    const localReflector = new Reflector();

    jest.spyOn(localReflector, 'get').mockReturnValue(undefined); // not decorated
    const service = buildMockedService({ status: 'claimed' });
    const interceptor = new IdempotencyInterceptor(service, localReflector);

    const req = mockRequest({ key: 'k1' });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);
    const handler = mockCallHandler({ ok: true });

    interceptor.intercept(ctx, handler).subscribe({
      next: (v) => {
        expect(v).toEqual({ ok: true });
        expect(service.claimOrReplay).not.toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });

  // ── Missing key ───────────────────────────────────────────────────────────

  it('throws BadRequestException when Idempotency-Key header is missing', () => {
    const { interceptor } = buildInterceptor({ status: 'claimed' });
    const req = mockRequest({ key: undefined });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);
    expect(() => interceptor.intercept(ctx, mockCallHandler())).toThrow(
      BadRequestException,
    );
  });

  // ── Key too long ──────────────────────────────────────────────────────────

  it('throws BadRequestException when key exceeds 128 chars', () => {
    const { interceptor } = buildInterceptor({ status: 'claimed' });
    const longKey = 'x'.repeat(129);
    const req = mockRequest({ key: longKey });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);
    expect(() => interceptor.intercept(ctx, mockCallHandler())).toThrow(
      BadRequestException,
    );
  });

  // ── Claimed: handler executes and complete() is called ───────────────────

  it('executes the handler and calls complete() on claimed key', (done) => {
    const { interceptor, service } = buildInterceptor({ status: 'claimed' });
    const req = mockRequest({ key: 'unique-key-1', user: { address: 'GABC' } });
    const res = mockResponse(201);
    const ctx = mockExecutionContext(req, res);
    const expectedResponse = { txHash: 'abc123' };

    interceptor.intercept(ctx, mockCallHandler(expectedResponse)).subscribe({
      next: (v) => {
        expect(v).toEqual(expectedResponse);
        expect(service.complete).toHaveBeenCalledWith(
          'unique-key-1',
          expect.any(String),
          'GABC',
          201,
          expectedResponse,
        );
        done();
      },
      error: done,
    });
  });

  // ── Replayed: stored response returned with header ────────────────────────

  it('returns stored body and sets Idempotency-Replayed header on replay', (done) => {
    const storedBody = { txHash: 'replayed123' };
    const { interceptor } = buildInterceptor({
      status: 'replayed',
      httpStatus: 200,
      body: storedBody,
    });
    const req = mockRequest({ key: 'replay-key' });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);

    interceptor.intercept(ctx, mockCallHandler()).subscribe({
      next: (v) => {
        expect(v).toEqual(storedBody);
        expect(res.setHeader).toHaveBeenCalledWith(
          'Idempotency-Replayed',
          'true',
        );
        done();
      },
      error: done,
    });
  });

  // ── InProgress: 409 ──────────────────────────────────────────────────────

  it('emits 409 HttpException when key is in-progress', (done) => {
    const { interceptor } = buildInterceptor({ status: 'inProgress' });
    const req = mockRequest({ key: 'in-progress-key' });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);

    interceptor.intercept(ctx, mockCallHandler()).subscribe({
      next: () => done.fail('should not emit a value'),
      error: (err: unknown) => {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
        expect(res.setHeader).toHaveBeenCalledWith(
          'X-Idempotency-State',
          'IN_PROGRESS',
        );
        done();
      },
    });
  });

  // ── Conflict: 409 ────────────────────────────────────────────────────────

  it('emits ConflictException on payload mismatch', (done) => {
    const { interceptor } = buildInterceptor({ status: 'conflict' });
    const req = mockRequest({ key: 'conflict-key' });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);

    interceptor.intercept(ctx, mockCallHandler()).subscribe({
      next: () => done.fail('should not emit a value'),
      error: (err: unknown) => {
        expect(err).toBeInstanceOf(ConflictException);
        done();
      },
    });
  });

  // ── Handler error: fail() called ─────────────────────────────────────────

  it('calls fail() and re-throws when handler throws', (done) => {
    const { interceptor, service } = buildInterceptor({ status: 'claimed' });
    const req = mockRequest({ key: 'fail-key', user: { address: 'GXYZ' } });
    const res = mockResponse();
    const ctx = mockExecutionContext(req, res);
    const error = new BadRequestException('Bad XDR');

    interceptor.intercept(ctx, mockFailingCallHandler(error)).subscribe({
      next: () => done.fail('should not emit a value'),
      error: (err: unknown) => {
        expect(err).toBe(error);
        expect(service.fail).toHaveBeenCalledWith(
          'fail-key',
          expect.any(String),
          'GXYZ',
          400,
          'Bad XDR',
        );
        done();
      },
    });
  });
});
