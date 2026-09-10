# b6p-core — agent rules

Single-package library `@bluestep-systems/b6p-core`, published to public npm: the vscode-free core
shared by the `b6p` CLI and the VS Code extension, each in its own repo depending on this package by
version. Public API surface is [src/index.ts](src/index.ts); the headless orchestrator is
[src/B6PCore.ts](src/B6PCore.ts).

## Hard constraints

- **No `vscode` imports anywhere in `src/`.** Platform behaviour is delegated to the provider
  interfaces in [src/providers.ts](src/providers.ts). A `vscode` import breaks the CLI build and the
  package's reason for existing.
- **A new exported symbol MUST be added to `src/index.ts`** — that file defines what consumers can
  import.
- **Never use `any`.** If it seems unavoidable, leave a `//HUMAN-REVIEW-NEEDED` comment explaining
  why; a human who later accepts it adds `//REASON-FOR-ANY`.
- **Keep types accurate** — update `src/types.ts` and function signatures when behaviour changes;
  never rely on implied types.
- **No `I` prefix on interfaces**: `FileSystem`, `Persistence`, `Prompt`, `Logger`, `Progress`,
  `AuthProvider`, `LockDiagnoser` — not `IFileSystem`. A new provider under the old convention is a
  rename-shaped merge conflict waiting to happen.
- **Number formatting**: underscores for thousands (`1_000`, `10_000_000`).

## Architecture rules

`B6PCore` is a **composition root and implements none of the interfaces it hands out.** Consumers
construct it with their `B6PProviders`; it owns the platform-facing singletons (auth, session,
`OrgCache`, `ScriptMetaDataStore`) and assembles the subsystem services over them. The rules below
are load-bearing rather than stylistic — each records something this repo undid once already.

- **New platform areas get their own service beside `script`, never flattened onto `B6PCore`.**
  Script management is `core.script` (a `ScriptService`). What stays on `B6PCore` is only the
  genuinely cross-cutting: `updateCredentials`, `clearSessions`, `clearSettings`, `clearAll`,
  `report`, `getConfig`/`setConfig`, `checkForUpdates`, `dispose`.
- **`PlatformContext` is the shared half of every subsystem's dependency bundle** (`fs`,
  `sessionManager`, `logger`, `prompt`, `progress`, `isDebugMode()`); `ScriptContext` extends it with
  what only the script tree reads. `B6PCore` builds the shared half once and spreads it, so adding a
  provider is one edit rather than one per subsystem. A new subsystem extends `PlatformContext` too —
  do not flatten its members into a per-subsystem interface.
- **Do not restore `B6PCore implements ScriptContext`**, and every member of `ScriptContext` must
  have a real reader under `src/script/`. While the clause held, the interface tracked the
  orchestrator's growth instead of the tree's needs and grew two members no node read.
- **The five raw providers (`fs`, `persistence`, `prompt`, `logger`, `progress`) are `private` and
  must stay private.** TypeScript is structural, so dropping `implements` alone did nothing —
  privacy is what actually severs the conformance, and it stops a subsystem reaching
  `core.persistence` instead of receiving a bundle.
- **`AuthParams` keeps its `readonly scheme` discriminant** — the same structural trap. An empty
  base interface is the top object type, so `T extends AuthParams` would constrain nothing and
  `AuthProvider<string>` would type-check. Do not "simplify" it to an empty marker; if you change
  this or the rule above, re-check the other.
- **The bearer token is a bootstrap, not a per-request credential.** `SessionManager.login()` is the
  only caller of `AuthProvider.authHeaderValue()`: it sends the bearer once to `LOOKUP_TEST`, then
  harvests the `JSESSIONID`/`INGRESSCOOKIE` cookies that carry every later request.

Subsystems under `src/`: `auth/` (`BearerAuthProvider`), `session/` (`SessionManager` — WebDAV login,
CSRF, cookies, retry), `network/`, `script/` (`ScriptService`, the script tree, transpilation,
snapshot history), `persistence/`, `cache/` (`OrgCache`, `ScriptMetaDataStore`), `data/` (pure
parsers and utilities), `constants/`, `update/`, `testing/` (vscode-free doubles).

## Commands

```bash
npm run compile       # build → dist/ with .d.ts declarations
npm run watch         # incremental rebuild on change
npm run check-types   # type-check only
npm run format        # prettier --write (.prettierrc: 120 width, 2-space, semicolons, es5 commas)
npm run format-check  # prettier --check — the style gate in CI
npm test              # compile, then run every test/*.test.js in sequence
npm run clean
```

Run `npm run format` before committing. **Writing a test? Read [test/README.md](test/README.md)
first** — there is no framework, a new file must be listed in `package.json` by hand or it silently
never runs, and every spec has to pass on Windows and POSIX alike.

**There is no linter**, deliberately: ESLint's five rules were all `warn`, so `npm run lint` exited 0
no matter what. Correctness comes from `check-types` under `strict` + `noUnusedLocals` +
`noUnusedParameters` + `noImplicitReturns` + `noFallthroughCasesInSwitch` + `noImplicitOverride`, all
in `tsconfig.base.json` — strictness belongs there, and `tsconfig.json` carries only this package's
output settings. Do not reintroduce a linter without wiring it to a **failing** exit code.

**`typescript` is an exact-pinned runtime `dependency` at 5.9.2**, not a devDependency: this library
compiles TypeScript *while running* (a `push --snapshot` transpiles in-process), so it needs the
compiler as a library, and the same version builds the package. Do not float the pin, do not add a
second compiler, and read `b6p-cli/docs/adr/0002-typescript-version-strategy.md` before touching it —
it records why TypeScript 7 cannot serve this role and what would have to change first.

## Documentation, in the same change

| File | Update when |
|------|-------------|
| `README.md` | public API, install or usage changes |
| `AGENTS.md` (this file) | architecture, subsystem, conventions or process changes |
| `test/README.md` | how tests are written or run changes |
| `CHANGELOG.md` | any user-visible change, fix, or breaking change |

`CLAUDE.md` is a one-line bridge to this file; do not put rules there. Outdated documentation is worse
than none — if uncertain, leave a `//HUMAN-REVIEW-NEEDED` note.

## JSDoc review tags

All AI-generated or AI-modified JSDoc **must** carry `@lastreviewed null`; a human replaces `null`
with the review date. Modifying an already-reviewed block resets its tag to `null` — the old date does
not cover the new text.

`test/JsdocLastReviewed.test.js` enforces this as a **ratchet, and only half of it**: it fails when a
file gains net-new *untagged* blocks beyond the tolerated count in
`test/jsdoc-lastreviewed.baseline.json`. It **cannot catch a modified block** — a rewritten block
keeps its old count and its stale review date, so resetting that date is reviewer diligence, not
something CI verifies. Moving an untagged grandfathered block between files reads as new in the
destination; tag it in passing rather than fighting the ratchet. After tagging previously-untagged
blocks, tighten it with `node test/JsdocLastReviewed.test.js --update`. **Never raise a baseline
number to make the check pass** — tag the JSDoc instead.

## Branch, commit, PR, ClickUp

- **Branches** carry the ClickUp id with the `CU-` prefix: `CU-<taskid>` or
  `<type>/<slug>-CU-<taskid>`. That exact spelling is what ClickUp's GitHub integration matches.
- **Commits** are conventional (`fix(scope):`, `feat:`, `docs:`, `release: vX.Y.Z — summary`) and
  reference the task as `(CU-<taskid>)`. AI-authored commits carry their `Co-Authored-By` trailer.
- **PRs** target `master`. CI must pass — type-check, format-check, compile and the full suite on Node
  20 and 22. Address automated review rounds as follow-up commits on the same branch.
- **Feedback-pipeline lifecycle**: when a fix has actually shipped, comment on the reporting ClickUp
  task and move it to **"check on 20"**. **Never close tasks directly** — a pass closes via the
  resolution-note email flow, a fail returns on the "rejected fix" lane with the failing check cited.
- **Shipping chain**: this library reaches users only through its consumers. A core fix is shipped
  once a b6p-core release lands **and** a consumer release (b6p-cli, vscode-extension) bundles it —
  not when the PR merges here.
- **Line endings**: repo blobs are LF. On a CRLF checkout a local `format-check` false-fails on every
  file while CI passes — trust CI, and never commit a mass reformat for line-ending noise.

Where a guideline is genuinely impractical you may override it, with a `//HUMAN-REVIEW-NEEDED`
comment saying why and what a human must check.
