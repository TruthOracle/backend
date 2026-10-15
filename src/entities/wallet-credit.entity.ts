import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

import { moneyTransformer } from "../util/money";
import { WalletEntity } from "./wallet.entity";

/**
 * In-app credits the backend attributed to one linked wallet in one instrument (docs/TOKENS.md
 * §4.3 `to_wallet_credits`, formerly `to_wallets.credited_cc`). The deposit reconciliation keeps
 * `Σ credited (wallet, instrument) == UserWallet(owner, instrument).deposited` exactly (ARCHITECTURE
 * §8.3); a party that deposits two instruments has two rows. Rows are created on the first
 * confirmed credit and never deleted (a revoked wallet keeps its attribution).
 */
@Entity({ name: "to_wallet_credits" })
export class WalletCreditEntity {
  @PrimaryColumn({ name: "wallet_id", type: "uuid" })
  walletId!: string;

  @ManyToOne(() => WalletEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "wallet_id" })
  wallet?: WalletEntity;

  @PrimaryColumn({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @PrimaryColumn({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  credited!: bigint;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
