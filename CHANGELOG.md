# Changelog

All notable changes to `@bluestep-systems/b6p-core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
