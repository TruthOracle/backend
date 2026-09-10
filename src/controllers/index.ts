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
