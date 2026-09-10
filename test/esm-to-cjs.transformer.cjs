/**
 * Jest transformer that turns ESM-only dependencies into CommonJS for the test runtime.
 *
 * Why: NestJS 12 (every @nestjs/* package) and jose 6 ship ESM only. The built app is fine —
 * Node >= 22.12 `require(esm)` loads them from our CommonJS output — but jest-runtime has its own
 * module loader and only does native `require(esm)` on Node >= 24.9 *with* --experimental-vm-modules
 * (it needs `vm.SourceTextModule#hasAsyncGraph`). On Node 22 the documented alternative is to let a
 * transform convert those packages (jest's `transformIgnorePatterns` + this file).
 *
 * How: rewrite `import.meta` (which has no CommonJS form) so it resolves to the CJS wrapper's
 * `require`/`__filename`, then run TypeScript's single-file `transpileModule` with module=CommonJS.
 * When jest reports `supportsStaticESM` (Node >= 24.9 native path) the source is returned untouched.
 */
"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const ts = require("typescript");

const SELF_HASH = createHash("sha1").update(readFileSync(__filename)).digest("hex");

const REWRITES = [
  // `const require = createRequire(import.meta.url);` would redeclare the CJS wrapper's `require`.
  [/\b(?:const|let|var)\s+require\s*=\s*createRequire\(\s*import\.meta\.url\s*\)\s*;?/g, ""],
  // Other `createRequire(import.meta.url)` usages: jest's own require keeps mocks + resolution.
  [/\bcreateRequire\(\s*import\.meta\.url\s*\)/g, "require"],
  [/\bimport\.meta\.url\b/g, 'require("node:url").pathToFileURL(__filename).href'],
  [/\bimport\.meta\.dirname\b/g, "__dirname"],
  [/\bimport\.meta\.filename\b/g, "__filename"],
];

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2023,
  esModuleInterop: true,
  allowJs: true,
  sourceMap: false,
  inlineSourceMap: false,
};

module.exports = {
  canInstrument: false,

  getCacheKey(sourceText, sourcePath, options) {
    return createHash("sha1")
      .update(SELF_HASH)
      .update(ts.version)
      .update(sourcePath)
      .update(String(Boolean(options && options.supportsStaticESM)))
      .update(sourceText)
      .digest("hex");
  },

  process(sourceText, sourcePath, options) {
    if (options && options.supportsStaticESM) return { code: sourceText };
    let code = sourceText;
    for (const [pattern, replacement] of REWRITES) code = code.replace(pattern, replacement);
    const out = ts.transpileModule(code, { fileName: sourcePath, compilerOptions: COMPILER_OPTIONS });
    return { code: out.outputText };
  },
};
