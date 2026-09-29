/**
 * Pins the process to UTC. Import it first in every entrypoint (the Nest app, the TypeORM CLI data
 * source, the scripts) so no Date is ever formatted or computed in the host's zone: the ledger
 * speaks epoch seconds, the database stores timestamptz, the API emits ISO strings ending in `Z`,
 * and candle buckets are epoch-aligned, so UTC is the only zone the platform has. Node re-reads
 * TZ when it is assigned, so this takes effect for everything that runs after the import.
 */
process.env.TZ = "UTC";

export const PROCESS_TIME_ZONE = "UTC";
