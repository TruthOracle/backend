/**
 * `npm run tokenapp:check` — prove the token-app wiring from the shell (docs/RAMP.md §7; design
 * token-zkpc.md §6): loads `.env` the way main.ts does, builds the validated Config (every boot
 * refusal applies, the cross-network tripwire included), resolves the token-app client with the
 * SAME code as the service (`resolveKeycloak`) and runs read-only checks: the grant and its
 * claims, `/healthz`, `/status`, the paged mint / burn records, the treasury's holdings scan
 * against our index, the registry, the treasury's MintDelegation / AutoAccept on the ledger and
 * the would-be `token.records.adopt` set. `--roundtrip [--amount 0.01]` (≤ 0.10) burns and mints
 * through the command ledger (rows of source `check`) — on mainnet only with
 * `--ack-mainnet=<last 8 hex of TREASURY_PARTY_ID>` AND `TOKENAPP_CHECK_MAINNET`. `--json` prints
 * the lines as JSON. Exit 0 only without FAIL; 2 when a round trip stopped half way. Prints no
 * token, signature or secret.
 */
import "../util/utc";
import { join } from "node:path";
import { DataSource } from "typeorm";

import { type Config, getConfiguration } from "../config";
import { buildDataSourceOptions } from "../data-source";
import { AuditEventEntity } from "../entities/audit-event.entity";
import { InstrumentEntity } from "../entities/instrument.entity";
import { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import { TokenCommandEntity } from "../entities/token-command.entity";
import { postgresEntities } from "../entities";
import { AuditService } from "../services/audit.service";
import { KeycloakTokenService, resolveKeycloak } from "../services/keycloak-token.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import { TokenAppSyncService } from "../services/token-app-sync.service";
import { type TokenAppParsedRecord, TokenAppService } from "../services/token-app.service";
import { TokenCommandService } from "../services/token-command.service";
import { adoptionSet, netOf } from "../services/token-commands.logic";
import { TokenRegistryService } from "../services/token-registry.service";
import type { InstrumentId } from "../types";
import { formatAmount, parseAmount } from "../util/money";
import { authedJson } from "../util/upstream-http";
import {
  checkCommandId,
  type CheckArgs,
  type CheckLine,
  claimLines,
  decodeJwtClaims,
  formatLine,
  parseCheckArgs,
  roundtripRefusal,
  secretInfo,
} from "./tokenapp-check.lib";

const MINT_DELEGATION_TEMPLATE = "#cbyn-rules-v1:TruthOracle.CBYN.Factory:MintDelegation";
const AUTO_ACCEPT_TEMPLATE = "#cbyn-holding-stable:TruthOracle.CBYN.AutoAccept:AutoAccept";
const POLL_MS = 5_000;
const POLL_TIMEOUT_MS = 2 * 60_000;

class Report {
  readonly lines: CheckLine[] = [];
  constructor(private readonly json: boolean) {}
  add(
    status: CheckLine["status"],
    check: string,
    detail: string,
    data?: Record<string, unknown>,
  ): void {
    const line: CheckLine = data ? { status, check, detail, data } : { status, check, detail };
    this.lines.push(line);
    if (!this.json) console.log(formatLine(line));
  }
  ok(check: string): boolean {
    return this.lines.some((l) => l.check === check && l.status === "OK");
  }
  get failed(): boolean {
    return this.lines.some((l) => l.status === "FAIL");
  }
}

/** A Redis double for the read-only part: no shared bearer cache, nothing written. */
const NO_REDIS = {
  getJson: () => Promise.resolve(null),
  setJson: () => Promise.resolve(),
  del: () => Promise.resolve(),
} as unknown as RedisService;

function rampRef(config: Config): InstrumentId | null {
  if (config.ramp.instrument) return config.ramp.instrument;
  const c = config.collateralInstrument;
  return c.admin && c.id ? { admin: c.admin, id: c.id } : null;
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(__dirname, "..", "..", ".env"));
  } catch {
    // no .env: the environment must carry the configuration (Railway, CI)
  }
  const args = parseCheckArgs(process.argv.slice(2));
  const report = new Report(args.json);
  let config: Config;
  try {
    config = getConfiguration();
  } catch (err) {
    report.add("FAIL", "config", (err as Error).message.replace(/\n\s*/g, "; "));
    return finish(report, args, 1);
  }

  // 1. configuration and where each credential field came from
  const resolution = resolveKeycloak(config, "tokenApp");
  const creds = resolution.creds;
  report.add(
    config.tokenApp.url && creds ? "OK" : "FAIL",
    "config.token_app",
    JSON.stringify({
      network: config.appNetwork,
      tokenAppUrl: config.tokenApp.url || null,
      appName: config.tokenApp.appName,
      keycloakUrl: creds?.url ?? null,
      realm: creds?.realm ?? null,
      clientId: creds?.clientId ?? null,
      clientSecret: secretInfo(creds?.clientSecret),
      sources: resolution.sources,
    }),
  );
  if (!config.tokenApp.url || !creds) return finish(report, args, 1);

  const keycloak = new KeycloakTokenService(config, NO_REDIS);
  const tokenApp = new TokenAppService(config, keycloak);

  // 2. client_credentials grant and the bearer's claims (never the token itself)
  try {
    const token = await keycloak.bearerFor("tokenApp");
    report.add(
      "OK",
      "bearer.grant",
      `client_credentials grant accepted by ${creds.url} (realm ${creds.realm})`,
    );
    for (const line of claimLines(
      decodeJwtClaims(token),
      { keycloakUrl: creds.url, clientId: creds.clientId },
      new Date(),
    ))
      report.add(line.status, line.check, line.detail);
  } catch (err) {
    report.add("FAIL", "bearer.grant", (err as Error).message);
  }

  // 3. /healthz (no bearer)
  const health = await tokenApp.health();
  report.add(
    health.ok ? "OK" : "FAIL",
    "token_app.healthz",
    health.ok ? "200" : `HTTP ${health.httpStatus || "network"}`,
  );

  let ds: DataSource | null;
  try {
    ds = new DataSource({
      ...buildDataSourceOptions(config),
      entities: postgresEntities,
      migrations: [],
    });
    await ds.initialize();
  } catch (err) {
    report.add(
      "WARN",
      "db",
      `not reachable (${(err as Error).message}); index, adoption and round-trip checks skipped`,
    );
    ds = null;
  }
  const ramp = rampRef(config);
  const instrumentId = args.instrumentId ?? ramp?.id ?? null;
  if (!instrumentId) {
    report.add(
      "FAIL",
      "instrument",
      "no instrument: set RAMP_INSTRUMENT / COLLATERAL_INSTRUMENT_* or pass --instrument",
    );
    return finish(report, args, 1, ds);
  }
  const row =
    (ds ? await ds.getRepository(InstrumentEntity).findOneBy({ id: instrumentId }) : null) ??
    (config.collateralInstrument.id === instrumentId ? configInstrument(config) : null);
  if (!row) {
    report.add("FAIL", "instrument", `${instrumentId} is not registered`);
    return finish(report, args, 1, ds);
  }
  report.add(
    "OK",
    "instrument",
    `${row.id} (admin ${row.admin.slice(0, 32)}…, ${row.decimals} decimals)`,
  );

  const records = await readOnlyChecks(report, config, tokenApp, keycloak, row, ds);
  if (ds && records) await adoptionCheck(report, ds, records, row.id);

  let code = report.failed ? 1 : 0;
  if (args.roundtrip)
    code = await roundtrip(report, config, args, tokenApp, row, ds, records !== null);
  return finish(report, args, Math.max(code, report.failed ? 1 : 0), ds);
}

/** The configured collateral as an instrument row, when the database is unreachable. */
function configInstrument(config: Config): InstrumentEntity {
  const c = config.collateralInstrument;
  return Object.assign(new InstrumentEntity(), {
    admin: c.admin,
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    decimals: c.decimals,
    registryUrl: c.registryUrl || null,
    registryAuth: c.registryAuth,
  });
}

/** Steps 4–8; answers the paged records (null when they could not be read). */
async function readOnlyChecks(
  report: Report,
  config: Config,
  tokenApp: TokenAppService,
  keycloak: KeycloakTokenService,
  row: InstrumentEntity,
  ds: DataSource | null,
): Promise<TokenAppParsedRecord[] | null> {
  // 4. /status: the monitor's view of the instrument
  try {
    const m = await tokenApp.monitor(row.id, row.decimals);
    const stale =
      m.monitor.ageSeconds !== null &&
      m.monitor.pollIntervalSeconds !== null &&
      m.monitor.ageSeconds > 3 * m.monitor.pollIntervalSeconds;
    report.add(
      !m.token || m.monitor.monitoringEnabled === false || stale ? "WARN" : "OK",
      "token_app.status",
      m.token
        ? `total_supply ${formatAmount(m.token.totalSupply)}, locked ${m.token.totalLockedSupply === null ? "?" : formatAmount(m.token.totalLockedSupply)}, holders ${m.token.uniqueHolders ?? "?"}, updated ${m.token.updatedAt?.toISOString() ?? "?"}; monitor age ${m.monitor.ageSeconds ?? "?"} s / poll ${m.monitor.pollIntervalSeconds ?? "?"} s${m.monitor.monitoringEnabled === false ? ", monitoring DISABLED" : ""}`
        : `/status lists no ${row.id} (monitoring off, or not a token-app-managed token)`,
    );
  } catch (err) {
    report.add("FAIL", "token_app.status", (err as Error).message);
  }

  // 5. every mint / burn record of the instrument, all pages (200 proves data authorisation)
  let records: TokenAppParsedRecord[] | null = null;
  try {
    const mints = await tokenApp.listRecords("mint", { instrumentId: row.id }, row.decimals);
    const burns = await tokenApp.listRecords("burn", { instrumentId: row.id }, row.decimals);
    records = [...mints, ...burns];
    report.add(
      "OK",
      "token_app.records",
      `${mints.length} mints, ${burns.length} burns, net ${formatAmount(netOf(records))} ${row.id}`,
    );
  } catch (err) {
    const msg = (err as Error).message;
    const why = /\(401\)/.test(msg)
      ? " — 401: the bearer was rejected (issuer / audience / realm)"
      : /\(403\)/.test(msg)
        ? " — 403: authenticated but not allowed (role or instrument scope)"
        : "";
    report.add("FAIL", "token_app.records", `${msg}${why}`);
  }

  // 6. the treasury's holdings: token-app's scan against our ledger index
  const treasury = config.treasuryPartyId;
  if (treasury) {
    try {
      const scan = await tokenApp.holdingsScan(
        { instrumentId: row.id, partyId: treasury },
        row.decimals,
      );
      const scanned = scan.holdings.reduce((s, h) => s + h.units, 0n);
      const ageSec = Math.round((Date.now() - scan.scannedAt.getTime()) / 1000);
      let detail = `scan Σ ${formatAmount(scanned)} (${scan.total} holdings, scanned ${ageSec} s ago)`;
      let status: CheckLine["status"] = "OK";
      if (ds) {
        const [idx] = await ds.query<{ total: string }[]>(
          `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ledger_holdings
            WHERE owner = $1 AND instrument_admin = $2 AND instrument_id = $3 AND archived_offset IS NULL`,
          [treasury, row.admin, row.id],
        );
        const indexed = parseAmount(idx.total);
        detail += `; our index ${formatAmount(indexed)}`;
        if (indexed !== scanned) status = "WARN";
      }
      report.add(status, "treasury.holdings", detail);
    } catch (err) {
      report.add("WARN", "treasury.holdings", (err as Error).message);
    }
  } else report.add("WARN", "treasury.holdings", "TREASURY_PARTY_ID is blank");

  // 7. the registry: admin namespace and decimals
  const registry = new TokenRegistryService(keycloak);
  if (registry.isConfigured(row)) {
    try {
      const info = await registry.info(row);
      const meta = await registry.instrument(row);
      const ns = (p: string): string => p.split("::")[1] ?? "";
      const issues = [
        ns(info.adminId) !== ns(row.admin)
          ? `admin namespace ${ns(info.adminId).slice(0, 12)}… ≠ ours ${ns(row.admin).slice(0, 12)}…`
          : "",
        meta.decimals !== row.decimals
          ? `decimals ${meta.decimals} ≠ configured ${row.decimals}`
          : "",
      ].filter(Boolean);
      report.add(
        issues.length ? "FAIL" : "OK",
        "registry",
        issues.length
          ? issues.join("; ")
          : `adminId ${info.adminId.slice(0, 32)}…, ${meta.decimals} decimals, totalSupply ${meta.totalSupply ?? "null"}`,
      );
    } catch (err) {
      report.add("FAIL", "registry", (err as Error).message);
    }
  } else report.add("WARN", "registry", `no registry configured for ${row.id}`);

  // 8. the treasury's MintDelegation + AutoAccept (cBYN's templates) on the ledger
  await ledgerChecks(report, config, keycloak, row);
  return records;
}

async function ledgerChecks(
  report: Report,
  config: Config,
  keycloak: KeycloakTokenService,
  row: InstrumentEntity,
): Promise<void> {
  const base = config.isMainnet ? config.zkpc.ledgerApiUrl : config.ledgerApiUrl;
  const treasury = config.treasuryPartyId;
  if (row.id !== "cBYN" || !base || !treasury || !keycloak.isConfigured("ledger")) {
    report.add(
      "WARN",
      "ledger.mint_delegation",
      "skipped (not cBYN, or no ledger / treasury configured)",
    );
    return;
  }
  try {
    const token = await keycloak.bearerFor("ledger");
    const end = await authedJson<{ offset?: unknown }>(base, "/v2/state/ledger-end", { token });
    for (const [check, templateId, field] of [
      ["ledger.mint_delegation", MINT_DELEGATION_TEMPLATE, "recipient"],
      ["ledger.auto_accept", AUTO_ACCEPT_TEMPLATE, "receiver"],
    ] as const) {
      const res = await authedJson<unknown>(base, "/v2/state/active-contracts", {
        method: "POST",
        token,
        body: {
          activeAtOffset: String(typeof end.offset === "number" ? end.offset : 0),
          eventFormat: {
            filtersByParty: {
              [treasury]: {
                cumulative: [
                  {
                    identifierFilter: {
                      TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } },
                    },
                  },
                ],
              },
            },
            verbose: false,
          },
        },
      });
      const r = res as { activeContracts?: unknown; contracts?: unknown } | unknown[];
      const items: unknown[] = Array.isArray(r)
        ? r
        : Array.isArray(r.activeContracts)
          ? r.activeContracts
          : Array.isArray(r.contracts)
            ? r.contracts
            : [];
      const mine = items
        .map(
          (i) =>
            (
              i as {
                contractEntry?: {
                  JsActiveContract?: {
                    createdEvent?: {
                      contractId?: string;
                      createArgument?: Record<string, unknown>;
                    };
                  };
                };
              }
            ).contractEntry?.JsActiveContract?.createdEvent,
        )
        .filter((e) => e?.createArgument?.[field] === treasury);
      report.add(
        mine.length ? "OK" : "FAIL",
        check,
        mine.length
          ? `${mine.length} contract(s) for the treasury: ${mine.map((e) => `${String(e?.contractId).slice(0, 12)}…`).join(", ")}`
          : `no ${templateId} with ${field} = the treasury (run POST /admin/instruments/<admin>/cBYN/setup)`,
      );
    }
  } catch (err) {
    report.add("FAIL", "ledger.mint_delegation", (err as Error).message);
  }
}

/** Step 9: what `token.records.adopt` would write — records no row of this database accounts for, before its first own command. */
async function adoptionCheck(
  report: Report,
  ds: DataSource,
  records: TokenAppParsedRecord[],
  instrumentId: string,
): Promise<void> {
  try {
    const commands = await ds.getRepository(TokenCommandEntity).findBy({ instrumentId });
    const own = commands.filter((c) => c.source !== "legacy");
    const before = own.length
      ? new Date(Math.min(...own.map((c) => c.createdAt.getTime())))
      : new Date();
    const set = adoptionSet(
      commands,
      records.map((r) => ({ ...r, recordCreatedAt: r.createdAt })),
      before,
    );
    report.add(
      set.length ? "WARN" : "OK",
      "adoption",
      set.length
        ? `${set.length} record(s) before ${before.toISOString()} without a command row (net ${formatAmount(netOf(set))}): ${set
            .slice(0, 5)
            .map((r) => r.commandId ?? r.updateId ?? "?")
            .join(", ")}${set.length > 5 ? ", …" : ""} — token.records.adopt {before}`
        : "every record before this database's first own command is accounted for",
    );
  } catch (err) {
    report.add("WARN", "adoption", (err as Error).message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `--roundtrip`: burn-then-mint when the treasury's headroom over what it owes covers the amount
 * (supply never exceeds the reserve), else mint-then-burn; each step is a command row of source
 * `check`, audited before its POST, then polled in token-app's records (2 min). A failure after
 * the first step names the recorded id and the compensating step; exit 2.
 */
async function roundtrip(
  report: Report,
  config: Config,
  args: CheckArgs,
  tokenApp: TokenAppService,
  row: InstrumentEntity,
  ds: DataSource | null,
  recordsReadable: boolean,
): Promise<number> {
  const required = ["bearer.grant", "token_app.status", "token_app.records"];
  if (row.id === "cBYN") required.push("ledger.mint_delegation", "ledger.auto_accept");
  const refusal = roundtripRefusal({
    mainnet: config.isMainnet,
    args,
    envAck: process.env.TOKENAPP_CHECK_MAINNET,
    treasury: config.treasuryPartyId,
    decimals: row.decimals,
    failedPrerequisites: [
      ...required.filter((c) => !report.ok(c)),
      ...(ds ? [] : ["db"]),
      ...(recordsReadable ? [] : ["records"]),
    ],
  });
  if (refusal || !ds) {
    report.add("FAIL", "roundtrip", refusal ?? "the database is unreachable");
    return 1;
  }
  if (!(await ds.getRepository(InstrumentEntity).findOneBy({ admin: row.admin, id: row.id }))) {
    report.add(
      "FAIL",
      "roundtrip",
      `${row.id} is not registered in the database (boot the backend once)`,
    );
    return 1;
  }
  const redis = new RedisService(config);
  await redis.onModuleInit();
  try {
    if (await redis.get("lock:ramp-scan")) {
      report.add(
        "FAIL",
        "roundtrip",
        "the ramp scan holds lock:ramp-scan (it may move treasury holdings); try again",
      );
      return 1;
    }
    const lock = await redis.acquireLock("lock:tokenapp-check", 10 * 60_000);
    if (!lock.acquired) {
      report.add("FAIL", "roundtrip", "another tokenapp:check round trip is running");
      return 1;
    }
    try {
      return await runRoundtrip(report, config, args, tokenApp, row, ds, redis);
    } finally {
      await lock.release();
    }
  } finally {
    await redis.onApplicationShutdown();
  }
}

async function runRoundtrip(
  report: Report,
  config: Config,
  args: CheckArgs,
  tokenApp: TokenAppService,
  row: InstrumentEntity,
  ds: DataSource,
  redis: RedisService,
): Promise<number> {
  const treasury = config.treasuryPartyId;
  const instrument: InstrumentId = { admin: row.admin, id: row.id };
  const sentry = new SentryService(config);
  const audit = new AuditService(ds.getRepository(AuditEventEntity));
  const cmdRepo = ds.getRepository(TokenCommandEntity);
  const recRepo = ds.getRepository(TokenAppRecordEntity);
  const sync = new TokenAppSyncService(config, ds, cmdRepo, recRepo, tokenApp, redis, sentry);
  const commands = new TokenCommandService(
    config,
    ds,
    cmdRepo,
    recRepo,
    tokenApp,
    sync,
    redis,
    audit,
    sentry,
  );

  const [h] = await ds.query<{ held: string; owed: string }[]>(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM to_ledger_holdings
              WHERE owner = $1 AND instrument_admin = $2 AND instrument_id = $3 AND archived_offset IS NULL)::text AS held,
            ((SELECT COALESCE(SUM(balance), 0) FROM to_ledger_wallets
               WHERE instrument_admin = $2 AND instrument_id = $3 AND active = true)
           + (SELECT COALESCE(SUM(amount), 0) FROM to_ledger_payouts
               WHERE instrument_admin = $2 AND instrument_id = $3 AND active = true))::text AS owed`,
    [treasury, row.admin, row.id],
  );
  const headroom = parseAmount(h.held) - parseAmount(h.owed);
  const order: ("mint" | "burn")[] = headroom >= args.amount ? ["burn", "mint"] : ["mint", "burn"];
  const plan = `${order.join(" then ")} ${formatAmount(args.amount)} ${row.id} on the treasury (headroom ${formatAmount(headroom)})`;
  if (config.isMainnet) {
    console.error(`MAINNET round trip: ${plan}. Ctrl-C within 10 s to abort.`);
    await sleep(10_000);
  }
  const done: { kind: "mint" | "burn"; id: string }[] = [];
  for (const kind of order) {
    const id = checkCommandId(kind, new Date());
    await ds.transaction((m) =>
      commands.recordIntent(m, {
        commandId: id,
        kind,
        instrument,
        party: treasury,
        amount: args.amount,
        source: "check",
        ref: "tokenapp:check",
      }),
    );
    await audit.record({
      actorType: "system",
      action: kind === "mint" ? "token.mint" : "token.burn",
      subjectType: "instrument",
      subjectId: `${row.admin}:${row.id}`,
      metadata: {
        commandId: id,
        instrument,
        amount: formatAmount(args.amount),
        party: treasury,
        reason: "tokenapp:check",
      },
    });
    const sent = await commands.submit(id);
    const landed =
      sent.status === "submitted" &&
      (await pollRecord(tokenApp, row, kind, id, treasury, args.amount));
    if (!landed) {
      const prior = done[0];
      report.add(
        "FAIL",
        `roundtrip.${kind}`,
        `${id} is ${sent.status}${sent.lastError ? ` (${sent.lastError})` : ""}${landed === false && sent.status === "submitted" ? "; not recorded within 2 min" : ""}` +
          (prior
            ? `; ${prior.kind} ${prior.id} stands — compensate with a ${prior.kind === "mint" ? "burn" : "mint"} of ${formatAmount(args.amount)} ${row.id} on the treasury`
            : ""),
      );
      return prior ? 2 : 1;
    }
    done.push({ kind, id });
    report.add(
      "OK",
      `roundtrip.${kind}`,
      `${id} recorded by token-app (${formatAmount(args.amount)} ${row.id})`,
    );
  }
  // Our rows become `recorded` through the same matching the processor runs.
  const pass = await sync.syncOnce("tokenapp:check");
  report.add(
    pass.complete ? "OK" : "WARN",
    "roundtrip.sync",
    pass.complete ? "command rows recorded" : (pass.error ?? "incomplete"),
  );
  return 0;
}

/** Poll token-app's records until exactly one row carries `id` with the treasury and the amount (2 min). */
async function pollRecord(
  tokenApp: TokenAppService,
  row: InstrumentEntity,
  kind: "mint" | "burn",
  id: string,
  treasury: string,
  amount: bigint,
): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = (await tokenApp.listRecords(kind, { instrumentId: row.id }, row.decimals)).filter(
      (r) => r.commandId === id,
    );
    if (found.length === 1 && found[0].partyId === treasury && found[0].amount === amount)
      return true;
    if (found.length > 1) return false;
    await sleep(POLL_MS);
  }
  return false;
}

async function finish(
  report: Report,
  args: CheckArgs,
  code: number,
  ds?: DataSource | null,
): Promise<number> {
  if (ds?.isInitialized) await ds.destroy().catch(() => undefined);
  if (args.json) console.log(JSON.stringify({ ok: code === 0, lines: report.lines }, null, 2));
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(2);
  });
