// Scheduled / NATS-driven loops. Every export is auto-registered as a provider by AppModule,
// so only export @Injectable() classes from this barrel. Written once by package F.
export { SessionCleanupProcessor } from "./session-cleanup.processor";
export { DepositConfirmProcessor } from "./deposit-confirm.processor";
export { PayoutSettlementProcessor } from "./payout-settlement.processor";
export { KycWebhookProcessor } from "./kyc-webhook.processor";
export { LedgerIndexerProcessor } from "./ledger-indexer.processor";
export { TransferInstructionAcceptorProcessor } from "./transfer-instruction-acceptor.processor";
export { RewardsProcessor } from "./rewards.processor";
export { RampProcessor } from "./ramp.processor";
export { TokenAppSyncProcessor } from "./token-app-sync.processor";
export { RampReconProcessor } from "./ramp-recon.processor";
export { ComplianceScreeningProcessor } from "./compliance-screening.processor";
// bank rail: account proofs and the aging of submitted payouts (SPEC §10; S6)
export { RampBankProcessor } from "./ramp-bank.processor";
// the ramp loops' heartbeat: pages a stale reconciliation from outside its loop (C33)
export { RampHeartbeatProcessor } from "./ramp-heartbeat.processor";
