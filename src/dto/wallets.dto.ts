import { Type } from "class-transformer";
import { IsOptional, IsString, Matches, MaxLength, ValidateNested } from "class-validator";

import { PARTY_ID_RE } from "../util/canton-crypto";
import { WalletProofDto } from "./auth.dto";
import { InstrumentIdDto } from "./instruments.dto";

/** `POST /wallets/link-challenge { partyId }` (docs/API.md "Wallets"). */
export class LinkChallengeDto {
  @IsString()
  @Matches(PARTY_ID_RE, { message: "partyId must be a Canton party id (<hint>::1220<64 hex>)" })
  partyId!: string;
}

/** `POST /in-app-wallet/deposits/reconcile { instrument?: { admin, id } }` — one instrument per call; omitted = the default collateral (docs/TOKENS.md §4.3). */
export class ReconcileDepositsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => InstrumentIdDto)
  instrument?: InstrumentIdDto;
}

/** `POST /wallets/link { challengeId, partyId, publicKey, signature, kind, label? }` — the shared wallet proof plus a label. */
export class LinkWalletDto extends WalletProofDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}
