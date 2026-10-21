import { SetMetadata } from "@nestjs/common";

import type { AdminRole } from "../types";

export const IS_PUBLIC_KEY = "truthoracle:isPublic";
export const ALLOW_ADMIN_SESSION_KEY = "truthoracle:allowAdminSession";

/** Route passes SessionGuard unauthenticated (req.user is still populated when a session is present). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Route (or controller) also accepts a `kind = admin` session (ARCHITECTURE §6.8). Without it
 * SessionGuard refuses admin sessions with `403 forbidden`: an operator's session is a credential
 * for `/admin` and its own housekeeping, never for account routes.
 */
export const AllowAdminSession = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_ADMIN_SESSION_KEY, true);

export const ADMIN_ROLES_KEY = "truthoracle:adminRoles";

/**
 * The operator must hold every listed role (SPEC §6.5); AdminGuard answers `403 role_required`
 * (`details.role`) otherwise. Four-eyes actions check their own request / approve roles.
 */
export const RequireRoles = (...roles: AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
