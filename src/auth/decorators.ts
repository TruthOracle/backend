import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "truthoracle:isPublic";

/** Route passes SessionGuard unauthenticated (req.user is still populated when a session is present). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
