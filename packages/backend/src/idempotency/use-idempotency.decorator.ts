import { SetMetadata } from '@nestjs/common';

export const USE_IDEMPOTENCY_KEY = 'idempotency:enabled';

/**
 * @UseIdempotency()
 *
 * Marks a POST controller method as idempotency-protected.
 * The IdempotencyInterceptor reads this metadata and enforces
 * the idempotency contract for the decorated route.
 *
 * @example
 * \@UseIdempotency()
 * \@Post('tx')
 * async relayTx(@Body() dto: RelayTxDto) { ... }
 */
export const UseIdempotency = () => SetMetadata(USE_IDEMPOTENCY_KEY, true);
