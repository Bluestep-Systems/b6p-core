# b6p-core — agent rules

Library `@bluestep-systems/b6p-core`, published to public npm (an npm-workspaces repo: this package is the repo root,
and `packages/bsjs-git` is `@bluestep-systems/b6p-core-bsjs-git`, see below): the vscode-free core
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
- **One stored `b6pt_` token, two uses.** On the web origin it is a bootstrap, not a per-request
  credential: `SessionManager.login()` is the only caller of `AuthProvider.authHeaderValue()`, sends
  the bearer once to `LOOKUP_TEST`, then harvests the `JSESSIONID`/`INGRESSCOOKIE` cookies that carry
  every later request. On web-global's gateway the same token *is* sent on every request, with no
  session: `GatewayClient` reads it through `BearerAuthProvider.storedToken()` (never prompts), not
  `authHeaderValue()`, and never through `SessionManager`. The gateway sends it only to its
  configured origin (https, or http on loopback), and it never appears in a message or log line.
  The gateway side has exactly one write to it: `core.gateway.tokens.rotate()` of the stored token
  puts the replacement in place through `GatewayTokenStore` →
  `BearerAuthProvider.replaceStoredToken(expected, next)`, which refuses unless the stored token is
  still `expected` (an in-process compare-then-write, not atomic across processes; do not claim
  more). There is never a second stored token. Rotation runs list + rotate + store as ONE
  `GatewayClient.sequence()` unit with one token read, so `current`, the token presented and
  `expected` agree and no queued request presents the revoked token. A minted secret that
  *reaches* core is never dropped: a store failure (including a read-back that finds another
  writer's value) throws `GatewayTokenStoreError` (`replacement`), an off-contract answer
  `GatewayOffContractTokenError` (`secret`, still stored for the stored token), both
  non-enumerable. A secret whose answer never arrives (dropped connection, timeout, 502/503/504 on
  the mint or rotate POST) is lost; core says so with `GatewayOutcomeUnknownError` (outcome
  unknown, the old token may be revoked) and must not report it as a plain unavailable error.
  `SharedFilePersistence` serializes each file's mutations in-process (one queue per file, secrets and state);
  across processes it is still last-writer-wins, which is why the store reads back.
  Never quote a user-supplied id-or-alias in a message; it may be a pasted secret.
- **`core.gateway` is the second subsystem** (`GatewayService`, `src/gateway/`). `GatewayContext`
  extends `PlatformContext` with `gatewayToken` (a `GatewayTokenSource`), `gatewayTokenStore` (a
  `GatewayTokenStore`, read only by token rotation), `gatewayUrl()` (core config
  `settings.gatewayUrl`, default `https://gateway.bluestep.net`) and `fetchFn`. `tokens`
  (`GatewayTokenService`, the caller's own tokens) sits beside `client` and `git`, and knowledge-base
  and marketplace operations go there too, over that one client, so all REST requests made through
  the client share its sequential queue, and so does every git operation and token rotation
  (`GatewayClient.sequence`, the one queue primitive); `authHeadersFor` itself is not queued.
  The client never follows a redirect (a 3xx is `redirect-refused`) and refuses a path that resolves
  off the gateway origin. Errors are `Err.Gateway*`; a git layer maps statuses
  with `gatewayErrorFor` rather than its own table.
- **`core.gateway.git` (`GatewayGit`) is pure-JS git (isomorphic-git, exact-pinned) and keeps four
  rules.** It runs only on gateway-supplied `gitUrl`s, with the bearer from `authHeadersFor(url)` on
  every request (a foreign origin throws first; a 3xx is `redirect-refused`, never followed; a response whose URL is off
  the origin is discarded). It pushes only
  fast-forwards: no `force`, no `delete`, no tags, and a branch behind its upstream is refused
  before the wire. A pull never overwrites: it throws `GatewayDirtyWorkingTreeError` with the
  paths instead of prompting (anything staged refuses, since the checkout rebuilds the index), and puts the branch back if a checkout refuses. And it never
  rewrites file contents (no autocrlf). Its clones go through Node's `fs`, not the `FileSystem`
  provider, which has no `lstat`/symlink/mode surface for isomorphic-git. Each operation runs
  inside `GatewayClient.sequence`. Its specs mount `git http-backend` on `FakeGateway`
  (`test/support/GitHttpBackend.js`), so they need `git` on PATH.
- **`core.gateway.marketplace` (`GatewayMarketplace`) is a plain working clone, never a push.** It
  is independent of script sources and pins, takes every `gitUrl` from the listing, and refuses a
  clone of another repo or ref (`GatewayCloneMismatchError`) rather than prompting, and takes the consumer's `cwd` (never
  `process.cwd()`). A repo name becomes a folder name only when `dir` is omitted, and is then
  checked as one plain segment; a malformed listing entry is skipped, not fatal.
- **`core.gateway.kb` (`GatewayKb`) decides nothing for the user.** It never prompts: a pull that
  would overwrite throws `GatewayDirtyWorkingTreeError`, and a push the listing says the user cannot
  make (`canPush: false`, from a fresh listing, not a cached one) throws before any git request. It
  has no "discard local changes" path; if one is ever added it is an explicit option behind a
  `{ destructive: true, safeOption }` prompt, safe option first. A listed `name` or tenant used as a
  default folder must be one plain path segment: no leading or trailing `.` (so never `.git`), no
  `GIT~1`, control characters or Windows device names.
- **Knowledge-base admin (`create`, `detail`/`read`, `update`) is core's, never a consumer's.** A consumer wires
  it and adds its own confirmation; it does not rebuild the requests. `update` is one `PATCH` with `If-Match`
  (the `etag` from `detail`/`read`). `GatewayKnowledgeBaseAccess` keeps an exact kind match, treats an unknown
  kind as private, and never sends one back: setting access takes `public` or `private` only.
- **A prompt that overwrites or deletes puts its safe option first and passes
  `{ destructive: true, safeOption }`.** Prompt implementations answer `options[0]` on an empty
  answer and under auto-confirm (the CLI's `--yes`); with the destructive option first, `--yes`
  overwrote platform edits and deleted platform-only files (ClickUp `86bc2h3ef`). Ask only when
  something is really at risk, too: a prompt that fires for safe cases becomes a wall once its
  default declines.
- **Core's messages say what happened and why, never how to respond.** No flag names, no option
  labels to type, no stdin tricks: core doesn't know whether a CLI, an agent or VS Code is asking.
  The consumer adds the "how"; give it structured data (e.g. `OverwriteDeclinedError.paths`,
  `PushResult.keptPlatformOnly`) to build it from.
- **Requests through `SessionManager` stay sequential.** `fetch()` shares no in-flight `login()`,
  so N concurrent requests on an expired session log in N times. And every response re-saves the
  session through `Persistence.setSecret()`: `SharedFilePersistence` re-encrypts `secrets.enc` and
  atomically renames it into place each time, so a parallel burst is the write-then-rename pattern
  `atomicWrite` documents as tripping Windows ransomware protection. Share one login per origin and
  coalesce `save()` before parallelizing anything.

Subsystems under `src/`: `auth/` (`BearerAuthProvider`), `session/` (`SessionManager` — WebDAV login,
CSRF, cookies, retry), `network/`, `script/` (`ScriptService`, the script tree, `GitSync` push/pull/audit of the draft
as a git working tree, `GitIdentity` commit authors, `ServerCompile` reading the platform's build diagnostics),
`schema/` (`SchemaService`, `core.schema`: super-only schema apply over the org's `/gql`, `SchemaContext` extends `PlatformContext`),
`gateway/` (`GatewayService`, `GatewayClient`, `GatewayGit`, `GatewayTokenService`, `GatewayMarketplace`, `GatewayKb` —
web-global's gateway over the `b6pt_` token, pure-JS git through it, the caller's own token
management, marketplace clones and knowledge bases), `persistence/`, `cache/` (`OrgCache`, `ScriptMetaDataStore`),
`data/` (pure parsers and utilities, `ServerVersion`), `constants/`, `update/`, `testing/` (vscode-free doubles,
including `FakeGateway`).

## Scripts are git (since 0.9.0), and the platform builds them (since 1.0.0)

A script's `draft/` folder is the working tree of its git repo; push, pull, audit and deploy are in
`src/script/GitSync.ts` over `bsjsGit.ScriptRepo`. No draft or snapshot file goes over WebDAV (only `declarations/` and
the root `.gitignore` do). Rules that bind changes here:

- **No default commit author**, ever: `resolveGitIdentity` (explicit, `git config`, environment, else an error before the
  platform is touched). A literal `"unknown"` author is the bug this replaced.
- **A pull never switches a WebDAV script to git without the confirmation** (safe answer first); a push does, on its
  first write, and says so (`switchedToGit`).
- **A push never overwrites a platform edit without the one confirmation**; a confirmed overwrite is a merge commit so
  the platform's history stays. Never force-push.
- **Nothing compiles here, in either package.** The push chain is git push → `compileDraft` pinned to the pushed commit
  (`ScriptRepo.compileDraft`, `expectedDraftSha`) → fast-forward the folder to the platform's build commit → (snapshot)
  publish that commit → read back `master`. The platform commits the output, and the build manifest only when it vouches
  for the build, authored by the pushing user; an unclean build is published-or-refused by the platform's manifest check
  (`BUILD_STALE`, `BUILD_MANIFEST_MISSING`), never decided by core. Every push builds, plain ones too.
- **`MIN_SERVER_VERSION` (`data/ServerVersion.ts`) routes every push**: a `dev`/`latest` server or one at or above it
  builds; any other (below it, unreadable version, floor unset) gets the git push alone, and a snapshot there is a
  result (`PushResult.snapshotRefused`), not an error. It stays `null` until the first web tag with the git build
  exists; 1.0.0 cannot release while it is `null` (`test/ServerVersionFloor.test.js` fails then).
- **The fast-forward to the build commit never loses a local edit** (`ScriptRepo.fastForwardToBuild`): it updates the
  working tree and index for exactly the paths the build changed, and moves the draft ref only after that succeeded.
  A local copy matching neither side (an edit, an untracked or ignored file) stops it with nothing changed
  (`buildFastForward.state` `blocked`, the paths listed); it is never forced over. A build whose answer was lost is
  taken in by the next push when the platform's draft is exactly the build of the local head
  (`ScriptRepo.isBuildCommitOf`: every commit of the chain carries `Bluestep-Build-Of: <the pushed sha>`, has one
  parent and changes only paths under some build project's output folder at the parent (`buildOutputFolders`, shared
  with web and the editor), by complete tree entries, exactly web's rule;
  the subject never counts), never a platform edit. A build whose outcome the platform cannot tell
  (`BUILD_OUTCOME_UNKNOWN`) is never retried: the draft is read back instead, and nothing is published.
- `PushResult.typeCheckErrors` are the platform build's diagnostics in the script's own sources (no `.d.ts`, nothing
  outside the tree; `ServerCompile.typeCheckErrorsOf`), `typeCheckDiagnostics` the platform's whole count. A build
  that fails after a successful push is `buildError` (`buildErrorKind`), one that ends in a status that does not
  publish `buildIncomplete`, a failed publish `publishError`: once the push succeeded, nothing throws, and none of
  these reports "complete". A deploy target asked for a snapshot that published nothing is a failure.
- The git working tree uses `ScriptContext.gitFs` (Node `fs`), not the `FileSystem` provider; both address the same disk.

## The bsjs-git package

`packages/bsjs-git` (`@bluestep-systems/b6p-core-bsjs-git`) is the browser-safe git client: isomorphic-git against the
platform's git proxy, the platform's build (`compileDraft`) and publish, git history, and the legacy history archive
client. It is a dependency of this package (re-exported as `bsjsGit`) and of the BSJS editor. Its rules differ from the
rest of the repo:

- **No Node built-ins, no Node-only globals** (`Buffer`, `process`) in `packages/bsjs-git/src`; the file system is
  injected. `packages/bsjs-git/test/NoNodeBuiltins.test.js` fails the build otherwise.
- **No compiler**: the editor and this package push sources and ask the platform to build (`ScriptRepo.compileDraft`).
  `typescript` is a devDependency there too, for building the package only.
- **No WebDAV, no `SessionManager`** there: it talks to the proxy with the bearer token directly and must not import
  from this package (the dependency runs one way).
- Its own scripts mirror this package's (`compile`, `check-types`, `format-check`, `test`); the root scripts build and
  run both, so `npm test` and `npm run check-types` here cover both packages.
- `npm run watch` (root) is `tsc -b` over project references, so it builds and watches both packages.
- The `buffer` shim (`src/bufferShim.ts`) is the one allowed mention of `Buffer`; `BrowserBundle.test.js` bundles the
  package for a browser to prove it still resolves.
- It is published first (see `publish.yml`); bump its version when its API changes.

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

**`typescript` is an exact-pinned `devDependency` (7.x) in both packages and builds them only.** Nothing ships a
compiler and nothing in `src/` (of either package) may import `typescript`: the platform compiles BSJS, so a push sends
sources over git and never emits or type-checks. Do not move it back to `dependencies`, do not float the pin, and read
`b6p-cli/docs/adr/0003-*` (the TypeScript version strategy, superseding 0002) before changing this.

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
  24 and 26, and again on windows-latest (Node 24). Address automated review rounds as follow-up commits on the same branch.
- **Releases**: a `release: vX.Y.Z — summary` commit bumps `package.json` / `package-lock.json` and
  dates the CHANGELOG block. After it merges, push an annotated tag
  (`git tag -a vX.Y.Z -m "vX.Y.Z — summary" && git push origin vX.Y.Z`). `publish.yml` publishes to
  npm, then creates the GitHub Release from that CHANGELOG block, titled with the tag message's
  first line. A Release made by hand first is left as is. Pushing tags without a Release step is
  how the Releases page stopped at v0.5.0 while npm reached 0.7.0.
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
