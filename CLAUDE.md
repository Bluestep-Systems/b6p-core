# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a **single-package TypeScript library**: `@bluestep-systems/b6p-core`, published to the public
npm registry. It is the vscode-free core shared by the `b6p` CLI and the VS Code extension, which live
in their own repositories (`b6p-cli`, `vscode-extension`) and depend on this package by version.

The library has **zero `vscode.*` imports**. Anything that needs a platform capability (file system,
prompts, logging, progress, persistence) goes through a provider interface in [src/providers.ts](src/providers.ts)
that the consumer implements. Do not introduce a `vscode` import here — that breaks the CLI build and
the package's reason for existing.

When you add a new exported symbol, also add it to [src/index.ts](src/index.ts) — that file is the
public API surface.

## Common Development Commands

```bash
npm run compile       # Build → dist/ (TypeScript 7 tsc)
npm run watch         # Incremental rebuild on change
npm run check-types   # Type-check only (tsc --noEmit)
npm run format        # Prettier --write (config in .prettierrc)
npm run format-check  # Prettier --check — the style gate in CI
npm test              # Compile, then run every test/*.test.js in sequence
npm run clean         # rm -rf dist
```

There is **no linter**. ESLint was removed (see CHANGELOG): its five rules were all `warn`, so
`npm run lint` exited 0 no matter what and gated nothing, and Prettier already covered the only rule
that fired in practice. Style is enforced by `format-check`, correctness by `check-types` under
`strict` + `noUnusedLocals` + `noUnusedParameters` + `noImplicitReturns` + `noFallthroughCasesInSwitch`
+ `noImplicitOverride`. Do not reintroduce a linter without wiring it to a **failing** exit code.

All of those live in `tsconfig.base.json` — strictness belongs there, and `tsconfig.json` carries only
this package's output settings (`rootDir`, `outDir`, `declaration`, `declarationMap`, `types`).

There is **no test framework**. `test/` holds dependency-free node scripts (`node:assert`, `require`)
that `npm test` runs in sequence after a compile; each asserts against the **compiled** output in
`dist/`, not `src/`. A new test file must be appended to the `test` script in `package.json` by hand —
nothing globs the directory, so a file that is not listed there silently never runs.

These are behavioural specs for the pure, high-risk logic that is awkward to reach from a consumer
(integrity auditing, path/URL parsing, URI canonicality and the folder marker, `outDir` resolution,
stale-bundle detection, metadata write coalescing, org-cache load readiness, and the atomic-write
rename retry).

A spec here must pass on **Windows and POSIX alike**. `test/B6PUri.test.js` is the pattern to copy:
it hardcodes no absolute path and no `file://` literal embedding one, building every case from
`path.parse(process.cwd()).root` + `path.join` and deriving every expectation from Node's own
`pathToFileURL` — so each assertion states a relationship rather than a spelling. Literals are fine
where the code under test is pure URL parsing, which is platform-independent; that is how a POSIX
runner still covers `file:///C:/…` drive-letter hrefs. `test/DownstairsPathParser.test.js` shows the
other half of the technique — swapping the ambient `path` members for `path.win32` to drive the
Windows branch from a Linux host. Broad integration coverage still lives in the consumers
(CLI, extension); core additionally ships vscode-free test doubles (e.g. `MockFileSystem`) for them.

## Architecture Overview

**B6PCore** ([src/B6PCore.ts](src/B6PCore.ts)) is the headless SDK entry point. Consumers construct it
with their `B6PProviders`; it owns the platform-facing singletons (auth, session, `OrgCache`,
`ScriptMetaDataStore`) and assembles the subsystem services over them. All platform-specific behaviour
is delegated to the injected providers.

It is a **composition root, and implements none of the interfaces it hands out**. Script management is
reached through `core.script` (a `ScriptService`) — `core.script.push(...)`, `core.script.pull(...)` —
not as methods on `B6PCore`. New areas of platform functionality get their own service beside
`script`; they do not get flattened onto `B6PCore`. What stays on `B6PCore` itself is only what is
genuinely cross-cutting: `updateCredentials`, `clearSessions`, `clearSettings`, `clearAll`, `report`,
`getConfig`/`setConfig`, `checkForUpdates`, `dispose`.

`PlatformContext` ([src/PlatformContext.ts](src/PlatformContext.ts)) is the shared half of every
subsystem's dependency bundle — `fs`, `sessionManager`, `logger`, `prompt`, `progress`,
`isDebugMode()`. `ScriptContext` ([src/script/ScriptContext.ts](src/script/ScriptContext.ts)) extends
it with what only the script subsystem reads (`scriptMetadataStore`, `orgCache`,
`typescriptLibDirs`). `B6PCore` builds the shared half **once** and spreads it into each subsystem's
bundle, so adding a provider is one edit rather than one per subsystem. A new subsystem extends
`PlatformContext` too — do not flatten its members back into a per-subsystem interface.

`B6PCore` **builds these bundles and passes them** rather than being one. That distinction is
load-bearing, not stylistic. While `B6PCore implements ScriptContext` held, the interface tracked the
orchestrator's growth instead of the tree's needs, and accumulated two members with **zero** readers
under `src/script/`: `auth` (only `SessionManager` consumes it) and `getScriptFactory()` (no node
ever called it — `ScriptRoot` mints its own factory). Every member of `ScriptContext` must have a
real reader in the script tree; do not add one because some orchestrator already exposes it, and do
not restore the `implements` clause.

**Dropping `implements` is not enough on its own, and this repo learned that the hard way.**
TypeScript is structural, so `B6PCore` went on satisfying `ScriptContext` anyway — `const ctx:
ScriptContext = core` type-checked — for as long as its raw provider fields were public. The five
providers (`fs`, `persistence`, `prompt`, `logger`, `progress`) are therefore `private`, and that is
load-bearing: it is what actually severs the conformance, and it stops a subsystem reaching
`core.persistence` instead of receiving a bundle. Do not widen them back. This is the same
structural-vs-nominal trap documented for `AuthParams` above; if you change either, re-check the
other.

Key subsystems under `src/`:

- **auth/** — `BearerAuthProvider`: the default `AuthProvider` implementation. Prompts for and stores
  the opaque access token, and renders the `Authorization: Bearer <token>` header value. Core types
  against `AuthProvider<AuthParams>`, so a consumer can inject a different scheme via
  `B6PProviders.auth`.
- **session/** — `SessionManager`: WebDAV login, CSRF tokens, cookie/session handling, request retry.
- **network/** — `HttpClient`, response codes.
- **script/** — `ScriptService` (the `core.script` command surface), the script tree
  (`ScriptRoot`/`ScriptNode`/`ScriptFile`/`ScriptFolder`), `ScriptFactory`, `ScriptContext`,
  transpilation, and snapshot history.
- **persistence/** — `PseudoMap`/`TypedMap` abstractions, `Persistable`, serialization registry, and the
  public/private persistence maps. Persistence is durable key/value supplied via `Persistence`.
- **cache/** — `OrgCache`, `ScriptMetaDataStore`.
- **data/** — pure utilities: URL/path parsers, glob matching, id utilities, org worker.
- **constants/** — endpoints, auth types, MIME types, settings keys, etc.
- **update/** — `UpdateService`: GitHub-releases-based update checking.
- **testing/** — vscode-free test doubles (`MockFileSystem`).

### Authentication & Session flow

WebDAV login → CSRF token extraction → request retry with tokens. Sessions are cleaned up on auth
failures with progressive retry delays. This logic lives in `SessionManager` / `BearerAuthProvider`.

The bearer token is a bootstrap, not a per-request credential: `SessionManager.login()` is the **only**
caller of `AuthProvider.authHeaderValue()`. It sends `Authorization: Bearer <token>` once to
`LOOKUP_TEST`, then harvests the `JSESSIONID`/`INGRESSCOOKIE` cookies that carry every later request.

The scheme itself is pluggable. `AuthProvider<T extends AuthParams>` covers the whole credential
lifecycle, and `T` appears only in return position — the interface is therefore covariant in `T`, which
is what lets core hold `AuthProvider<AuthParams>` while a concrete scheme supplies its own params type.
`AuthParams` carries a `readonly scheme` discriminant, and that discriminant is **load-bearing, not
decorative**: TypeScript is structural, so an empty base interface is the top object type and
`T extends AuthParams` would constrain nothing (`AuthProvider<string>` would type-check). Do not
"simplify" `AuthParams` back to an empty marker — that idiom only works in a nominal type system.

## TypeScript Configuration

- **Target/module**: ES2022 / Node16, `strict` mode. Base options in `tsconfig.base.json`,
  package overrides in `tsconfig.json`.
- **Output**: `dist/` with `.d.ts` declarations (`declaration: true`). `declarationMap` is disabled —
  consumers bundle the library, so source maps to `src/` would dangle in the published tarball.

### Two TypeScripts, on purpose

This repo installs TypeScript **twice**, and the split is load-bearing — do not "simplify" it:

| Role | Package name in `package.json` | Version | Used by |
|------|-------------------------------|---------|---------|
| Build compiler | `typescript-7` (`npm:typescript@7.0.2`), devDependency | 7.x | `compile` / `watch` / `check-types`, via the `tsc7` script |
| Runtime compiler API | `typescript`, **dependency**, exact pin | `5.9.2` | `ScriptTranspiler`, `TsLibResolver` (`import ts from "typescript"`) |

`src/` must keep importing the compiler API as plain `"typescript"` — that is the 5.9 pin, and it must
stay 5.9. TypeScript 7 is the native Go compiler: its `typescript` entry point is only a version stub
(`lib/version.cjs`), the classic API (`createProgram`, `transpileModule`, `parseJsonConfigFileContent`,
`sys`) is gone, and the replacement `typescript/unstable/sync` API talks JSON-RPC to a per-platform
native binary — unbundleable into the CLI's single `dist/cli.js` and its SEA. The pin is exact so a
consumer on TypeScript 7 gets `5.9.2` nested under this package rather than hoisting theirs over it.

The build compiler is invoked by explicit path (`node node_modules/typescript-7/bin/tsc`, wrapped as
`npm run tsc7`) because both packages declare a `tsc` bin; npm gives `node_modules/.bin/tsc` to the
real `typescript` (5.9). Bare `tsc` in a script would silently build with 5.9.

What keeps `typescript` (not `typescript-7`) as the un-aliased name is the runtime import above: `src/`
resolves the compiler API by the bare specifier, so the bare name must be the 5.9 pin. (A second
constraint, `@typescript-eslint`'s `typescript >=4.8.4 <6.1.0` peer, disappeared when ESLint was
removed — it was redundant with this one.)

## Important Development Guidelines

- **Never use the `any` type.** If it seems unavoidable, leave a `//HUMAN-REVIEW-NEEDED` comment
  explaining why instead.
- **Keep types accurate.** Update `src/types.ts` and function signatures when behaviour changes; do not
  rely on implied types.
- **Number formatting**: use underscores for thousands separators (`1_000`, `10_000_000`).
- **No `vscode` imports** anywhere in `src/`.
- **No `I` prefix on interfaces.** Provider interfaces are `FileSystem`, `Persistence`, `Prompt`,
  `Logger`, `Progress`, `AuthProvider`, `LockDiagnoser` — not `IFileSystem`, `IPersistence`, … The prefix was
  a leftover of a `naming-convention` ESLint rule that no longer exists. A new provider added under
  the old convention is a rename-shaped merge conflict waiting to happen.
- **Formatting**: Prettier (120 print width, 2-space, semicolons, `trailingComma: es5`).

## Additional Instructions

Defer to [AGENTS.md](AGENTS.md) for AI agent usage and documentation-sync rules. If there are any
discrepancies, AGENTS.md is authoritative.
