import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/** Key/value settings written by migrations, the boot check and the processors (`app_network`, `kyc_pepper_hash`, `exchange_halt`, `rewards_cursor`). */
@Entity({ name: "to_settings" })
export class SettingEntity {
  @PrimaryColumn({ type: "text" })
  key!: string;

  @Column({ type: "text" })
  value!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

export const SETTING_APP_NETWORK = "app_network";
export const SETTING_KYC_PEPPER_HASH = "kyc_pepper_hash";
/** `<offset>:<wallet entry id>:<market event id>` — how far the RewardsProcessor has read the index (docs/TOKENS.md §4.6). */
export const SETTING_REWARDS_CURSOR = "rewards_cursor";
