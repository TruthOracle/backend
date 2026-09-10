/**
 * Request bodies for docs/API.md "Me". `POST /me/identities/:id/reattach` takes "the same body
 * as the matching login route" — the provider is decided by the identity row, so one DTO
 * carries the union of the three proof shapes (every field optional; the controller requires
 * the ones its provider needs). `GET /me/audit` reuses PageQueryDto.
 */
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";

import { WALLET_KIND_ALLOWLIST, type WalletKind } from "../types";
import { PARTY_ID_RE } from "../util/canton-crypto";
import { numberToString } from "./common.dto";

export class UpdateMeDto {
  /** `null` clears the field. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^https:\/\/\S+$/, { message: "avatarUrl must be an https URL" })
  avatarUrl?: string | null;
}

export class ReattachIdentityDto {
  // ── google ───────────────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  credential?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  nonce?: string;

  // ── telegram (widget) ────────────────────────────────────────────────────────
  @ValidateIf((o: ReattachIdentityDto) => o.id !== undefined)
  @Transform(numberToString)
  @IsString()
  @Matches(/^\d{1,20}$/)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  first_name?: string;

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

  @ValidateIf((o: ReattachIdentityDto) => o.auth_date !== undefined)
  @Transform(numberToString)
  @IsString()
  @Matches(/^\d{1,12}$/)
  auth_date?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/)
  hash?: string;

  // ── telegram (mini app) ──────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(8192)
  initData?: string;

  // ── canton wallet (a `link-wallet` challenge issued to this session; bounds as WalletProofDto) ─
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @IsOptional()
  @IsString()
  @Matches(PARTY_ID_RE)
  partyId?: string;

  @IsOptional()
  @IsString()
  @MinLength(40)
  @MaxLength(128)
  publicKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(64)
  @MaxLength(256)
  signature?: string;

  @IsOptional()
  @IsIn(WALLET_KIND_ALLOWLIST)
  kind?: WalletKind;
}
