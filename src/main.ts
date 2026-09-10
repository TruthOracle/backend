import "reflect-metadata";
import { setDefaultResultOrder } from "node:dns";
import { join } from "node:path";
import * as Sentry from "@sentry/node";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module";
import { setupHttpApp } from "./app.setup";
import { getConfiguration } from "./config";
import { SERVICE_NAME, SERVICE_VERSION } from "./util/version";

setDefaultResultOrder("ipv4first");

// dotenv-free: Node's own loader (ARCHITECTURE §2); a missing .env is not an error.
try {
  process.loadEnvFile(join(__dirname, "..", ".env"));
} catch {
  // environment variables only
}

const config = getConfiguration();

// Before Nest, so bootstrap failures are reported too.
if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.appEnv,
    release: `${SERVICE_NAME}@${SERVICE_VERSION}`,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger: new ConsoleLogger({ json: config.logJson, prefix: SERVICE_NAME }),
    rawBody: true,
    bodyParser: false,
  });

  setupHttpApp(app, config);

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("TruthOracle backend")
        .setVersion(SERVICE_VERSION)
        .addCookieAuth("to_session")
        .addBearerAuth()
        .build(),
    );
    // Never reachable through the Vercel proxy (it forwards api/v1/** and health only).
    SwaggerModule.setup("api/docs", app, document);
  }

  // Routes SIGTERM/SIGINT into onModuleDestroy so Redis/NATS/Postgres close cleanly.
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger("Bootstrap").log(
    `${SERVICE_NAME} ${SERVICE_VERSION} listening on http://localhost:${config.port} (env: ${config.appEnv}, network: ${config.appNetwork}, kyc: ${config.kycProvider})`,
  );
}

bootstrap().catch(async (err: unknown) => {
  new Logger("Bootstrap").error("Failed to start", err instanceof Error ? err.stack : String(err));
  Sentry.captureException(err, { tags: { stage: "bootstrap" } });
  await Sentry.close(2_000);
  process.exit(1);
});
