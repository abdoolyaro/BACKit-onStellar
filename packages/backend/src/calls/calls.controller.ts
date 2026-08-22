import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CallsService } from './calls.service';
import { ReportCallDto } from './dto/report-call.dto';
import { QueryCallsDto } from './dto/query-calls.dto';
import { PrepareCallDto } from './dto/prepare-call.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { BookmarksService } from '../bookmarks/bookmarks.service';
import { UseIdempotency } from '../idempotency/use-idempotency.decorator';

interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/** Request after JwtAuthGuard — the authenticated user is always present. */
interface AuthedRequest {
  user: { address: string };
}

/** Request after OptionalJwtAuthGuard — user present only when authenticated. */
interface OptionalAuthedRequest {
  user?: { address: string };
}

@ApiTags('calls')
@Controller('calls')
export class CallsController {
  constructor(
    private readonly callsService: CallsService,
    private readonly bookmarksService: BookmarksService,
  ) {}

  @Get('feed')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get paginated feed of visible calls' })
  @ApiResponse({ status: 200, description: 'Feed returned successfully' })
  async getFeed(
    @Query() query: QueryCallsDto,
    @Request() req: OptionalAuthedRequest,
  ) {
    const result = await this.callsService.getFeed(query);
    return this.withBookmarkInfo(result, req.user?.address);
  }

  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Search calls by title or description' })
  @ApiResponse({ status: 200, description: 'Search results returned' })
  async search(
    @Query() query: QueryCallsDto,
    @Request() req: OptionalAuthedRequest,
  ) {
    const result = await this.callsService.search(query);
    return this.withBookmarkInfo(result, req.user?.address);
  }

  /**
   * Enriches a paginated call list with `bookmarkCount` (always) and, when the
   * request is authenticated, `isBookmarked` for the viewer. Both are computed
   * in two batched queries so the frontend needs no extra round-trips.
   */
  private async withBookmarkInfo<T extends { id: string }>(
    result: Paginated<T>,
    viewerAddress?: string,
  ): Promise<Paginated<T & { bookmarkCount: number; isBookmarked?: boolean }>> {
    const calls = result?.data ?? [];
    if (calls.length === 0) {
      return result as Paginated<
        T & { bookmarkCount: number; isBookmarked?: boolean }
      >;
    }

    const ids = calls.map((call) => call.id);
    const counts = await this.bookmarksService.getBookmarkCounts(ids);
    const bookmarkedIds = viewerAddress
      ? await this.bookmarksService.getBookmarkedCallIds(viewerAddress, ids)
      : null;

    const data = calls.map((call) => ({
      ...call,
      bookmarkCount: counts[call.id] ?? 0,
      ...(bookmarkedIds ? { isBookmarked: bookmarkedIds.has(call.id) } : {}),
    }));

    return { ...result, data };
  }

  @Post('prepare')
  @UseIdempotency()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pin call content to IPFS and return CID for on-chain creation',
  })
  @ApiResponse({
    status: 201,
    description: 'Content pinned',
    schema: {
      example: {
        cid: 'bafybeig...',
        ipfsUrl: 'https://ipfs.io/ipfs/bafybeig...',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  prepareCall(@Body() dto: PrepareCallDto) {
    return this.callsService.prepareCall(dto);
  }

  @Post(':id/report')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Report a call for moderation' })
  @ApiParam({ name: 'id', description: 'Call UUID' })
  @ApiResponse({ status: 200, description: 'Report submitted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Already reported' })
  reportCall(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportCallDto,
    @Request() req: AuthedRequest,
  ) {
    return this.callsService.reportCall(id, req.user.address, dto);
  }
}
