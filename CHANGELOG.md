# Changelog

All notable changes to `@bluestep-systems/b6p-core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
