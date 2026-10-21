/**
 * Request bodies for docs/API.md "Auth". The global ValidationPipe runs with `whitelist` +
 * `forbidNonWhitelisted`, so every accepted field is declared here; anything else is a
 * `400 validation_failed`. OIDC start/callback take individual `@Query()` params in the
 * controller (Telegram may append parameters we do not control on the callback).
 */
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";

import { WALLET_KIND_ALLOWLIST, type WalletKind } from "../types";
import { PARTY_ID_RE } from "../util/canton-crypto";
import { numberToString } from "./common.dto";

export type LoginClient = "web" | "native";
export const LOGIN_CLIENTS: readonly LoginClient[] = ["web", "native"];

/**
 * The one wallet proof `WalletChallengeService.verify` consumes — `POST /wallets/link`
 * (purpose `link-wallet`) and `POST /auth/admin` (purpose `admin-sign-in`) validate it the same
 * way. Key and signature encodings are decoded by util/canton-crypto (hex / base64 /
 * base64url), so only presence and sane bounds are checked here.
 */
export class WalletProofDto {
  @IsUUID(undefined, { message: "challengeId must be the id returned by the challenge route" })
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
  @IsIn(WALLET_KIND_ALLOWLIST as readonly string[], {
    message: `kind must be one of: ${WALLET_KIND_ALLOWLIST.join(", ")}`,
  })
  kind!: WalletKind;
}

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

/** `POST /auth/admin/challenge { partyId }` — the purpose is always `admin-sign-in` (§7.4). */
export class AdminChallengeDto {
  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;
}

/**
 * `POST /auth/admin` — the wallet proof and nothing else: admin sessions are cookie-borne (the
 * operator UI is a browser), so there is no `client`.
 */
export class AdminLoginDto extends WalletProofDto {}
