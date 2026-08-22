import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  BadRequestException,
  ConflictException,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import {
  IdempotencyService,
  MAX_KEY_LENGTH,
  extractErrorInfo,
} from './idempotency.service';
import { USE_IDEMPOTENCY_KEY } from './use-idempotency.decorator';

/**
 * IdempotencyInterceptor
 *
 * Applied globally in AppModule (via APP_INTERCEPTOR). Only activates on
 * routes decorated with @UseIdempotency().
 *
 * Protocol:
 *   1. Read the `Idempotency-Key` header (required when decorator is present).
 *   2. Validate key length (1–128 chars).
 *   3. Compute a fingerprint of (principal, route, canonicalBody).
 *   4. Attempt an atomic claim via IdempotencyService.claimOrReplay:
 *      - claimed    → run the handler, then persist SUCCESS/FAILED/RETRYABLE.
 *      - replayed   → return stored response with `Idempotency-Replayed: true`.
 *      - inProgress → 409 with `X-Idempotency-State: IN_PROGRESS`.
 *      - conflict   → 422 (key reused with different payload).
 *   5. Sensitive fields in the stored response body are stripped before
 *      persistence (handled in IdempotencyService.complete).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.get<boolean>(
      USE_IDEMPOTENCY_KEY,
      ctx.getHandler(),
    );

    // Skip routes that are not annotated with @UseIdempotency()
    if (!enabled) return next.handle();

    const req: Request & { user?: { address?: string } } = ctx
      .switchToHttp()
      .getRequest<Request & { user?: { address?: string } }>();

    const res: Response = ctx.switchToHttp().getResponse<Response>();

    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // ── Key validation ────────────────────────────────────────────────────
    if (!key) {
      throw new BadRequestException(
        'Idempotency-Key header is required for this endpoint.',
      );
    }
    if (
      typeof key !== 'string' ||
      key.length < 1 ||
      key.length > MAX_KEY_LENGTH
    ) {
      throw new BadRequestException(
        `Idempotency-Key must be a string of 1–${MAX_KEY_LENGTH} characters.`,
      );
    }

    const principal = req.user?.address ?? 'anonymous';
    // req.route is typed as any by express; safe to access with a cast
    const routePath =
      (req.route as { path?: string } | undefined)?.path ?? req.path;
    const route = `${req.method} ${routePath}`;
    const fp = this.idempotencyService.fingerprint(
      principal,
      route,
      (req.body as Record<string, unknown>) ?? {},
    );

    // Use switchMap to work within the Observable pipeline
    const claimAndHandle = this.idempotencyService
      .claimOrReplay(key, route, principal, fp)
      .then((result) => {
        if (result.status === 'conflict') {
          throw new ConflictException(
            `Idempotency-Key "${key}" was already used with a different request payload on route "${route}". ` +
              'Use a new key or ensure the request body matches the original.',
          );
        }

        if (result.status === 'inProgress') {
          res.setHeader('X-Idempotency-State', 'IN_PROGRESS');
          throw new HttpException(
            {
              statusCode: HttpStatus.CONFLICT,
              message:
                `An identical request with Idempotency-Key "${key}" is currently in progress. ` +
                'Wait for it to complete before retrying.',
              idempotencyState: 'IN_PROGRESS',
            },
            HttpStatus.CONFLICT,
          );
        }

        if (result.status === 'replayed') {
          res.setHeader('Idempotency-Replayed', 'true');
          res.setHeader('X-Idempotency-State', 'SUCCESS');
          res.status(result.httpStatus);
          return { __idempotencyReplay: true, body: result.body };
        }

        // status === 'claimed': execute the real handler
        return { __idempotencyReplay: false, body: null };
      });

    // Convert promise-based pre-work into the Observable pipeline
    return new Observable((subscriber) => {
      claimAndHandle
        .then((preResult) => {
          if (preResult.__idempotencyReplay) {
            subscriber.next(preResult.body);
            subscriber.complete();
            return;
          }

          // Run the actual handler
          next
            .handle()
            .pipe(
              // ── SUCCESS path ───────────────────────────────────────────
              switchMap(async (responseBody: unknown) => {
                const httpStatus = res.statusCode;
                try {
                  await this.idempotencyService.complete(
                    key,
                    route,
                    principal,
                    httpStatus,
                    responseBody,
                  );
                } catch (persistErr) {
                  this.logger.warn(
                    `Failed to persist idempotency success for key="${key}": ${String(persistErr)}`,
                  );
                }
                res.setHeader('X-Idempotency-State', 'SUCCESS');
                return responseBody;
              }),

              // ── FAILURE path ───────────────────────────────────────────
              catchError((err: unknown) => {
                const { httpStatus, message } = extractErrorInfo(err);
                void this.idempotencyService
                  .fail(key, route, principal, httpStatus, message)
                  .catch((persistErr) => {
                    this.logger.warn(
                      `Failed to persist idempotency failure for key="${key}": ${String(persistErr)}`,
                    );
                  });
                return throwError(() => err);
              }),
            )
            .subscribe({
              next: (v) => subscriber.next(v),
              error: (e) => subscriber.error(e),
              complete: () => subscriber.complete(),
            });
        })
        .catch((err) => subscriber.error(err));
    });
  }
}
