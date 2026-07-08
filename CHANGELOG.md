# Changelog

All notable changes to `@bluestep-systems/b6p-core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-08

### Fixed

- `audit` no longer reports declaration/library files (`declarations/index.d.ts`,
  `console.graal.d.ts`, `scriptlibrary.d.ts`, …) as changed on every run, even right after a clean
  pull ([#4](https://github.com/Bluestep-Systems/b6p-core/issues/4)). Those files are served with
  numeric/complex ("memory document") ETags rather than SHA-512 content hashes, so `getUpstairsHash`
  returns `null` and the old comparison (`localHash === null`) was always a mismatch. Audit now uses
  the new `ScriptFile.currentIntegrityStatus`, which reports such files as `"indeterminate"` and skips
  them (mirroring `download`, which already skips integrity verification for those ETag classes)
  instead of flagging a difference it cannot substantiate. Push behavior is unchanged.
- `getSetupUrl` (the `b6p setup` command) always failed with "No stored metadata found … Pull the script
  first", even immediately after a successful pull and even when `audit`/`push` worked on the same file.
  Two stacked defects: (1) it read metadata from a raw `scriptMeta.<name>` persistence key that nothing
  writes, instead of the `ScriptMetaDataStore` (keyed by `U` + `scriptName`) that `pull` populates and
  `audit`/`push` consume; and (2) the persistence-backed maps load from `state.json` asynchronously, so a
  synchronous read before that load lands sees an empty store — `getSetupUrl` was the first command to
  read metadata without a prior `await` to mask it. `getSetupUrl` now resolves via the shared store and
  `ScriptKey.buildSetupUrl`, and the store load is awaited before lookups.

### Added

- `ScriptFile.currentIntegrityStatus` — tri-state integrity check (`"match"` / `"mismatch"` /
  `"indeterminate"`) distinguishing a genuine content difference from the absence of a comparable
  upstairs content hash. `currentIntegrityMatches` now delegates to it.
- Regression tests for audit integrity status (`test/AuditIntegrity.test.js`).
- `PublicPersistanceMap.whenReady()` / `ScriptMetaDataStore.whenReady()` — await completion of the
  asynchronous initial load from persistence before reading the map synchronously. Awaited by
  `ScriptRoot.getMetaData` / `modifyMetaData` and the pull conflict-check, hardening `audit`/`push`
  (previously correct only by timing) alongside the `setup` fix.
- Regression test for `getSetupUrl` covering URL resolution from stored metadata and the no-metadata
  error path, exercising the readiness await.

## [0.2.0] - 2026-07-07

### Fixed

- Bundled-TypeScript library resolution: when b6p-core is bundled into a consumer (the CLI's single
  `dist/cli.js` or its SEA binary), TypeScript's default host resolved `lib.*.d.ts` via
  `dirname(__filename)` — the bundle directory, where those files don't exist — so the snapshot-push
  transpile failed on every project with "File 'lib.esnext.d.ts' not found" cascading into "Cannot find
  global type 'Array'". `ScriptTranspiler` now supplies a `CompilerHost` that resolves the lib directory
  independently of `__filename` (via the new `TsLibResolver`).
- `skipLibCheck` was silently dropped when parsing a project's `tsconfig.json`, so a legitimate
  `lib: ["dom", "WebWorker"]` config produced spurious lib-vs-lib conflicts. Transpile invariants
  (`skipLibCheck`, `listEmittedFiles`, `noEmitOnError: false`) are now forced onto the parsed options.
- The transpile step is now an enforced emit gate: type diagnostics are advisory (logged as warnings and
  no longer block the push), but a genuine emit failure throws so a push cannot proceed with missing
  JavaScript.

### Added

- `TsLibResolver` (public export) — locates TypeScript's `lib.*.d.ts` directory from consumer-supplied
  directories or the project-local `node_modules/typescript/lib`, without relying on `__filename`.
- `B6PProviders.typescriptLibDirs` — optional directories the consumer ships/extracts its `lib.*.d.ts`
  to, searched before the project-local typescript install (needed for bundled CLI / SEA runs).
- Regression tests for lib-directory resolution and the bundled "broken vs fixed" host behavior.

## [0.1.1] - 2026-06-24

### Fixed

- Windows drive-letter paths (`C:\…`) were mangled by `DownstairsPathParser`: the parser prepended a
  bogus separator before the drive letter, corrupting every path derived from the script root. Now uses
  `path.parse().root` to preserve the real filesystem root on all platforms.

### Added

- Unit tests for `DownstairsPathParser` covering Windows drive-letter paths, POSIX absolute paths,
  relative paths, and `getShavedName()` / `equals()` behaviour.

## [0.1.0] - 2026-06-23

Initial standalone release. Extracted (with history) from the former
`bsjs-push-pull` monorepo into its own repository and published to the public npm registry.

### Added

- Self-contained build, lint, type-check, and format tooling (`tsconfig.base.json`, `eslint.config.mjs`,
  `.prettierrc`) so the package builds independently of the old monorepo root.
- CI workflow (`.github/workflows/ci.yml`) validating type-check, lint, and compile on PRs and pushes.
- Publish workflow (`.github/workflows/publish.yml`) — tag `v*.*.*` → `npm publish --provenance
  --access public` to the public npm registry.
- Committed `.npmrc` pinning the `@bluestep-systems` scope to `registry.npmjs.org`.

### Changed

- Decoupled from VS Code's ambient `Thenable<T>` global (previously available only via the monorepo's
  hoisted `@types/vscode`); persistence APIs now use the standard `PromiseLike<void>`. Type-only change,
  no runtime impact.
- Dropped `declarationMap` from the build (kept `.d.ts` declarations) to avoid published source-map
  references to `src/`, which is not shipped.
- `package.json` prepared for public publishing: removed `private`, added `publishConfig.access: public`,
  `repository`, `engines`, and a `prepublishOnly` build gate.
