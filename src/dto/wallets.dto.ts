import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { WALLET_KIND_ALLOWLIST, type WalletKind } from "../types";
import { PARTY_ID_RE } from "../util/canton-crypto";

/** `POST /wallets/link-challenge { partyId }` (docs/API.md "Wallets"). */
export class LinkChallengeDto {
  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;
}

/**
 * `POST /wallets/link { challengeId, partyId, publicKey, signature, kind, label? }`. Key and
 * signature encodings are decoded by util/canton-crypto (hex / base64 / base64url), so only
 * their presence and a sane upper bound are validated here.
 */
export class LinkWalletDto {
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i, { message: "challengeId must be a UUID" })
  challengeId!: string;

  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  publicKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  signature!: string;

  @IsIn(WALLET_KIND_ALLOWLIST as readonly string[], { message: "kind must be one of: cantor8" })
  kind!: WalletKind;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}
