import type { Config } from "jest";

// Unit specs live next to the code (`src/**/*.spec.ts`); e2e specs use test/jest-e2e.json.
const config: Config = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "\\.spec\\.ts$",
  moduleFileExtensions: ["js", "json", "ts"],
  transform: {
    "^.+\\.ts$": "ts-jest",
    // ESM-only packages (NestJS 12, jose) -> CommonJS for jest on Node < 24.9; see the transformer.
    "/node_modules/(@nestjs|jose)/.+\\.js$": "<rootDir>/test/esm-to-cjs.transformer.cjs",
  },
  transformIgnorePatterns: ["/node_modules/(?!(@nestjs|jose)/)", "\\.pnp\\.[^\\/]+$"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/main.ts",
    "!src/data-source.ts",
    "!src/migrations/**",
  ],
  coverageDirectory: "coverage",
  clearMocks: true,
};

export default config;
