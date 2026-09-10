import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";

import type { AuthedRequest } from "./request";

export const IS_PUBLIC_KEY = "truthoracle:isPublic";

/** Route passes SessionGuard unauthenticated (req.user is still populated when a session is present). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user ?? null;
});

export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().session ?? null;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().clientIp ?? "unknown";
});

export const RequestHost = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().requestHost ?? "";
});
