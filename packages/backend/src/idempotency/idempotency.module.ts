import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyRecord } from './idempotency-record.entity';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyMetricsService } from './idempotency-metrics.service';
import { IdempotencyController } from './idempotency.controller';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyRecord])],
  providers: [
    IdempotencyService,
    IdempotencyInterceptor,
    IdempotencyMetricsService,
  ],
  controllers: [IdempotencyController],
  exports: [
    IdempotencyService,
    IdempotencyInterceptor,
    IdempotencyMetricsService,
  ],
})
export class IdempotencyModule {}
