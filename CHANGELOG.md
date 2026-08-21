# Changelog

All notable changes to `@bluestep-systems/b6p-core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-08-21

### Changed

- **Rolled back the TypeScript 7 type-checker; this package now builds and runs on one exact-pinned
  compiler, `typescript` 5.9.2.** The `typescript-7` alias (`npm:typescript@7.0.2`) and the `tsc7`
  script indirection are gone; `compile`, `watch` and `check-types` call `tsc` directly. No source
  changed — the tree type-checks clean on 5.9.2, 6.0.0-beta and 7.0.2 alike — so this is a toolchain
  change only. The published `dist/` is now emitted by 5.9.2; the suite runs against `dist/`, so that
  is covered.

  **Why.** This library compiles TypeScript *at runtime*: `push --snapshot` transpiles
  `draft/scripts/*.ts` in-process through `ScriptTranspiler`, so it needs the compiler as a library.
  TypeScript 7 cannot serve that. Its `typescript` entry point is only a version stub, the classic API
  (`createProgram`, `transpileModule`, `parseJsonConfigFileContent`, `sys`) is absent, and the
  replacement `typescript/unstable/sync` drives a per-platform native Go binary over JSON-RPC — 20
  optional dependencies located at runtime by `lib/getExePath.js`, unbundleable into the CLI's single
  `dist/cli.js` and its Node SEA binaries. TypeScript 7 additionally ships **zero** `lib.*.d.ts` files
  (the Go port embeds them) while the transpiler needs real lib files on disk.

  So type-checking with 7 while compiling with 5.9 at runtime bought build-time speed in exchange for
  a permanent two-compiler split, and it is the split — not the speed — that shaped the code: the
  `tsc7` indirection existed only because both packages declared a `tsc` bin, and the CLI's
  `copy-ts-libs` step had to resolve `typescript` from *this* package's directory so the shipped libs
  matched the compiler that reads them.

  Going forward again needs a TypeScript that can compile **in-process**. The decision, the
  alternatives (including why not the 6.0 beta — there is no stable 6.x, and its 107 lib files against
  this runtime's 99 re-arm the mismatch hazard) and the trigger to revisit are recorded in
  `b6p-cli/docs/adr/0002-typescript-version-strategy.md`.

## [0.6.0] - 2026-08-21

### Fixed

- **`pull` no longer overwrites a locally-edited file it has previously synced** (ClickUp
  86bbdr4r0, reported against `draft/README.md`). `ScriptFile.download()` wrote the fetched bytes
  unconditionally; nothing between the gitignore check and the write looked at the local file, so
  local edits — including content the tooling itself scaffolded — were destroyed without a word.
  It now hashes the fetched bytes first and, when the local file has been edited since the last
  push/pull (its content hash no longer matches the recorded `lastVerifiedHash`) and the platform
  copy differs, **keeps the local copy** and reports it — one aggregated warning (capped at ten
  listed paths) emitted from the pull's `finally`, so it survives a pull that throws mid-loop. A
  kept file's metadata is left untouched, so `audit` keeps reporting the divergence; to take the
  platform copy, sync via an audit pull or delete the file and pull again.

  The guard deliberately does **not** prompt: `download()` runs once per file inside the pull
  loop, where a blocking stdin read can never complete non-interactively (a piped `pull` would
  hang and then exit 0 with a half-written tree and its deferred metadata batch unflushed), and a
  dismissed or mistyped answer would be indistinguishable from a deliberate choice.

  The protection is scoped, not absolute — the qualifier matters: a file with differing content
  but **no** metadata record still overwrites, as before. The record store is machine-local and
  routinely empty (fresh clone, new machine, cleared state), so guarding that case would make a
  first pull on such a machine write nothing at all. Files that are absent, identical, or
  unmodified-since-last-sync download exactly as before. Covered by
  `test/PullDivergenceGuard.test.js`.

  The ETag integrity check also moved **before** the write (it compares the fetched bytes rather
  than the just-written file), so a failed integrity check no longer leaves the local file already
  clobbered by the bad download. And the write itself is now **atomic** (temp sibling + rename,
  with a direct-write fallback if the rename fails): an interrupted pull can no longer leave a
  truncated file that the guard would misread as a local edit and keep forever — pre-guard, a
  re-pull repaired such a file, and atomicity preserves that property.

- **`pull` reports its outcome to machine consumers, and `auditPull` cannot silently authorize
  overwrites.** `ScriptService.pull`/`pullCurrent` now return a `PullResult`
  (`{ keptLocalPaths }`, exported from the package root; `null` when the pull aborted before
  fetching), so a CLI `--json` or an agent-facing tool can see that files were deliberately left
  unsynced instead of reporting unqualified success.

  `auditPull`'s confirmation puts **"Cancel" first**: prompt implementations answer with the first
  option on an empty answer and under non-interactive auto-confirm (the CLI's `--yes`), and this
  prompt authorizes overwriting locally-edited files — an auto-supplied answer is not a human
  decision. Non-interactive audit-pulls therefore decline the sync (delete-and-pull remains the
  non-interactive path to a platform copy). On a real confirmation, the overwrite is **scoped to
  exactly the files the user saw**: `pull`'s option is now `overwriteLocalPaths: string[]` (was
  `overwriteLocal: boolean`, never released) and `auditPull` passes the confirmed changed-file
  list — files audit could not compare (numeric/complex-ETag declarations, which it never listed)
  stay protected by the guard instead of being force-overwritten undisclosed.

- **Snapshot history survives the platform's post-upload version settling** (ClickUp 86bbed9wu).
  The second consecutive snapshot push to the same component failed to record its history entry
  with a server-side optimistic-locking rejection ("Unable to update BaseTable because of version
  mismatch: expected ver. N, actual ver. N+1") — the upload that just finished bumps the script
  object's version, and the bump can still be settling when the history mutation lands. The client
  sends no version anywhere, so there is nothing to refresh locally; waiting is the fix (running
  `b6p audit` between pushes "worked" purely as a delay). `SnapshotHistoryRecorder.record()` now
  retries the mutation with backoff (1s/2s/4s by default, injectable via a new `retryDelaysMs`
  option) when — and only when — the GraphQL error is a version mismatch, anchored on the
  optimistic-lock wording (`because of version mismatch` or a numbered `expected ver. N` clause) so
  an unrelated fatal error that merely contains the phrase "version mismatch" fails fast instead of
  burning the backoff; every other failure, including a non-2xx HTTP response, still throws on the
  first attempt. Covered by `test/SnapshotHistoryRetry.test.js`.

- **A snapshot push whose history step fails no longer claims "Snapshot complete!".** `executePush`
  swallowed the recorder error into a `[WARN]` line and printed the success message anyway, so the
  operator had no signal that no restore point exists for that snapshot. It now ends with an
  explicit warning saying the files were uploaded but the history entry was not recorded, and how
  to retry. For machine consumers, `executePush` (and `ScriptService.push`/`pushCurrent`) now
  returns a `PushResult` (`{ pushed, historyRecorded }`, exported from the package root; the
  service methods return `null` when the target-URL prompt was cancelled) so a CLI can exit
  non-zero or emit the failure in `--json` instead of relying on a human reading stderr. `pushed`
  is false — and must be checked first — when the push aborted before uploading anything (draft
  folder missing or empty): those paths print an error/notice but previously had no
  machine-readable signal at all, so a wrapper could mark a deploy green on a `--root` typo.

## [0.5.0] - 2026-08-12

### Fixed

- **`OrgCache` dropped its `store()` promises on the floor.** Both `cleanupOldEntries` and
  `cleanDuplicates` issued the write without awaiting it, so a rejected write surfaced as an
  unhandled rejection — from construction, and from the 1-day timer, which sat in no promise chain
  at all. The `catch` on the readiness promise did **not** cover this: it only ever saw a
  *synchronous* throw. Both methods are now `async` and await the write, `whenReady()` consequently
  waits for the first cleanup write to land rather than resolving while it is in flight, and the
  timer path has its own handler so a failed scheduled sweep cannot end the process.

  The spec that was supposed to cover this used a synchronous throw and so passed against the
  leaking code; it now drives both failure shapes and asserts no `unhandledRejection` fires.

- **`B6PUri.stripDirectoryMarker` mishandled roots, backslashes and query strings.** As first
  written it trimmed trailing characters matching `path.sep` or `/`, which meant three things: it
  recognised `\` only when *running on Windows*, making every comparison built on it
  host-dependent — untenable in a repo whose specs drive Windows paths from POSIX hosts; it trimmed
  roots into different locations (`C:\` → `C:`, the drive-relative path; `file:///C:/` →
  `file:///C:`); and it could not see a marker that sat before a query or fragment, so
  `https://h/a/?x=1` and `https://h/a?x=1` — one directory, since `asDirectory()` preserves the
  query — keyed apart.

  It now treats `/` and `\` alike on every host, preserves roots, and for a hierarchical URL strips
  the marker from the *pathname* so query and fragment survive.

- **The integrity check threw `crypto is not defined` on Node 18.** `ScriptFile.getHash()` called the
  ambient `crypto.subtle`, which Node only exposes unflagged from 19 — so on Node 18 every
  ETag comparison behind `push` and `audit` threw, while `package.json` declared `engines: >=18`.
  Pre-existing; it surfaced only because this release makes CI run the full suite instead of one
  spec file, and it failed on the first PR that did.

  Two changes: `getHash()` now imports `webcrypto` from `node:crypto` explicitly, so it no longer
  depends on which runtime exposes which global; and the **engines floor moves to `>=20`**, with
  Node 18 dropped from the CI matrix. Node 18 reached end-of-life in April 2025, so the old floor
  was claiming support that was neither tested nor working.

- **`b6p push` silently stopped warning about stale compiled client bundles.** Caught in review
  before merge; never released. An intermediate revision of this branch made `B6PUri.dirname` return
  a folder-marked URI. `TsConfig.folder()` is built from `rawUri.dirname`, so
  `ScriptRoot.findStaleClientBundles` began pushing a marker-terminated `sourceRoot`, and
  `selectStaleBundles`'s containment test — which uses `path.normalize`, and `path.normalize`
  **preserves** a trailing separator — compared every draft file against `"…/static" + sep + sep`.
  Nothing matched, so `newestSource` stayed `-Infinity`, every bundle was skipped, and the warning at
  `push.ts` never fired for either a plain or a snapshot push.

  `dirname` no longer marks. Both sides of the containment test additionally go through the new
  `B6PUri.stripDirectoryMarker`, so the comparison is correct regardless of which spelling reaches
  it. `test/StaleClientBundles.test.js` fed the pure helper hand-written unmarked roots, which is
  exactly why it could not see this; it now also drives a marked root.

- **`BearerAuthProvider.createNew()` accepted an empty token it would then reject.** `createNew`
  rejected only `undefined` (cancel), so an empty entry was stored and logged as "Token stored" —
  but `isBearerAuthParams` requires a non-empty token, so `hasCredentials()` immediately returned
  false and the next `authHeaderValue()` re-prompted. A user pressing Enter on the token box got an
  unbounded prompt loop with a success message each time. Empty is now treated as cancellation, the
  same as `undefined`. (`update()` still reads empty as "keep the current token" — there it has one
  to keep.) New in this release; the old `BasicAuthProvider` had no validator.

- **`OrgCache.dispose()` before the initial load leaked a self-rearming timer.** Introduced by the
  readiness fix below: deferring the first sweep onto the load meant `_cleanupTimer` was still null
  during the construction tick, so a `dispose()` in that window cleared nothing and the deferred
  sweep then armed a 1-day timer that re-armed itself forever. Bites a CLI path that constructs the
  core and hits `finally { core.dispose() }` immediately, or a fast extension deactivation.
  `dispose()` now sets a flag the sweep checks before arming.

- **Constructing `B6PCore` wiped the persisted org cache.** `OrgCache`'s constructor ran its
  expiry sweep synchronously, but `PublicPersistanceMap` loads asynchronously and *reassigns* its
  backing object when the load lands. The sweep therefore iterated a still-empty map and `store()`d
  that emptiness over the real file. Reproduced against the compiled output: a cache holding one U
  became `{}` on disk after nothing but `new OrgCache(...)`.

  The damage was invisible. The in-memory copy arrived a moment later and looked correct for the
  rest of the session, so the cost only showed up as a later run paying a BlueHQ round trip for a U
  it had already resolved. Any local-only command (`b6p setup-url`) was enough to trigger it.

  The same reassignment discarded writes issued before the load: `getAnyBaseUrl` could miss, hit
  BlueHQ, `set()` the result, and have it dropped when the load replaced the object.

  `OrgCache` now exposes `whenReady()` and every public method awaits it before touching the map;
  the first sweep is chained onto the load rather than racing it. `findUCacheOnly` is synchronous
  and cannot await, so it now reports a miss (with a warning) rather than silently answering from
  an unloaded cache — callers should `await orgCache.whenReady()` first. Covered by
  `test/OrgCacheReadiness.test.js`.

- **`OrgCache` no longer rewrites the whole cache file when nothing expired.** The sweep's
  `store()` was unconditional, so every construction issued a full write. It now writes only when
  an entry actually aged out — one fewer rapid-fire write on the path that `SharedFilePersistence`
  already carries Windows lock-retry logic for. The partial-expiry path additionally passed
  `update: false` to `set()`, which otherwise stores on the spot and made the single write below it
  a second, redundant one.

- **`OrgCache`'s readiness promise can no longer reject.** Its own doc promised it "resolves — never
  rejects", but the chain had no `catch`. `whenReady()` genuinely never rejects; the sweep chained
  onto it reaches `Persistence.set`, and a consumer implementation that throws synchronously would
  have produced an unhandled rejection at construction — and left `ready` permanently rejected, so
  every gated method would reject for the rest of the process's life.

### Changed (breaking)

- **Script commands moved from `B6PCore` to `B6PCore.script`.** `B6PCore` is now a composition root
  for a headless SDK rather than a flat bag of script commands, so that further areas of platform
  functionality can be added as sibling services instead of accreting onto one class. Every
  script-management operation moved verbatim onto the new `ScriptService` (`src/script/ScriptService.ts`),
  reached as `core.script`:

  | Was | Now |
  | --- | --- |
  | `core.push` / `core.pushCurrent` | `core.script.push` / `core.script.pushCurrent` |
  | `core.pull` / `core.pullCurrent` | `core.script.pull` / `core.script.pullCurrent` |
  | `core.audit` / `core.auditPull` | `core.script.audit` / `core.script.auditPull` |
  | `core.deploy` | `core.script.deploy` |
  | `core.getSetupUrl` | `core.script.getSetupUrl` |
  | `core.deriveWorkspacePath` | `core.script.deriveWorkspacePath` |
  | `core.getScriptFactory()` | `core.script.getFactory()` |

  Behaviour is unchanged in every case; the call sites move and nothing else. `AuditResult` is now
  exported from `ScriptService` rather than `B6PCore` (the re-export from the package root is
  unchanged, so `import type { AuditResult } from "@bluestep-systems/b6p-core"` still resolves).
  Remaining on `B6PCore`: `updateCredentials`, `clearSessions`, `clearSettings`, `clearAll`, `report`,
  `getConfig`/`setConfig`, `checkForUpdates`, `dispose`, and the platform singletons it owns.

- **`B6PCore` no longer implements `ScriptContext`** — it *builds* one and holds it as
  passes it to `ScriptService`, and does not expose it. Consumers that passed a `B6PCore` where a
  `ScriptContext` was expected (e.g. `new ScriptFactory(core)`) must construct their own bundle from
  the providers they already hold — core deliberately offers no accessor, since publishing one would
  restore the service-locator this change removes. `core.script.getFactory()` covers the common case
  of wanting a `ScriptFactory`.

  The `implements` relation was the defect. `ScriptContext` is a dependency bundle for the script
  tree, but making the orchestrator satisfy it meant the interface tracked *B6PCore's* growth rather
  than the tree's needs — every field added to the orchestrator became a candidate for leaking in.
  Holding the bundle instead of inheriting its shape also severs the construction cycle in which
  `B6PCore` both assembled the script tree and was a member of it.

- **`ScriptContext.auth` and `ScriptContext.getScriptFactory()` removed.** Both had zero readers under
  `src/script/` — measured, not assumed. `auth` is consumed only by `SessionManager`, which holds the
  provider directly; it lost its last script-tree reader when `SnapshotHistoryRecorder` stopped
  deriving an author from the credentials. `getScriptFactory()` was never called through the interface
  at all: `ScriptRoot` mints its own factory from the context it already holds, because asking the
  bundle to return something that closes over the bundle is circular. Both were on the interface only
  because `B6PCore` happened to expose them.

  A consumer supplying its own `ScriptContext` adapter loses these two obligations. It does **not**
  come out strictly smaller overall, though: `progress` was added to the bundle in the same release
  (see the `PlatformContext` entry below), so the net change is −2/+1 and an existing adapter needs
  `progress` added.

- **`ScriptContext` now extends the new `PlatformContext`, and absorbs `progress`.** The bundle had
  mixed two categories that scale differently: platform-generic members (`fs`, `sessionManager`,
  `logger`, `prompt`, `isDebugMode()`) and script-specific ones (`scriptMetadataStore`, `orgCache`,
  `typescriptLibDirs`). With one flat interface per subsystem, a second service would restate five
  of the eight, `B6PCore`'s constructor would grow a second literal repeating them, and adding a
  provider would mean editing every one.

  `PlatformContext` (`src/PlatformContext.ts`, exported from the package root) is now the shared
  half, built once in `B6PCore` and spread into each subsystem's bundle. `ScriptContext` extends it
  with the three script-specific members. The member set a consumer must supply is unchanged apart
  from `progress`.

  `progress` moved **into** the bundle. It had a reader under `src/script/` (`push.ts`), which is
  the stated membership test, yet was threaded separately — so the rule and the code disagreed.
  `ScriptService`'s constructor is now `(ctx: ScriptContext)` rather than `(ctx, progress)`, and
  `executePush` no longer takes a `progress` option.

- **`B6PCore.fs`, `.persistence`, `.prompt`, `.logger` and `.progress` are private.** They were
  verbatim re-publications of objects the consumer had just passed in, and they made the class a
  service locator: a subsystem could reach `core.persistence` instead of receiving a bundle.

  They also falsified this class's own documentation. The 0.5.0 work removed `implements
  ScriptContext` and the doc comment claimed the class "deliberately does not implement any of the
  interfaces it hands out" — but `const ctx: ScriptContext = core` still type-checked, because
  these fields supplied every member. TypeScript is structural: dropping the clause removed the
  declaration, not the conformance. Making them private is what makes the claim true, and it is
  now verified rather than asserted. Still public: `auth`, `sessionManager`, `scriptMetadataStore`,
  `orgCache`, `updateService`, `script` — the objects core *builds*, which a consumer cannot reach
  any other way.

- **Basic auth replaced by bearer auth.** `BasicAuthProvider` and `BasicAuthParams` are gone,
  superseded by `BearerAuthProvider` and `BearerAuthParams` (`{ scheme: "bearer"; token: string }`). The
  provider holds a single opaque access token, prompted from the user and kept in secret storage under
  the key `bearerAuth`, and renders `Authorization: Bearer <token>`.

  The method surface carries over unchanged — `authHeaderValue`, `getOrCreate`, `createNew`, `update`,
  `clear` and `hasCredentials`. `B6PCore.updateCredentials()` and `clearAll()` keep their signatures.
  `SessionManager` is untouched: it consumes only `AuthProvider.authHeaderValue()`, so the bearer token
  bootstraps the cookie session exactly where the basic credentials used to.

  `BearerAuthProvider.getOrCreate()` now parses and validates what it reads out of secret storage
  instead of asserting it. A value that is not well-formed `"bearer"` params is logged, discarded and
  treated as absent, so the caller is re-prompted rather than sending a header of `"Bearer undefined"`.
  `hasCredentials()` shares that check, so it never reports credentials that `getOrCreate()` would
  immediately throw away.

  **There is no migration path, by construction** — a bearer token cannot be derived from a stored
  username and password. On first use after upgrading, the user is prompted for a token. To avoid
  leaving the old credential pair sitting in secret storage indefinitely, `BearerAuthProvider.clear()`
  also deletes the legacy `basicAuth` key, so `B6PCore.clearAll()` purges it.

  Removed with it: `AuthTypes.BASIC_PREFIX` (already dead — `BasicAuthProvider` hardcoded its own
  `"Basic "` literal and never referenced the constant) and the unreferenced `PrivateKeys.BASIC_AUTH`
  enum member.

- **`Auth` renamed to `AuthProvider`, made generic, and widened to the whole credential lifecycle.**
  It was `Auth { authHeaderValue() }`; it is now `AuthProvider<T extends AuthParams>` and additionally
  declares `getOrCreate`, `createNew`, `update`, `clear` and `hasCredentials`. `T` is the scheme's
  credential shape and occurs only in return position, so the interface is covariant in it — an
  `AuthProvider<BearerAuthParams>` is assignable to `AuthProvider<AuthParams>`, which is how core holds
  the general type while a concrete scheme supplies the specific one.

  It is also now actually exported from the package root. Every other provider interface was already in
  `index.ts`'s `export type { … } from "./providers"` block; `Auth` was omitted, which made it awkward
  for a consumer to type its own implementation. Type-only.

- **`B6PCore.auth` is typed `AuthProvider<AuthParams>`**, not the concrete provider class. Consumers
  reaching for bearer-specific members through that field must now hold a `BearerAuthProvider`
  reference of their own. (`ScriptContext.auth` was likewise retyped, then removed outright — see
  above.)

- **`B6PUri.fromUrl` is renamed `B6PUri.fromString`**, and it now **parses and canonicalizes** its
  argument (`new URL(url).href`) instead of storing the string verbatim. Two consequences for
  consumers:

  - A malformed URI now throws `TypeError` (`ERR_INVALID_URL`) at the `fromString` call rather than at
    the first `fsPath` / `scheme` / `joinPath` access an arbitrary distance downstream.
  - Distinct spellings of one resource now converge. `fromString("file:///a b")`,
    `fromString("file://localhost/a%20b")` and `fromFsPath("/a b")` previously produced three unequal
    `B6PUri`s that `equals` reported as different and that keyed apart in any `Map` over `toString()`
    (as `MockFileSystem` uses). They are now one value.

  Canonicality is what makes `equals` equality-of-denotation rather than equality-of-spelling; it was
  previously an invariant of `fromFsPath` only, though the class doc claimed it for both.

  Note that the trailing-separator **folder marker** survives canonicalization and remains
  significant: `file:///a/b` and `file:///a/b/` denote a file and a folder respectively, and are
  still — correctly — unequal. See `B6PUri.isDirectoryMarked` below.

### Added

- **`B6PUri.isDirectoryMarked` and `B6PUri.asDirectory()`** — first-class handling of the
  trailing-separator folder marker that `ScriptFactory.createNode` uses as its *only* folder signal
  (it cannot touch the filesystem, so a path is classified by shape alone).

  `isDirectoryMarked` tests the URL pathname, which matches `createNode`'s `fsPath.endsWith(path.sep)`
  for `file://` URIs but also works on the WebDAV / HTTP URIs whose `fsPath` would throw.
  `asDirectory()` applies the marker, is idempotent, returns `this` when the marker is already present,
  and preserves query and fragment (appending to the href would not).

  Together they replace the hand-rolled `joinPath("/")` / `path.join(p, "/")` idiom that four sites
  used to re-establish the marker after `joinPath` drops it. All four are migrated: `ScriptRoot`
  (the `rootUri` constructor and `getAsFolder`), `ScriptFolder.flattenDirectory`, and `push.ts`.
  Behaviour at those sites is unchanged — `asDirectory()` is asserted equal to the `joinPath("/")`
  idiom it replaces — but the intent is now stated rather than spelled out in path arithmetic.

- **`ScriptService`** (`src/script/ScriptService.ts`), exported from the package root, holding the
  script-management command surface listed above. Its constructor takes a single `ScriptContext`
  (which now carries `progress` — see below) and it holds no reference to the orchestrator, so a
  consumer can construct one directly against its own context.

- **`DeployConfig`**, the JSON shape consumed by `deploy`, is now a named exported interface rather
  than being declared inline inside the method body.

- **`PlatformContext`**, the shared half of every subsystem's dependency bundle. See the
  `ScriptContext` entry above.

- **`OrgCache.whenReady()`**, so a caller can await the initial load before using the synchronous
  `findUCacheOnly`.

- **The auth scheme is injectable**: `B6PProviders` gains an optional `auth?: AuthProvider<AuthParams>`.
  When absent, `B6PCore` constructs a `BearerAuthProvider` over the supplied `persistence`, `prompt`
  and `logger` exactly as before, so existing consumers need no change. Supplying it lets a consumer
  authenticate by any scheme it likes — core only ever asks for an `Authorization` header value and
  drives the lifecycle through the interface, and never inspects the credentials themselves.

- **`AuthParams`**, the base every scheme's credential shape extends, carrying a `readonly scheme:
  string` discriminant. The discriminant is what makes the base load-bearing: TypeScript is structural,
  so an empty base would be the top object type and `T extends AuthParams` would admit every non-nullish
  type, including `string` and `() => void`. With `scheme` present the constraint binds, concrete params
  form a discriminated union, and a provider can verify what it read back out of storage.

### Changed

- The push implementation module moved from `src/push.ts` to `src/script/push.ts`, joining the rest of
  the script subsystem. `executePush` is still exported from the package root, so the import path
  consumers use is unchanged.

- `ScriptFactory.createNode` no longer branches on whether the basename contains a `.`. Both arms of
  that test returned `new ScriptFile(uri, sr)`, so it decided nothing. A trailing separator is now
  documented as the only folder signal. The branch was deleted rather than completed — classifying an
  extensionless path as a `ScriptFolder` would be a real behaviour change, and this method cannot
  touch the filesystem to find out. No behaviour change.

- **Snapshot history no longer records an author.** `SnapshotHistoryRecorder` derived the `author`
  field from the stored basic-auth username; a bearer token is opaque and exposes no client-readable
  identity, so the field is now the literal `"unknown"`. This is a data-fidelity regression, not a
  cosmetic one: `author` lives inside the client-composed `historyKey` blob rather than a schema field,
  so the server cannot backfill it. Restoring it needs an identity source — a `/whoami`-style lookup
  against the token, or the login response carrying the principal into `SessionData`.

- **Provider interfaces lost their `I` prefix**: `IFileSystem`, `IPersistence`, `IPrompt`, `ILogger`,
  `IProgress` and `ILockDiagnoser` are now `FileSystem`, `Persistence`, `Prompt`, `Logger`, `Progress`
  and `LockDiagnoser`. `LockHolder`, `FileStat`, `ProgressTask` and `B6PProviders` were already
  unprefixed and are unchanged; `Auth` was renamed separately (see below). These are type-only exports,
  so a consumer's fix is limited to its `import type` lines and `implements` clauses — no runtime
  behaviour changed.

  The prefix existed only to satisfy a `naming-convention` rule from the typescript-eslint stack
  removed below; with the rule gone the convention no longer had anything holding it up, and it was
  inconsistent with the rest of the exported surface. `LockDiagnoser` shipped as `ILockDiagnoser` in
  0.4.0 and is renamed here in the same sweep rather than being left as the sole `I`-prefixed name.

- The CI and publish `Lint` step is replaced by **`Format check`** (`npm run format-check`), and
  `prepublishOnly` now runs `format-check` in place of `lint`. Prettier was previously not gated
  anywhere, so this is a net increase in enforcement: the removed step could not fail, the new one can.

- **`noImplicitOverride` is now on** (in `tsconfig.base.json`, alongside the other strictness flags).
  A member that overrides a base-class member must say `override`, so a base-class rename can no
  longer silently orphan an intended override into a new, never-called method. Four existing sites
  were annotated: `ScriptFile.delete`, and `ScriptFolder`'s `equals` / `path` / `uri`.

- **CI now runs the whole test suite, and the publish workflow runs it at all.** `ci.yml`'s `Test`
  step invoked `node test/DownstairsPathParser.test.js` directly, so seven of the eight specs — every
  one added in 0.3.1 and 0.4.0, including the `SharedFilePersistence` rename-retry and
  `ScriptMetaDataStore` write-coalescing coverage — never ran on a pull request. `publish.yml` had no
  `Test` step whatsoever, so a tagged release could reach npm with zero specs executed. Both now run
  `npm test`. Note the suite is **not** globbed: a new `test/*.test.js` runs only once it is added by
  hand to the `test` script in `package.json`.

- The repo now builds and type-checks with **TypeScript 7** (`tsc` from the native Go compiler),
  installed as the aliased devDependency `typescript-7` (`npm:typescript@7.0.2`). Emitted `.js` and
  `.d.ts` are byte-identical to the 5.9 output; only `.js.map` mappings differ. Full-project
  `check-types` drops from ~1.3s to ~0.13s.
- **`typescript` is now a runtime `dependency`, pinned exactly to `5.9.2`** (previously a floating
  `^5.9.2` devDependency). `ScriptTranspiler` and `TsLibResolver` import the TypeScript compiler API
  (`ts.createProgram`, `ts.parseJsonConfigFileContent`, `ts.sys`) at runtime, so it was never really a
  dev-only dependency. TypeScript 7 does **not** expose that API — its `typescript` entry point resolves
  to a version stub, and the replacement `typescript/unstable/sync` API drives a native Go child process
  over JSON-RPC, which cannot be bundled into the CLI's SEA binary. The transpiler therefore stays on
  the classic 5.9 API, pinned so a consumer's own TypeScript upgrade cannot move it: npm nests
  `typescript@5.9.2` under `node_modules/@bluestep-systems/b6p-core/` when the consumer's top-level
  `typescript` differs.

- **`ScriptFolder.contains()` returned `false` for genuine children of a directory-marked folder**,
  which made every `createFamilial()` call throw `"not a sibling within the same script root"`.

  The comparison built its prefix as `thisPath + path.sep`. On a marked path that doubles the
  separator — `/a/b/` + `/` = `/a/b//` — and no child path starts with that. The receiver in both
  `ScriptFile.createFamilial` and `ScriptFolder.createFamilial` is `ScriptRoot.getAsFolder()`, whose
  URI is marked, so the guard rejected every sibling it was asked about. Both sides of the comparison
  now have the trailing marker removed first, so a marked and an unmarked spelling of one directory
  compare equal. A filesystem root (`/`, `C:\`) is left alone rather than stripped to nothing.

  This predates the `B6PUri.dirname` change below and was reachable from consumers only —
  `createFamilial` has no callers inside core, which is why the suite never caught it.

- **`B6PUri.stripDirectoryMarker(p)`** — the one definition behind every marker-insensitive
  comparison: `ScriptFolder.contains`/`equals`, `ScriptRoot.selectStaleBundles`'s containment test,
  and `MockFileSystem`'s entry keys. It sits beside `isDirectoryMarked` / `asDirectory` on purpose:
  a comparison rule that disagrees with the API producing the marker is how the regression below
  happened. A filesystem root (`/`, `C:\`) is left alone.

  `B6PUri.dirname` **does not** carry the folder marker. An intermediate revision of this branch made
  it `.asDirectory()`-marked, on the reasoning that its result is a directory in every case by
  construction. That broke `b6p push`'s stale-client-bundle warning outright — see **Fixed** above —
  and the misclassification it was guarding against (`ScriptFactory.createNode` treating a parent
  directory as a `ScriptFile`) is unreachable from any of the six call sites, every one of which
  either calls `createFolder` explicitly or takes `.fsPath`. A caller that wants the marked spelling
  asks for it with `.asDirectory()`.

### Security

- Raised the `fast-xml-parser` floor from `^5.5.6` to `^5.10.1`, above the range affected by
  [GHSA-8r6m-32jq-jx6q](https://github.com/advisories/GHSA-8r6m-32jq-jx6q) (high; repeated `DOCTYPE`
  declarations reset entity-expansion limits). Versions `5.9.3`–`5.10.0` are affected, and the old
  `^5.5.6` floor let a consumer's existing lockfile stay pinned inside that window. b6p-core reaches
  `XMLParser.parse` on server-controlled WebDAV `PROPFIND` responses in [src/script/push.ts](src/script/push.ts) and
  [src/data/ScriptUrlParser.ts](src/data/ScriptUrlParser.ts), both with default options
  (`processEntities: true`).

  Practical impact here looks low: on the affected 5.9.3, nested entity definitions are not expanded at
  all (an entity whose value references another entity is left literal at every depth), so the usual
  billion-laughs amplification did not reproduce in local testing. That is not a clearance — it only
  means no exploit path was demonstrated from these two call sites — so the floor was raised anyway,
  which costs nothing. On 5.10.1 a repeated-`DOCTYPE` document is rejected outright with
  "Multiple DOCTYPE declarations found."

### Removed

- **`B6PCore.typescriptLibDirs`**, the public field. It was a pass-through with no reader: core copied
  `providers.typescriptLibDirs` onto itself and then only ever read it back out to build the script
  context. It is now read straight from `providers` into that context. The provider option
  `B6PProviders.typescriptLibDirs` is unchanged and still the way a consumer supplies lib directories;
  only the redundant mirror on the instance is gone.

  For the record on what that option does, since the chain is long: it is consumed at exactly one
  place, `ScriptTranspiler.createProgram`, which hands it to `TsLibResolver.resolveLibDir` as
  `explicitDirs` and overrides the compiler host's `getDefaultLibLocation` / `getDefaultLibFileName`.
  It is reached only from `ScriptRoot.compileDraftFolder()` — i.e. **snapshot pushes only**. It exists
  because TypeScript's default host finds `lib.*.d.ts` via `dirname(__filename)`, which points inside
  the consumer's bundle once b6p-core is bundled, where no libs live.

- **`ScriptFactory.setDefaultContext()` and the five `static` `create*` shims**
  (`ScriptFactory.createNode` / `createFolder` / `createFile` / `createScriptRoot` / `createTsConfig`),
  along with the module-scoped mutable `_defaultCtx` they read through. Nothing in this package called
  any of them.

  It was a service locator sitting on top of the one `ScriptContext` just stopped being: the factory's
  behaviour depended on whether some unrelated code had called the registration method first, so a
  static `createFile(...)` either worked or threw at runtime depending on process-global state, and two
  contexts alive at once (a test double alongside a live core) could not be kept apart. Its stated
  purpose — "backwards compatibility with callers that don't have direct access to a `ScriptContext`" —
  no longer describes anything: a caller that needs a factory asks `core.script.getFactory()`, and
  one building its own script tree constructs a `ScriptContext` from the providers it already holds.

  Callers construct a bound factory instead: `core.script.getFactory()`, `scriptRoot.factory`, or
  `new ScriptFactory(ctx)`.

- **ESLint** (`eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, and
  `eslint.config.mjs`). All five configured rules were severity `"warn"` with no `--max-warnings`, so
  `npm run lint` exited 0 regardless of violations — the `Lint` step in `ci.yml`, `publish.yml`, and
  `prepublishOnly` could never fail, and `src/` carried zero `eslint-disable` comments because the
  config had never refused anything. The config was also not type-aware (no `parserOptions.project`),
  so the typescript-eslint stack contributed exactly one cosmetic rule (`naming-convention` on
  imports). Of the rest, `semi` duplicated Prettier's `"semi": true`, and `curly` / `eqeqeq` /
  `no-throw-literal` were advisory-only. Cost: 79 of 93 installed packages (85%) and 22MB.
  Dev install is now 14 packages / 67MB.

## [0.4.0] - 2026-07-23

### Fixed

- `SharedFilePersistence.atomicWrite` now retries `fs.rename` on transient Windows lock errors
  (`EPERM`/`EBUSY`/`EACCES`) with exponential backoff (up to 7 attempts, ~2.55s) instead of failing on
  the first error. This is the race that killed `pull` near the end (~21/23) when real-time AV /
  ransomware protection, file sync, an editor, or a second `b6p` process momentarily held `state.json`
  open. The temp file is best-effort cleaned up on failure exits, so failed writes no longer leave `.tmp`
  residue behind. Non-lock errno values are still thrown immediately.
  ([#8](https://github.com/Bluestep-Systems/b6p-core/issues/8))

### Added

- New injectable `ILockDiagnoser` provider (with `LockHolder`), injected via the
  `SharedFilePersistence` constructor. When rename retries are exhausted, core calls the diagnoser
  (best-effort, never throws) to annotate the error with the processes holding the file — or, when no
  user-mode process holds it, a hint that a filesystem minifilter (e.g. Sophos CryptoGuard) is likely
  intercepting the rename. The OS-specific implementation lives in the consumer (CLI / extension).

### Changed

- `pull` now coalesces the per-script metadata writes into a single atomic write at the end of the run
  instead of rewriting `state.json` once per script. This reduces the rapid write burst that trips
  antivirus/ransomware heuristics in the first place, while keeping atomic temp-file + rename semantics
  (no partial-write risk) and without any blocking write debounce. Backed by a new `update` flag on
  `PersistablePseudoMap.set` and `beginBatch()` / `flush()` on `ScriptMetaDataStore`.

## [0.3.1] - 2026-07-21

Fixes two `push` bugs around freshly-pulled MergeReport components that ship a `static/` bundle
([b6p-cli#9](https://github.com/Bluestep-Systems/b6p-cli/issues/9)).

### Fixed

- `push` no longer aborts on a `static/` sub-project whose `tsconfig.json` has an empty (`""`) or
  missing `outDir`. `TsConfig.getBuildFolder()` treated an empty string as "not specified" and threw
  `MissingConfigurationError`, aborting the whole pre-push build with a bare `outDir not specified`. It
  now falls back to the transpiler's own default build folder (`.build`) via the new
  `TsConfig.resolveOutDir()`. `.build` (not `.`) is deliberate: it keeps a source `.ts` out of "its
  respective build folder", so the file stays eligible for transpile and the collision-prompt logic is
  unaffected. Normalizing on pull was rejected — it would rewrite platform-served content and make
  `audit` report the file as changed on every run. A fresh MergeReport static bundle can arrive with an
  empty `outDir` from the platform's creation scaffold, which previously blocked every push.

### Added

- Loud stale-client-bundle warning on `push`. `b6p push` does not transpile client TypeScript, and the
  platform serves a MergeReport `static/` bundle's compiled `static/.build/script.js` verbatim rather
  than recompiling `static/script.ts` server-side (verified against a live org). Editing only the source
  therefore silently shipped stale client JS. `ScriptRoot.findStaleClientBundles()` (with the pure,
  unit-tested `ScriptRoot.selectStaleBundles()`) now flags any nested tsconfig sub-project whose newest
  source `.ts`/`.tsx` is newer than the newest compiled `.js` in its build folder, and `executePush`
  emits a loud warning for each — on both plain and snapshot pushes. The draft-root tsconfig (which
  governs platform-compiled `scripts/*.ts`) is excluded, so it never false-fires.
- `deleteBuildFolder()` routes its "build folder doesn't exist yet" note through the logger instead of
  `console.log`, keeping `--json` stdout clean.
- Regression tests: `test/TsConfigBuildFolder.test.js` and `test/StaleClientBundles.test.js`.

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
