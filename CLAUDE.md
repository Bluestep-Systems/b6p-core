# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a **single-package TypeScript library**: `@bluestep-systems/b6p-core`, published to the public
npm registry. It is the vscode-free core shared by the `b6p` CLI and the VS Code extension, which live
in their own repositories (`b6p-cli`, `b6p-vscode`) and depend on this package by version.

The library has **zero `vscode.*` imports**. Anything that needs a platform capability (file system,
prompts, logging, progress, persistence) goes through a provider interface in [src/providers.ts](src/providers.ts)
that the consumer implements. Do not introduce a `vscode` import here — that breaks the CLI build and
the package's reason for existing.

When you add a new exported symbol, also add it to [src/index.ts](src/index.ts) — that file is the
public API surface.

## Common Development Commands

```bash
npm run compile       # Build → dist/ (tsc)
npm run watch         # Incremental rebuild on change
npm run check-types   # Type-check only (tsc --noEmit)
npm run lint          # ESLint
npm run format        # Prettier --write (config in .prettierrc)
npm run format-check  # Prettier --check
npm run clean         # rm -rf dist
```

There are no tests in this repo today; the consumers (CLI, extension) carry the integration tests. Core
ships vscode-free test utilities (e.g. `MockFileSystem`) for those consumers to use.

## Architecture Overview

**B6PCore** ([src/B6PCore.ts](src/B6PCore.ts)) is the headless orchestrator. Consumers construct it with
their `B6PProviders`, then call command methods (`push`, `pull`, `audit`, `deploy`, `report`, etc.). It
implements `ScriptContext` and holds the auth, session, cache, and script-factory subsystems. All
platform-specific behaviour is delegated to the injected providers.

Key subsystems under `src/`:

- **auth/** — `BasicAuthProvider`: credential management per authentication profile ("flag").
- **session/** — `SessionManager`: WebDAV login, CSRF tokens, cookie/session handling, request retry.
- **network/** — `HttpClient`, response codes.
- **script/** — the script tree (`ScriptRoot`/`ScriptNode`/`ScriptFile`/`ScriptFolder`), `ScriptFactory`,
  transpilation, and snapshot history.
- **persistence/** — `PseudoMap`/`TypedMap` abstractions, `Persistable`, serialization registry, and the
  public/private persistence maps. Persistence is durable key/value supplied via `IPersistence`.
- **cache/** — `OrgCache`, `ScriptMetaDataStore`.
- **data/** — pure utilities: URL/path parsers, glob matching, id utilities, org worker.
- **constants/** — endpoints, auth types, MIME types, settings keys, etc.
- **update/** — `UpdateService`: GitHub-releases-based update checking.
- **testing/** — vscode-free test doubles (`MockFileSystem`).

### Authentication & Session flow

WebDAV login → CSRF token extraction → request retry with tokens. Sessions are cleaned up on auth
failures with progressive retry delays. This logic lives in `SessionManager` / `BasicAuthProvider`.

## TypeScript Configuration

- **Target/module**: ES2022 / Node16, `strict` mode. Base options in `tsconfig.base.json`,
  package overrides in `tsconfig.json`.
- **Output**: `dist/` with `.d.ts` declarations (`declaration: true`). `declarationMap` is disabled —
  consumers bundle the library, so source maps to `src/` would dangle in the published tarball.

## Important Development Guidelines

- **Never use the `any` type.** If it seems unavoidable, leave a `//HUMAN-REVIEW-NEEDED` comment
  explaining why instead.
- **Keep types accurate.** Update `src/types.ts` and function signatures when behaviour changes; do not
  rely on implied types.
- **Number formatting**: use underscores for thousands separators (`1_000`, `10_000_000`).
- **No `vscode` imports** anywhere in `src/`.
- **Formatting**: Prettier (120 print width, 2-space, semicolons, `trailingComma: es5`).

## Additional Instructions

Defer to [AGENTS.md](AGENTS.md) for AI agent usage and documentation-sync rules. If there are any
discrepancies, AGENTS.md is authoritative.
