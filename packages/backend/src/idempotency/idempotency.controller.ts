import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { IdempotencyMetricsService } from './idempotency-metrics.service';

@ApiTags('Idempotency')
@Controller('idempotency')
export class IdempotencyController {
  constructor(private readonly metrics: IdempotencyMetricsService) {}

  /**
   * GET /idempotency/metrics
   *
   * Returns in-process counters for claimed, replayed, conflicted,
   * in_progress, failed, and retryable idempotent requests.
   *
   * Protected by JWT + admin guard so only operators can read metrics.
   */
  @Get('metrics')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary:
      'Idempotency request counters (claimed, replayed, conflicted, in_progress, failed)',
    description:
      'In-process counters reset on process restart. ' +
      'Integrate with your monitoring stack by scraping this endpoint.',
  })
  @ApiResponse({
    status: 200,
    description: 'Counter snapshot',
    schema: {
      example: {
        claimed: 42,
        replayed: 7,
        conflicted: 1,
        inProgress: 0,
        failed: 3,
        retryable: 2,
      },
    },
  })
  getMetrics() {
    return this.metrics.getSnapshot();
  }
}
