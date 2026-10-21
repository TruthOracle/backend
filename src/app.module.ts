import { type DynamicModule, Module, type Provider, ValidationPipe } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_PIPE } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";

import { NotFoundFallback } from "./app.setup";
import { AdminGuard } from "./auth/admin.guard";
import { CsrfGuard } from "./auth/csrf.guard";
import { SessionGuard } from "./auth/session.guard";
import { Config } from "./config";
import * as controllers from "./controllers";
import { KycMockController } from "./controllers/kyc-mock.controller";
import { RampMockController } from "./controllers/ramp-mock.controller";
import { buildDataSourceOptions, resolveDbSslCa } from "./data-source";
import { postgresEntities } from "./entities";
import * as processors from "./processors";
import * as services from "./services";
import { KycProviderMockService } from "./services/kyc-provider-mock.service";
import { KycProviderSumsubService } from "./services/kyc-provider-sumsub.service";
import { KycService } from "./services/kyc.service";
import { RampProviderMockService } from "./services/ramp-provider-mock.service";
import {
  KYC_LOCK_LOOKUP,
  KYC_PROVIDER,
  RAMP_PROVIDER,
  type KycProvider,
  type RampProvider,
} from "./types";
import { AllExceptionsFilter } from "./util/errors";
import { LedgerOffsetInterceptor } from "./util/ledger-offset.interceptor";

/** Provides the validated Config globally so controllers/services/processors can inject it. */
function getConfigModule(config: Config): DynamicModule {
  return {
    module: class ConfigHostModule {},
    global: true,
    providers: [{ provide: Config, useValue: config }],
    exports: [Config],
  };
}

type ClassLike = abstract new (...args: never[]) => unknown;
const isClass = (v: unknown): v is ClassLike =>
  typeof v === "function" && /^class\s/.test(Function.prototype.toString.call(v));

/** Global request pipeline: guards, validation and the error envelope (main.ts adds HTTP-level middleware). */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
}

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    const providers: Provider[] = [
      ...Object.values(services).filter(isClass),
      ...Object.values(processors).filter(isClass),
      AdminGuard,
      // `x-ledger-offset` on index-backed reads (@UseInterceptors on those controllers).
      LedgerOffsetInterceptor,
      // Appends the JSON 404 catch-all after every route (Express 5 would otherwise serve HTML).
      NotFoundFallback,
      {
        provide: KYC_PROVIDER,
        useFactory: (
          mock: KycProviderMockService,
          sumsub: KycProviderSumsubService,
        ): KycProvider => (config.kycProvider === "mock" ? mock : sumsub),
        inject: [KycProviderMockService, KycProviderSumsubService],
      },
      // The card acquirer (docs/RAMP.md §9): only the mock exists until the bank is chosen.
      {
        provide: RAMP_PROVIDER,
        useFactory: (mock: RampProviderMockService): RampProvider => mock,
        inject: [RampProviderMockService],
      },
      // IdentityService resolves this lazily via ModuleRef (no constructor-time cycle with KycService).
      { provide: KYC_LOCK_LOOKUP, useExisting: KycService },
      // Order matters: SessionGuard resolves req.authKind before CsrfGuard consults it.
      { provide: APP_GUARD, useClass: SessionGuard },
      { provide: APP_GUARD, useClass: CsrfGuard },
      { provide: APP_PIPE, useFactory: buildValidationPipe },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ];

    return {
      module: AppModule,
      imports: [
        getConfigModule(config),
        ScheduleModule.forRoot(),
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            ...buildDataSourceOptions({ ...config, dbSslCa: resolveDbSslCa(config.dbSslCa) }),
            // Migrations run in AppService.onModuleInit under a Postgres advisory lock (several
            // replicas booting together must not all run them), never inside initialize().
            migrationsRun: false,
            retryAttempts: 3,
            retryDelay: 2_000,
          }),
        }),
        TypeOrmModule.forFeature(postgresEntities),
      ],
      // Barrel-based auto-registration: exporting a class from the folder's index.ts makes it live.
      controllers: [
        ...Object.values(controllers).filter(isClass),
        ...(config.kycProvider === "mock" ? [KycMockController] : []),
        ...(config.ramp.provider === "mock" && config.appEnv !== "prod" && !config.isMainnet
          ? [RampMockController]
          : []),
      ],
      providers,
    };
  }
}
