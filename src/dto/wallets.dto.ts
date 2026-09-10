import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { PARTY_ID_RE } from "../util/canton-crypto";
import { WalletProofDto } from "./auth.dto";

/** `POST /wallets/link-challenge { partyId }` (docs/API.md "Wallets"). */
export class LinkChallengeDto {
  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;
}

/** `POST /wallets/link { challengeId, partyId, publicKey, signature, kind, label? }` — the shared wallet proof plus a label. */
export class LinkWalletDto extends WalletProofDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}
