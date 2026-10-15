// Every export here is auto-registered as a controller by AppModule. Written once by package F.
// KycMockController is deliberately absent: AppModule adds it only when KYC_PROVIDER=mock.
export { AppController } from "./app.controller";
export { AuthController } from "./auth.controller";
export { MeController } from "./me.controller";
export { WalletsController } from "./wallets.controller";
export { InAppWalletController } from "./in-app-wallet.controller";
export { PayoutsController } from "./payouts.controller";
export { KycController } from "./kyc.controller";
export { WebhooksController } from "./webhooks.controller";
export { AdminController } from "./admin.controller";
// ledger index reads (docs/INDEXER.md §7)
export { MarketsController } from "./markets.controller";
export { LedgerController } from "./ledger.controller";
export { PortfolioController } from "./portfolio.controller";
export { LedgerWalletController } from "./ledger-wallet.controller";
export { AdminLedgerController } from "./admin-ledger.controller";
// market catalog, quotes / orders, exchange status (docs/MARKETS.md)
export { CatalogController } from "./catalog.controller";
export { OrdersController } from "./orders.controller";
export { ExchangeController } from "./exchange.controller";
export { AdminCatalogController } from "./admin-catalog.controller";
// instruments (docs/TOKENS.md §4.1)
export { InstrumentsController } from "./instruments.controller";
export { AdminInstrumentsController } from "./admin-instruments.controller";
// rewards and the operator's token operations (docs/TOKENS.md §4.6–§4.7)
export { RewardsController } from "./rewards.controller";
export { AdminRewardsController } from "./admin-rewards.controller";
export { AdminTokensController } from "./admin-tokens.controller";
