import { Controller, Get, HttpCode, Res } from "@nestjs/common";
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../auth/decorators";
import { AppService } from "../services/app.service";
import type { HealthResponse, ReadinessResponse } from "../types";

/** Unprefixed (`main.ts` excludes `health*` from the `api/v1` prefix). */
@ApiTags("health")
@Controller("health")
@Public()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOkResponse({ description: "Process is up." })
  health(): HealthResponse {
    return this.appService.health();
  }

  @Get("ready")
  @HttpCode(200)
  @ApiOkResponse({ description: "Postgres, Redis and NATS are all reachable." })
  @ApiServiceUnavailableResponse({ description: "At least one dependency is unreachable." })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const readiness = await this.appService.readiness();
    if (readiness.status !== "ok") res.status(503);
    return readiness;
  }
}
