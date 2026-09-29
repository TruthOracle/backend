import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Response } from "express";
import { from, type Observable, switchMap } from "rxjs";

import { IndexerService } from "../services/indexer.service";

/** Every response of an index-backed route carries this: the last ledger offset the answer reflects. */
export const LEDGER_OFFSET_HEADER = "x-ledger-offset";

/**
 * Stamps `x-ledger-offset` on index-backed reads (docs/API.md "Ledger"), so a client that just
 * submitted a command can tell whether the answer already includes it — and, if not, wait on
 * `GET /ledger/wait?offset=` instead of polling blindly. One primary-key read per request.
 */
@Injectable()
export class LedgerOffsetInterceptor implements NestInterceptor {
  constructor(private readonly indexer: IndexerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    return from(this.indexer.currentOffset().catch(() => null)).pipe(
      switchMap((offset) => {
        if (offset !== null && !res.headersSent)
          res.setHeader(LEDGER_OFFSET_HEADER, String(offset));
        return next.handle();
      }),
    );
  }
}
