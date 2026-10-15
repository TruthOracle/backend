import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { InstrumentKind, RegistryAuth, TreasuryTransferMode } from "../types";

/**
 * A CIP-56 instrument the platform knows (docs/TOKENS.md §4.1 `to_instruments`), keyed by the
 * on-ledger identity `(admin, id)` — the admin (registry) party and the token id — because that
 * pair is what every `UserWallet.instrument` / `PredictionMarket.collateral` carries and the only
 * thing two instruments can never share. Everything else is configuration: how it is displayed,
 * how the backend reaches its registry, how the treasury sends it out. Boot upserts the two
 * env-configured instruments (`COLLATERAL_INSTRUMENT_*`, `REWARDS_INSTRUMENT_*`); the indexer adds
 * any instrument it meets on a ledger-first market as `enabled = false, symbol = id` so the market
 * still renders.
 */
@Entity({ name: "to_instruments" })
@Index("ix_to_instruments_kind", ["kind"])
@Index("uq_to_instruments_default_collateral", ["isDefaultCollateral"], {
  unique: true,
  where: `"is_default_collateral" = true`,
})
export class InstrumentEntity {
  /** The registry party: cBYN's transfer agent, Canton Coin's DSO. */
  @PrimaryColumn({ name: "admin", type: "text" })
  admin!: string;

  /** The token identifier (`cBYN`, `TRO`, `Amulet`). */
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ type: "text" })
  symbol!: string;

  @Column({ type: "text" })
  name!: string;

  /** Display and withdrawal quantisation (0..10); amounts are stored and served at 10 dp regardless. */
  @Column({ type: "integer" })
  decimals!: number;

  @Column({ type: "text" })
  kind!: InstrumentKind;

  /** Disabled instruments still render on existing markets but cannot back new ones, be deposited or be transferred out. */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ name: "is_default_collateral", type: "boolean", default: false })
  isDefaultCollateral!: boolean;

  @Column({ name: "registry_url", type: "text", nullable: true })
  registryUrl!: string | null;

  @Column({ name: "registry_auth", type: "text", default: "keycloak" })
  registryAuth!: RegistryAuth;

  /** null = the process default (`TREASURY_TRANSFER_MODE`). */
  @Column({ name: "transfer_mode", type: "text", nullable: true })
  transferMode!: TreasuryTransferMode | null;

  /** What the Cantor8 wallet SDK's `send({ instrumentId })` and the Enterprise Wallet's `/transfer` call the token; defaults to `id`. */
  @Column({ name: "wallet_instrument_id", type: "text" })
  walletInstrumentId!: string;

  /** Choice names the setup action exercises on the factory (`autoAccept`, `mintDelegation`), per token package (docs/TOKENS.md §4.4). */
  @Column({ name: "setup_choices", type: "jsonb", default: () => "'{}'::jsonb" })
  setupChoices!: Record<string, string>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
