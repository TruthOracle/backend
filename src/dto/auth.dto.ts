/**
 * Request bodies for docs/API.md "Auth". The global ValidationPipe runs with `whitelist` +
 * `forbidNonWhitelisted`, so every accepted field is declared here; anything else is a
 * `400 validation_failed`. OIDC start/callback take individual `@Query()` params in the
 * controller (Telegram may append parameters we do not control on the callback).
 */
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

import { type ChallengePurpose, WALLET_KIND_ALLOWLIST, type WalletKind } from "../types";
import { PARTY_ID_RE } from "../util/canton-crypto";

export type LoginClient = "web" | "native";
export const LOGIN_CLIENTS: readonly LoginClient[] = ["web", "native"];
export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["sign-in", "link-wallet", "admin-sign-in"];

/** Telegram's widget posts `id` / `auth_date` as JSON numbers; the verifier wants strings. */
const numberToString = ({ value }: { value: unknown }): unknown =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : value;

class ClientDto {
  /** `native` returns the session token in the body instead of a cookie (API.md "Auth"). */
  @IsOptional()
  @IsIn(LOGIN_CLIENTS)
  client?: LoginClient;
}

export class GoogleLoginDto extends ClientDto {
  /** The GIS `credential` (an ID token). */
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  credential!: string;

  /** Issued by `POST /auth/google/nonce`; mandatory when GOOGLE_NONCE_REQUIRED. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  nonce?: string;
}

export class TelegramWidgetDto extends ClientDto {
  @Transform(numberToString)
  @IsString()
  @Matches(/^\d{1,20}$/)
  id!: string;

  @IsString()
  @MaxLength(256)
  first_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photo_url?: string;

  @Transform(numberToString)
  @IsString()
  @Matches(/^\d{1,12}$/)
  auth_date!: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/)
  hash!: string;
}

export class TelegramMiniAppDto extends ClientDto {
  @IsString()
  @MinLength(16)
  @MaxLength(8192)
  initData!: string;
}

export class WalletChallengeDto {
  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;

  @IsIn(CHALLENGE_PURPOSES)
  purpose!: ChallengePurpose;
}

export class WalletLoginDto extends ClientDto {
  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}$/, { message: "challengeId must be the id returned by /auth/wallet/challenge" })
  challengeId!: string;

  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;

  /** 32-byte Ed25519 key, hex / base64 / base64url (short prefixes tolerated by util/canton-crypto). */
  @IsString()
  @MinLength(40)
  @MaxLength(128)
  publicKey!: string;

  /** 64-byte Ed25519 signature over the raw UTF-8 challenge message. */
  @IsString()
  @MinLength(64)
  @MaxLength(256)
  signature!: string;

  /** Informational allowlist (`cantor8` in v1). */
  @IsIn(WALLET_KIND_ALLOWLIST)
  kind!: WalletKind;
}
