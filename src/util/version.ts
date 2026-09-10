export const SERVICE_NAME = "truthoracle-backend";
/** npm injects npm_package_version under `npm run …`; plain `node dist/main` falls back to the literal. */
export const SERVICE_VERSION = process.env.npm_package_version ?? "0.1.0";
