# @bluestep-systems/b6p-core

The core library for **B6P** — BlueStep script management (push / pull / audit / deploy of JavaScript &
TypeScript "formula" scripts, through git).

This package contains the headless orchestration logic shared by the
[`b6p` CLI](https://github.com/Bluestep-Systems/b6p-cli) and the
[VS Code extension](https://github.com/Bluestep-Systems/vscode-extension). It's **platform-agnostic** — it runs
anywhere Node does. You supply the platform adapters (file system, prompts, logging, progress,
persistence) through provider interfaces.

## Requirements

Node.js **24 or newer** (`engines.node` is `>=24`).

## Packages

This repo holds two npm packages: `@bluestep-systems/b6p-core` (this one, Node) and
[`@bluestep-systems/b6p-core-bsjs-git`](packages/bsjs-git/README.md) (browser and Node: git editing, publish and history
of BSJS scripts through the platform's git proxy). The first depends on the second and re-exports it as `bsjsGit`.

## Installation

```bash
npm install @bluestep-systems/b6p-core
```

## Usage

Construct `B6PCore` with your platform's [`B6PProviders`](src/providers.ts) implementation, then reach
the platform through its subsystem services:

```typescript
import { B6PCore, type B6PProviders } from "@bluestep-systems/b6p-core";

const providers: B6PProviders = {
  fs, // FileSystem  — read/write/list files
  persistence, // Persistence — durable key/value (settings, sessions)
  prompt, // Prompt      — ask the user for input/credentials
  logger, // Logger      — diagnostic logging
  progress, // Progress    — long-running task reporting
};

const core = new B6PCore(providers);

await core.script.pull({ formulaUrl: "https://org.bluestep.net/files/<id>/", workspacePath });
await core.script.push({ rootPath, snapshot: true, message: "Update script" });
const audit = await core.script.audit({ filePath, workspacePath });
```

### Command surface

`B6PCore` is a composition root, not a flat command bag. It owns the platform-facing singletons —
`auth`, `sessionManager`, `orgCache`, `scriptMetadataStore` — and exposes each area of
functionality as its own service. Script management is `core.script`; further subsystems are added
beside it rather than onto `B6PCore` itself.

`core.script` ([`ScriptService`](src/script/ScriptService.ts)) — everything that moves a script tree
between the local filesystem and the platform (the draft over git, `declarations/` over WebDAV):

| Method                 | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `push` / `pushCurrent` | Commit and push the draft folder (optionally publish it as a snapshot) |
| `pull` / `pullCurrent` | Clone or fast-forward the draft into a workspace                       |
| `audit` / `auditPull`  | Compare local vs. server; optionally pull differences                  |
| `deploy`               | Multi-target deploy driven by a config file                            |
| `getSetupUrl`          | Resolve a pulled script's web-UI setup page                            |
| `deriveWorkspacePath`  | Recover the workspace folder from a path inside a script root          |
| `getFactory`           | The `ScriptFactory` for entering the script tree from a bare path      |

`core.schema` ([`SchemaService`](src/schema/SchemaService.ts)) — declarative schema apply against one org
(super users only; every method takes any URL on the org):

| Method          | Purpose                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `generate`      | The manifest (YAML) describing the named objects as they stand, optionally `closure` / `portable`                              |
| `recipe`        | Run a recipe (`LINK_VIEW_GRANTS`): its manifest plus the findings it met                                                       |
| `test`          | Dry-run a manifest as the caller: the plan, any refusals, and a one-use key when it passes (`verbose` adds same-name warnings) |
| `apply`         | Apply the plan a `test` approved: the same manifest string and its key; never retried                                          |
| `testThenApply` | `test`, ask `confirm` with the result, then `apply` with the same manifest and key                                             |

`core.gateway` ([`GatewayService`](src/gateway/GatewayService.ts)) — web-global's gateway
(`https://gateway.bluestep.net`), the origin for knowledge bases and marketplace repos. It
holds the HTTP client, the git layer, `core.gateway.kb` (knowledge bases), `core.gateway.marketplace`
and `core.gateway.tokens` for managing the caller's own access tokens; see [Gateway](#gateway) below.

`core.gitCredential` ([`GitCredentialService`](src/gitCredential/GitCredentialService.ts)) — b6p as git's
credential helper, so plain `git fetch`, `pull` and `push` use the stored token; see
[git's credential helper](#gits-credential-helper) below.

`core` itself — cross-cutting state that is not specific to any one subsystem:

| Method                                                               | Purpose                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `report`                                                             | Report cached metadata / org-cache state                  |
| `updateCredentials` / `clearSessions` / `clearSettings` / `clearAll` | Auth & state management                                   |
| `getConfig` / `setConfig`                                            | Configuration helpers                                     |
| `checkForUpdates`                                                    | GitHub-releases-based update check                        |
| `dispose`                                                            | Release the session cleanup timer and org-cache resources |

See [`src/index.ts`](src/index.ts) for the full set of exported classes, provider interfaces, data
utilities, constants, and types.

### Scripts are git (since 0.9.0)

A script's **draft folder is a git working tree**: `<workspace>/<U>/<script>/draft/` holds the files and its `.git`;
`declarations/` (generated typings, outside git) stays beside it. Everything about a script's draft and snapshot goes
through the platform's git proxy by way of [`bsjsGit`](packages/bsjs-git/README.md); no draft or snapshot file is read or
written over WebDAV any more (only `declarations/` and the root `.gitignore` still are).

- **pull** clones the draft branch into `draft/`, or fetches and fast-forwards it. A local edit to a file the platform
  also changed is kept and reported (`keptLocalPaths`); files missing locally come back. A folder pulled before git (files,
  no repository) is bound to the repo as it stands: its files that its last sync record shows unedited take the platform
  copy, edited ones are kept.
- **push** commits the working tree as the author and pushes the draft branch; the platform then builds it (see below).
  A **snapshot** push also publishes the build (`publishedSha`) and reads back that the platform's `master` is at that
  commit.
- **audit** compares the working tree with the platform's draft (a folder that is not a git working copy yet is reported
  as not pulled).
- **deploy** pushes the source draft's files to each target script through a scratch clone, and the target's platform
  builds them; the source folder is never bound to a target.
- **A script that still publishes over WebDAV is switched to git, one way.** A push does it on its first write (and
  `PushResult.switchedToGit` and a warning say so); a pull asks first (`Prompt.confirm`, safe answer first, so
  auto-confirm declines and the pull returns `null`) unless `enableGit: true` is passed. After the switch the script's
  draft and snapshot refuse WebDAV writes.
- **The commit author is never invented.** It is the `author` option of `push`/`pushCurrent`/`deploy`, else `git config
user.name`/`user.email` for the draft folder (global config included), else `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`
  (then `GIT_COMMITTER_*`) from the environment, else a `GitIdentityError` before the platform is touched.
- `B6PProviders.gitFs` (default `node:fs`) is the Node-style file system git works on; it must read and write the same
  disk as the `fs` provider.

### Push results

`push` / `pushCurrent` resolve to a [`PushResult`](src/script/push.ts) (or `null` when no target was
given). Read `pushed` first: `false` means nothing was pushed.

| Field                             | Meaning                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pushed`                          | The draft is on the platform. `false` when the draft folder is missing or empty                                                                                                                                                                                                                                                |
| `commitSha`                       | The draft commit this push made, or the one already there; `null` when `pushed` is `false`                                                                                                                                                                                                                                     |
| `route`                           | Which route ran: `{ mode: "server-build" \| "push-only", reason, serverVersion, required }`, `reason` one of `dev`, `at-or-above-floor`, `below-floor`, `unknown`, `floor-unset`. `null` when the push stopped before asking                                                                                                   |
| `snapshotRefused`                 | Set when a snapshot was asked for on a server that does not build git drafts: `{ reason: "too-old" \| "unknown" \| "floor-unset", serverVersion, required }`. The draft was pushed; nothing was built or published                                                                                                             |
| `build`                           | The platform's compile of the pushed draft (`compileDraft`): `status` (`COMPILED`, `GATE_TRIPPED`, `EMIT_WITHHELD`, `NOTHING_TO_COMPILE`, `SKIPPED_EXTERNALLY_BUILT`, …, or `UNKNOWN` with `rawStatus`), `errors` / `warnings`, `diagnostics` (+ `diagnosticsOmitted`), `gate`. `null` when no build ran or the request failed |
| `buildCommitSha`                  | The platform's build commit (output, and the manifest when it vouched); the folder was moved to it unless `buildFastForward` says otherwise. `null` when it made none (already built, nothing to build)                                                                                                                        |
| `buildFastForward`                | How the folder was moved to the build: `{ state, blockedPaths, error }`, `state` `fast-forwarded`, `unchanged`, `blocked` (local files the build changes match neither side, listed; nothing was changed, nothing published) or `failed`. `null` when no build answer came                                                     |
| `buildIncomplete`                 | The build ended in a status after which the draft does not publish (`BUSY` / `INPUT_INCOMPLETE` once retries ran out, `COMPILER_UNAVAILABLE`, `NOT_PERMITTED`, `WRITE_FAILED`, `OUTPUT_UPLOAD`, `SKIPPED_GIT_MANAGED`, `GATE_TRIPPED`, `EMIT_WITHHELD`, `UNKNOWN`): `{ status, rawStatus, description }`. `null` otherwise     |
| `buildVouched`                    | `true`: the build is clean and its manifest committed, or the draft needs none (externally built, nothing to build). `false`: unclean, output committed without a manifest, so a publish is refused until it builds cleanly. `null`: no build ran                                                                              |
| `buildError` / `buildErrorKind`   | Why no build answer came after a successful push, and whether a build was `not-requested` (the platform's draft was no longer the pushed commit) or the `request-failed` (it may have run); otherwise `null`                                                                                                                   |
| `publishedSha`                    | The commit the platform published on a snapshot push (the build commit); `null` on a plain push, when nothing was published, or on a failed publish. A caller that asked for a snapshot treats `null` as a failure                                                                                                             |
| `publishError` / `publishRefusal` | Why the platform refused or failed the publish (the draft stays pushed), and the structured `{ reason, withheld }` (`BUILD_STALE`, `BUILD_MANIFEST_MISSING`, `DRAFT_MOVED`, `ENTRYPOINT_MISSING`, …)                                                                                                                           |
| `switchedToGit`                   | This push switched a WebDAV script to git, which cannot be undone                                                                                                                                                                                                                                                              |
| `typeCheckDiagnostics`            | The platform build's whole count of `ERROR` and `WARNING` diagnostics; `null` when no build ran                                                                                                                                                                                                                                |
| `typeCheckErrors`                 | Those in the script's own sources (never a `.d.ts`), as listed by the platform, which lists at most 20: `{ file, line, column, code, message, severity }`, a type-checker finding being a `WARNING`. Empty when none or no build ran                                                                                           |
| `liveVerified`                    | `true`: the platform's `master` is at `publishedSha`. `false`: it is at another commit. `null`: not proven either way                                                                                                                                                                                                          |
| `liveMismatches`                  | Draft-relative paths that differ between `publishedSha` and `master` when `liveVerified` is `false`                                                                                                                                                                                                                            |
| `keptPlatformOnly`                | Platform-only files kept because deleting them was not confirmed (they are part of the pushed commit)                                                                                                                                                                                                                          |

### How a push builds (since 1.0.0)

Nothing compiles in core or in `bsjsGit`; neither package has a runtime `typescript` dependency. The platform builds:

1. The draft is committed and pushed over git (the confirmations above).
2. `compileDraft` (GraphQL, `bsjsGit.ScriptRepo.compileDraft`) asks the platform to build the draft branch at the pushed
   commit (`expectedDraftSha`; a draft that moved meanwhile is refused, `DraftBuildMovedError`). It commits the output,
   plus the build manifest when the build is clean, as one build commit authored by the pushing user, and the folder is
   fast-forwarded to it: the working tree and index first, for exactly the paths the build changed, then the branch. A
   local file in the way (an edit, or an untracked or ignored copy matching neither side) leaves the folder as it was
   and is reported (`buildFastForward`); a later push stops on it (`GitBuildFastForwardBlockedError`, with the paths)
   until it is out of the way. A build whose answer was lost is taken in by the next push, not asked about: only a commit with the platform's
   `Bluestep-Build-Of: <pushed sha>` trailer, one parent and an output-only diff (or a chain of such rebuilds) counts. `BUSY` is retried 3 times 5 s apart, `INPUT_INCOMPLETE` 3 times 2 s apart,
   `COMPILER_UNAVAILABLE` and a failed request once. Every push builds, plain ones too.
3. A snapshot push whose build status publishes (`COMPILED`, `NOTHING_TO_COMPILE`, `SKIPPED_EXTERNALLY_BUILT`) then
   publishes the build commit and reads `master` back. An unclean build is refused by the platform's manifest check
   (`publishRefusal.reason` `BUILD_MANIFEST_MISSING` or `BUILD_STALE`); a tripped gate or withheld emit publishes
   nothing. Once the push succeeded, nothing throws: a failed build is `buildError`, a status that does not publish
   `buildIncomplete`, a failed publish `publishError`, and none of them is reported complete. A deploy counts a
   snapshot target that published nothing as failed.

Before pushing, a push asks the org's server for its version (`/appinfo/version`) and picks the route; it never refuses
a push for the version. A `dev` or `latest` server, or one at or above `MIN_SERVER_VERSION`, builds as above. Any other
(below the floor, an unreadable version, the floor unset) gets the git push alone: no build, and a snapshot push takes
no snapshot (`snapshotRefused`). `MIN_SERVER_VERSION` is `26.11.16.00`, the day the git build
(web#2022) was readied; every web release from that day on has it.

### Overwrites and destructive prompts

Before anything is pushed, a push asks **once** about every file it would overwrite that the platform changed since
this folder was last synced (git: the draft branch moved on, or, for a folder with no repo of its own, the platform copy
differs from what the sync record says this machine last had). Files only changed here never ask. Declining throws
`Err.OverwriteDeclinedError` (a `UserCancelledError`) with the files in `paths`, before anything is pushed. Confirming
pushes a merge commit, so the platform's commits stay in the history. To confirm without a prompt, pass the
draft-relative paths:

```typescript
await core.script.push({ rootPath, overwrite: ["scripts/app.ts"] });
```

A second prompt covers platform files the platform gained since the last sync that have no local copy ("delete them from
the platform?", `No` first); anything but `Yes` keeps them and reports them in `keptPlatformOnly`.

Every prompt that overwrites or deletes puts its **safe option first** and marks itself with the
optional third argument of `Prompt.confirm`:

```typescript
confirm(message: string, options: string[], opts?: ConfirmOptions): Promise<string | undefined>;
// ConfirmOptions { destructive?: boolean; safeOption?: string } — on a destructive prompt,
// safeOption === options[0]
```

So a `Prompt` that answers `options[0]` without asking (an empty answer, an auto-confirm mode)
declines. Core's messages say what was kept and why. How to confirm (a flag, a button, piped
input) is the consumer's to explain.

### Gateway

`core.gateway.client` ([`GatewayClient`](src/gateway/GatewayClient.ts)) talks to web-global's gateway
with the same `b6pt_` access token `BearerAuthProvider` already stores: it reads the stored token on
every request (never prompting) and sends it as `Authorization: Bearer <token>`. There is no session
or login on this origin. REST requests through the client run one at a time; redirects are never
followed, and a request path that resolves off the gateway's origin is refused before sending.

```typescript
await core.setConfig("gatewayUrl", "https://gateway.bluestep.net"); // the default; https only, except loopback
const list = await core.gateway.client.getJson("/api/v1/knowledge-bases", { scope: "global" });
const headers = await core.gateway.client.authHeadersFor(gitUrl); // for a git client; gateway origin only
```

Failures are typed, all extending `Err.GatewayError` (`status`, `code`):

| Error                                                                 | When                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GatewayAuthError` (`reason`)                                         | `token-missing` (none stored; thrown before sending), `token-invalid` (401), `token-malformed` (not a `b6pt_` token; nothing sent)                                                                                                                              |
| `GatewayScopeError` (`scope`)                                         | `403 scope-missing`                                                                                                                                                                                                                                             |
| `GatewayNotPermittedError`                                            | `403 not-permitted`                                                                                                                                                                                                                                             |
| `GatewayNotFoundError`                                                | `404` (also for something that exists but is not visible)                                                                                                                                                                                                       |
| `GatewayScopeEscalationError`                                         | `403 scope-escalation` (a new token asked for a scope the presenting one lacks)                                                                                                                                                                                 |
| `GatewayConflictError`                                                | `409 non-fast-forward`                                                                                                                                                                                                                                          |
| `GatewayAliasTakenError`                                              | `409 alias-taken`                                                                                                                                                                                                                                               |
| `GatewayTooLargeError`                                                | `413 too-large`                                                                                                                                                                                                                                                 |
| `GatewayUnavailableError`                                             | `502`/`503`/`504`, a network failure or a timeout                                                                                                                                                                                                               |
| `GatewayUnexpectedResponseError`                                      | any other status, a redirect (`code: "redirect-refused"`, not followed), or a 2xx body that is not JSON                                                                                                                                                         |
| `GatewayConfigError`                                                  | an unusable `gatewayUrl`, or a URL or request path that resolves off the gateway's origin                                                                                                                                                                       |
| `GatewayDirtyWorkingTreeError` (`paths`)                              | a pull would overwrite local changes (git layer)                                                                                                                                                                                                                |
| `GatewayCloneMismatchError` (`reason`, `dir`, `repo`)                 | a marketplace pull found a clone it must not update: `different-repo`, `different-ref`, `tag-moved` (the tag now names another commit) or `tag-gone` (the gateway no longer has it)                                                                             |
| `GatewayKnowledgeBaseError` (`reason`, `ref`, `candidates`)           | a knowledge base address is `bad-ref`, `not-found`, `ambiguous`, `unsafe-name`, `wrong-branch` (a pull or push from a clone that is detached, off the live branch, or not tracking it; fields `branch`, `liveBranch`, `upstream`), or a clone is `not-a-kb`     |
| `GatewayPreconditionFailedError` / `GatewayPreconditionRequiredError` | a knowledge-base change whose `If-Match` is stale (`412`) or missing (`428`)                                                                                                                                                                                    |
| `GatewayAccessRefusedError`                                           | `400` on a create or change that named `access` (a `GatewayInvalidRequestError`)                                                                                                                                                                                |
| `GatewayKnowledgeBasePushNotPermittedError` (`ref`)                   | a push to a KB whose listing says `canPush: false` (a `GatewayNotPermittedError`)                                                                                                                                                                               |
| `GatewayInvalidArgumentError`                                         | refused before sending: an empty alias or scope list, an expiry that is not a date, a pasted `b6pt_` secret where an id or alias belongs (token operations), or a relative path with no absolute `cwd` to resolve it against (core never reads `process.cwd()`) |
| `GatewayWorkingCopyError` (`reason`)                                  | the local folder cannot be used: `not-empty`, `not-a-clone`, `detached`, `no-upstream`, `diverged`, `ref-not-found`, `unsafe-target` (git layer), `wrong-repository` (knowledge-base pull)                                                                      |

`core.gateway.client.sequence((seq) => …)` runs a unit as one queue entry: nothing else on the
client runs until it settles. `seq.token()` reads the token once, and `seq.request` presents that
read. The git layer holds the queue for a whole operation with it, and token rotation uses it so
nothing runs between the revoke and the store.

`gatewayErrorFor(status, body, what)` applies the same mapping to a status seen elsewhere (the git
layer). The token never appears in a message or a log line, including when the server echoes it.

#### Git

`core.gateway.git` ([`GatewayGit`](src/gateway/GatewayGit.ts)) clones and updates the repositories behind
a knowledge base or marketplace listing, in pure JS ([isomorphic-git](https://isomorphic-git.org), MIT;
no git install needed) over the gateway's smart HTTP endpoints. It takes the `gitUrl` from a listing
and never builds one; a URL off the gateway's origin is refused before any request, and a redirect is
not followed (`redirect-refused`). The folders are real local paths, read and written through Node's `fs`, and file
contents are never rewritten (no autocrlf).

```typescript
await core.gateway.git.clone(kb.gitUrl, dir, { ref: "master" }); // dir missing or empty
const status = await core.gateway.git.status(dir, { fetch: true }); // branch, dirty, ahead, behind
await core.gateway.git.pull(dir); // fetch + fast-forward only
await core.gateway.git.push(dir); // current branch to its upstream, fast-forward only
await core.gateway.git.inspect(dir, "v1"); // origin url, branch, head, upstream, local tag commit (typed `not-a-clone` if damaged)
await core.gateway.git.remoteTagCommit(kb.gitUrl, "v1"); // the commit a tag names on the gateway now, or null
```

- `pull` never merges or rebases. A clean tree just proceeds, and unstaged edits and untracked files
  on paths the incoming commits do not touch are kept. Anything staged refuses the pull (the checkout
  would drop it), naming the paths. A pull interrupted after its checkout is finished on the next call. If they do touch them, it throws `GatewayDirtyWorkingTreeError` with the
  `paths` and changes nothing. If both sides have moved on it throws `GatewayWorkingCopyError`
  (`diverged`).
- `push` is never forced, never deletes a ref and never sends tags. An upstream that has moved on
  (found locally, or reported by the gateway as `409`) is `GatewayConflictError`; a token without
  `kb:push` is `GatewayScopeError`.
- Gateway failures map through `gatewayErrorFor`, as for REST. Operations share the client's
  one-at-a-time queue.

#### Access tokens

`core.gateway.tokens` ([`GatewayTokenService`](src/gateway/GatewayTokenService.ts)) manages the
caller's **own** tokens. Every call needs the `tokens:self` scope on the stored token
(`GatewayScopeError` with `scope: "tokens:self"` otherwise); nothing addresses another user.

```typescript
const tokens = await core.gateway.tokens.list(); // [{ id, alias, scopes, createdAt (null for old tokens), expiresAt, lastUsedAt (approximate), current, neverExpires, expired }] - expired tokens are listed too
const minted = await core.gateway.tokens.create({ alias: "ci", scopes: ["kb:read"] }); // 90 days by default
minted.expiryCapped; // null, or { cappedTo, requested: "90d" } when the 90-day default was cut to the stored token's own expiry
minted.token; // the b6pt_ secret, shown this once; expiresAt: null mints one that never expires (neverExpires: true)
await core.gateway.tokens.revoke("ci"); // id or alias → { id, alias, revokedCurrent }
await core.gateway.tokens.rotate("laptop"); // → { replaced, token, rotatedCurrent }
```

- An id or alias is trimmed and resolved through `list()` first: no match is `GatewayNotFoundError`,
  a value that is one token's id and another's alias is `GatewayTokenAmbiguousError`, and a value
  containing `b6pt_` anywhere (a pasted secret) is refused (`GatewayInvalidArgumentError`) without
  being sent. Nothing is revoked or rotated in any of these cases, and no message quotes the value.
- `create` refuses an empty or whitespace alias, an empty scope list or an expiry that is not a
  strict ISO 8601 date-time with a time zone (`2027-02-01T00:00:00Z`, `…+05:30`; a plain date,
  `March 7` or `1` is refused) before sending (`GatewayInvalidArgumentError`). A new token's scopes must be a subset of the
  stored token's.
- **Expiry.** The gateway caps a new token's expiry at the presenting token's. With no `expiresAt`,
  `create` sends none and the gateway mints for the sooner of 90 days and the stored token's expiry;
  `expiryCapped` (`{ cappedTo, requested: "90d" }`, `cappedTo` = the returned `expiresAt`) is set only
  when that cut more than 24 hours off the 90 days. An explicit expiry, or `null`, is sent as given. A
  `403 not-permitted` on a mint or rotate is typed by the body's `reason`:
  `expiry-exceeds-presenting` (with `presentingExpiresAt`) is `GatewayTokenExpiryRefusedError`,
  `restricted-mints-disabled` is `GatewayRestrictedMintsDisabledError`, `rewrite-not-permitted` (with
  `scope: "kb:rewrite"`) is `GatewayRewriteNotPermittedError`, and any other or missing
  reason stays `GatewayNotPermittedError` (`reason` says what arrived). Other mint failures:
  `GatewayTokenLimitError` (`409 token-limit`, `limit`), `GatewayInvalidRequestError` (`400`). Scopes
  (including `kb:rewrite`) are not checked client-side.
- **Rotating the stored token** (`current`) stores the replacement in its place: there is still one
  stored token. If storing fails after the gateway has rotated (so the old token is already
  revoked), `rotate` throws `GatewayTokenStoreError`, whose non-enumerable `replacement` property
  carries the new token, secret included, so it can be shown and the user is not locked out. The
  store also refuses, the same way, when the stored token is no longer the one that was rotated
  (an in-process compare-then-write, not atomic across processes). The list, the rotate and the
  store run as one entry in the client's queue with one read of the stored token, so a request
  queued behind a rotation presents the replacement, never the revoked token.
- **A minted secret that reaches core is never dropped.** When a create or rotate answer carries
  the secret but is otherwise off-contract, the call throws `GatewayOffContractTokenError`, whose
  non-enumerable `secret` holds it; for a rotation of the stored token it is still offered to the
  store, and `stored` says whether that worked. The store reads the token back after writing, so
  another writer's overwrite (for example a second b6p process) is `GatewayTokenStoreError`, not
  success.
- **An answer that never arrives** (a dropped connection, a timeout, or `502`/`503`/`504` on the
  create or rotate request) is `GatewayOutcomeUnknownError` (a `GatewayUnavailableError`,
  `operation` `create` or `rotate`): the token may have been minted or rotated, and for a rotation
  the old one may already be revoked. Any new secret is lost; the error says the outcome is unknown.
- **Rotation is retried once.** `rotate` sends an `Idempotency-Key` (a fresh UUID per call). When the
  rotate request goes unanswered, it is retried once with the same key and presenting token, and the
  gateway answers the retry with the first attempt's result without rotating again; a successful
  retry is the normal path. `GatewayOutcomeUnknownError` (`retried: true`) follows only when the
  retry is unanswered too, or is refused `401`/`404` while rotating the stored token (the first
  attempt most likely rotated and so revoked it); the store is then left untouched. A create is
  never retried. A rotated token keeps its absolute end date; an expired one cannot be rotated
  (`GatewayInvalidRequestError`).
- **Revoking the stored token** is allowed. The result says `revokedCurrent: true` and the stored
  (now dead) token is left in place; what to do next is the consumer's call.
- Core never logs a secret or puts one in an error message. Warning about a token that never
  expires is the consumer's job; results carry `neverExpires`.

#### Marketplace

`core.gateway.marketplace` ([`GatewayMarketplace`](src/gateway/GatewayMarketplace.ts)) lists the
marketplace repos (name, description, default branch, tags, `gitUrl`; the body is validated) and
pulls a plain working clone of one. It is unrelated to any script's sources or pins, and there is
no push (the gateway refuses it for the marketplace).

```typescript
const repos = await core.gateway.marketplace.list();
const repo = await core.gateway.marketplace.get("core"); // GatewayNotFoundError if absent
await core.gateway.marketplace.pull("core", { cwd }); // <cwd>/core at the default branch
await core.gateway.marketplace.pull("core", { cwd, dir, ref: "v1.1.0" }); // a tag (detached head) or branch
```

`cwd` is the consumer's own working directory (core never reads `process.cwd()`); `dir` is relative to it.
`list` leaves out a malformed entry rather than failing for every repo (`get` of that name is
`GatewayUnexpectedResponseError`), and a name is checked as a folder name only when `dir` is omitted.
`ref` may be a short name or `refs/heads/x` / `refs/tags/x` (normalised to `x`). A folder name from the listing must be a plain segment: no leading dot (so never `.git`), `git~N`, control or reserved characters, or Windows device names (`CON`, `CONIN$`, `COM0`..., also `CON .txt`), and no Unicode control, format or invisible characters (those make the whole listing entry malformed, in any text field). `cwd` must be absolute and is required unless `dir` is absolute: a relative folder without it is `GatewayConfigError`.
`pull` clones into a missing or empty folder. A folder that already holds a clone of the same
`gitUrl` on a branch is fast-forwarded (`action`: `fast-forwarded`, `up-to-date` or `ahead`); a tag
checkout is `up-to-date` when the gateway's tag still points at the checked-out commit, else
`GatewayCloneMismatchError` (`tag-moved`, or `tag-gone` when the gateway no longer has the tag). A clone of another repo, or on another ref than asked for, is
`GatewayCloneMismatchError` (`reason`: `different-repo` / `different-ref` / `tag-moved` / `tag-gone`, plus `dir` and `repo`) and is
left untouched; local changes the incoming commits would overwrite are `GatewayDirtyWorkingTreeError`;
a folder with files but no clone is `GatewayWorkingCopyError` (`not-empty`).

#### Knowledge bases

`core.gateway.kb` ([`GatewayKb`](src/gateway/GatewayKb.ts)) lists the knowledge bases the token's user
may read, global and tenant, and pulls and pushes them over `core.gateway.git`. A KB is addressed as
`<name>` (global) or `<U…>/<name>` (tenant); the listing's own `global/<name>` and
`tenant/<U…>/<name>` forms work too.

```typescript
const kbs = await core.gateway.kb.list({ scope: "tenant", tenant: "U142133" }); // ref, scope, tenant, name, title, liveBranch, canPush, gitUrl
const kb = await core.gateway.kb.resolve("onboarding");
const pulled = await core.gateway.kb.pull("U142133/handbook", { cwd: process.cwd() }); // clones into <cwd>/U142133-handbook
const pushed = await core.gateway.kb.push(pulled.dir); // { pushed, commit, ref }; a relative dir needs { cwd }
```

- `list` checks the body's shape and throws `GatewayUnexpectedResponseError` for a bad one.
- `resolve` throws `GatewayKnowledgeBaseError` (`reason`: `bad-ref`, `not-found`, `ambiguous` with
  `candidates`).
- `pull` clones the live branch into a missing or empty folder (`dir`, relative to the `cwd` you pass;
  default `<name>`, or `<tenant>-<name>`), and fast-forwards an existing clone of the same repository.
  An existing clone that is not on the KB's live branch, does not track it, or is detached is refused before any fetch with `GatewayKnowledgeBaseError` (`wrong-branch`, `branch`, `liveBranch`). A clone of a different repository is `GatewayWorkingCopyError` (`wrong-repository`); incoming commits
  that touch locally changed files are `GatewayDirtyWorkingTreeError` (`paths`). It never prompts and
  has no way to discard local changes.
- `push` finds the KB from the clone's remote in a fresh listing and refuses a KB with
  `canPush: false` before sending anything, with `GatewayKnowledgeBasePushNotPermittedError` (`ref`).
  A clone not on the KB's live branch, not tracking it, or detached is refused the same way with `GatewayKnowledgeBaseError` (`wrong-branch`, `branch`, `liveBranch`). A gateway branch that moved on is `GatewayConflictError`.

**Managing global knowledge bases** (scopes: `create` and `update` need `kb:manage`; `detail` and `read` need `kb:read`, as the gateway's content read does for a private knowledge base). Nothing here prompts:
the consumer confirms, and words the confirmation from the `kb` that `read` returns (its `name`, `access`).

```typescript
const made = await core.gateway.kb.create({ name: "docs", title: "Docs", access: { kind: "public" } }); // access, title, liveBranch optional
const { kb, etag } = await core.gateway.kb.read("docs"); // name -> id, then GET /{id}; kb.id, kb.name, kb.access
const changed = await core.gateway.kb.update(kb.id, etag, { title: "Docs", access: { kind: "private" } }); // ONE PATCH with If-Match
```

- `create` (`POST`) sends only the fields given, so the gateway's defaults apply (title = name, live branch
  `main`, private). `detail(id)` (`GET /{id}`) returns `{ kb, etag }`; `update(id, etag, changes)` (`PATCH`)
  sends every given field in one request with `If-Match: etag`, and `access` only when given.
- `access` is `{ kind: "public" } | { kind: "private" } | { kind: "unknown", rawKind, raw }`, matched exactly
  (`"Public"` is unknown). An `unknown` access (a kind newer than this core) must be treated as private; it is
  never sent back: `create`/`update` refuse it, and any access with a key beyond `kind` (a permission object, say), with `GatewayInvalidArgumentError` before sending. `detail`, `update` and `read` also refuse an id or ref that contains `b6pt_` (taken for a pasted token) before any request or message. `access` is
  absent from a detail or listing entry when the gateway did not report one. Making a knowledge base public
  makes every commit reachable from its live branch, files since deleted included, readable by anyone.
- Errors: `412` is `GatewayPreconditionFailedError` (changed since read; read again), `428`
  `GatewayPreconditionRequiredError`, a missing scope is `GatewayScopeError` (`scope`: `kb:manage` for a write, `kb:read` for a read), a `400` on a request
  that named `access` is `GatewayAccessRefusedError` (an older gateway; a `GatewayInvalidRequestError`), a taken
  name is `GatewayConflictError` (`code` `name-taken`).
- `client.requestDetailed(method, path, options)` is `request` plus the status and the `ETag` header.

For specs, [`FakeGateway`](src/testing/FakeGateway.ts) is an in-process gateway on `127.0.0.1` that
answers the contract's REST routes (the token routes included) and error codes, with `grantToken`
(scopes, plus optional id, alias, owner and expiry; an expired token is `401 token-invalid`),
`issuedTokens`, `issuedSecrets` (every secret ever accepted, revoked ones included, for leak
checks), `failNext` and `route` (for mounting git smart-HTTP handlers).

### git's credential helper

`core.gitCredential` ([`GitCredentialService`](src/gitCredential/GitCredentialService.ts)) lets plain `git` in a
knowledge-base clone (the gateway) or a script's `draft/` folder (a tenant's git proxy) use the stored `b6pt_`
token without asking, the way `gh auth setup-git` does for github.com. Both git proxies take the token as the Basic
password, so git needs nothing else: no CSRF token and no session.

Plain `git pull` and `git push` then work in knowledge bases and in script drafts. A plain push in a draft lands the
commit on the platform's draft branch but does not build or publish it: the platform's build and a snapshot publish
still take `core.script.push` (the CLI's `b6p script push` or publish), which is unchanged.

```ts
// git runs `<helper> get|store|erase` with the request on stdin; the consumer passes it through:
process.stdout.write(await core.gitCredential.answer(action, stdinText)); // then exit 0

await core.gitCredential.allowedHosts(); // [{ host: "gateway.bluestep.net", source: "gateway" }, { host, source: "script-pull" }]
await core.gitCredential.setupStatus({ cwd }); // { hosts: [{ host, source, configured, alsoAsked, others }], configured, otherHelpers, scope }
await core.gitCredential.cloneStatus(cloneDir); // that clone's remote host, read with the clone's own config; null off the list
await core.gitCredential.setupGit(); // per allowed host: credential.https://<host>.helper = "" then = !b6p auth git-credential; also keptResets
await core.gitCredential.removeGit(); // { removed, keptResets: [{ url, file, reason }] }: takes those entries out again
```

- **What it answers for.** `get` answers `username=b6p` and `password=<token>` only for `protocol=https` and a host
  exactly on the allowlist (`host[:port]`, the port only when not 443): the configured gateway's host when it is https,
  and every tenant host a `core.script.pull` reached through its git proxy with the token
  ([`GitCredentialHosts`](src/cache/GitCredentialHosts.ts), recorded after the git half of the pull succeeds). No host
  rule such as `*.bluestep.net` is assumed. A lookalike host, another port, http, a request naming another username
  or carrying a `url=` (git never sends one to a helper) gets an empty answer, so git asks its other helpers.
- **`store` and `erase` do nothing.** The token enters only through the consumer's sign-in. git sends `erase` after
  any 401, and one tenant refusing the token (or an outage answered with a 401) must not sign b6p out everywhere.
- **git 2.27 or later; 2.42 or later for setup.** Status, `cloneStatus` and removal refuse an older git
  (`git --version`), because the partial-URL fallback their matching follows arrived in git 2.27.0 (git 2.26 ignores
  a pattern such as `https://`, so the same config means something else there). Setup also needs
  `git var GIT_CONFIG_GLOBAL` (git 2.42.0). Both fail as `Err.GitCredentialSetupError`.
- **Setup resets, like gh.** For each allowed host it appends a new `[credential "https://<host>"]` section holding
  an empty `helper =` (git's reset, so no earlier helper such as `store` or `cache` answers that host or is told to
  keep the token) and then `helper =` b6p's command, to the file git itself reports `git config --global` writes
  (`git var GIT_CONFIG_GLOBAL`, chosen by git's own rule; never worked out from `HOME` or `USERPROFILE`, which Git
  for Windows does not always use; a relative `GIT_CONFIG_GLOBAL` is resolved against the process's directory, once,
  for every read, edit and record). The pair is written in one edit under git's own lock on that file
  (`<file>.lock`, created exclusively and owner-only, set to the file's mode as read under the lock, and renamed over
  the file, as every git writer does; a
  symlink is followed to its target, even a missing one, as git's `resolve_symlink` does, so it stays a link). The
  file never holds one line without the other, and no other git writer's change lands in between. The file is edited
  as bytes, so a value that is not UTF-8 is kept exactly; a last value continued with a trailing `\` is ended with an
  empty line first; and setup refuses an edit that would change any entry git already reads there. A host already
  set up in the system and global config is left alone, so a second run changes nothing; otherwise b6p's own entries
  and pair for it are taken out first, so neither line is ever doubled. A tenant recorded later needs another run.
- **Status follows git's credential contexts exactly.** `setupStatus()` works out, per host, every entry git 2.53
  applies to it (`credentialContextMatch`, from git's `credential.c` and `urlmatch.c`): every matching entry in config
  order, resets included, not only the most specific. A pattern git can normalize matches by scheme and host
  case-insensitively, a whole `*` label matching any one label, by port with leading zeros dropped and `:443` the same
  as none, by the user when it names one, and by path prefix (escapes normalized, dot segments resolved). Any other
  pattern (no scheme, a `%` in the host, port 0, `https://` with no host at all, or an empty subsection,
  `[credential ""]`) is matched as git's partial-URL fallback does: only the parts it names, percent-decoded, compared
  exactly, so `https://` and `""` apply to every https request. A pattern naming any user (`https://alice@<host>`)
  is `maybe` for its host: a remote URL naming that user brings its helper in, and one that answers `username=b6p`
  makes git ask b6p next, which answers, and git then hands the token to that helper on `store`. Each entry is
  `yes` (every request b6p answers for the host), `no` or `maybe` (only some: a path, the `b6p` user, a partial
  pattern's host spelling). In doubt, another helper counts as asked, and a reset or b6p's own entry as not applying
  when it would hide one, so `configured` is true only when git certainly asks b6p alone; setup repairs any host
  that is not. `alsoAsked` lists the other helpers and `others` the config entries responsible (key, value, file,
  `null` for the command line). Setup never moves or deletes the user's entries, so the consumer tells the user to
  move such an entry before b6p's section or remove it. `otherHelpers` lists the generic helpers.
- **Which config status reads.** The config in effect where it runs (`{ cwd }`, default the process's directory):
  system, `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, the command line and `GIT_CONFIG_COUNT`, and inside a
  repository its local and worktree config, with every file they `[include]` (`git config --includes --show-scope
  --show-origin`). `scope` says which: `"global"` outside any repository, `"global+here"` inside one. **No status
  covers another repository's own config**: a helper set in some other clone's `.git/config`, or in a file an
  `includeIf` reads only there, is seen only from that clone. So an `includeIf` after b6p's pair counts as a helper
  that may be asked (`configured: false`, the entry in `others`), and setup repairs it by appending the pair after it.
  `cloneStatus(dir, { remote })` answers for one clone: the host of its remote (`origin` by default), read with that
  clone's config, or `null` when the remote's host is not an allowed one; the remote's URL is never in the result.
  A consumer calls it after a knowledge-base or script pull to warn that git there would ask another helper too.
  Setup and removal change only the global files.
- **b6p removes only pairs that are certainly its own.** Each pair setup writes is recorded in public state
  `b6p:git_credential_resets` as `{ "<file>": { "<exact key>": { state, helper, pairsBefore? } } }`, `adding` (with how
  many reset-then-helper pairs the key had in the file, counted as git sees them) before the edit and `installed`
  after; a run that stopped in between is settled from the file: the count it had means not written, one more means
  written, anything else `unconfirmed`. A pair stays b6p's only while its helper directly follows an empty value of
  that key in that file; if the user took b6p's helper out, b6p drops its claim and deletes nothing. Removal re-reads
  the file under git's lock and removes b6p's pair, both lines in that one edit (and the section header when nothing
  else is left under it), only when the file holds exactly one such pair, each on its own line: a reset anyone else
  wrote (one a moment ago included) is never touched. With several pairs under the key, only b6p's helper lines go,
  the resets stay inert, and the key is reported in `keptResets` (`reason: "shared-key"`); one pair sharing a line
  with other text, and an `unconfirmed` claim, are reported as `unconfirmed`, each once. Then every other entry whose
  value is b6p's command, in any spelling of the URL, is removed from the global file it came from. So an
  interruption at any point leaves either b6p's whole pair or an inert reset, never b6p's helper on its own. File
  paths are compared as git reports them (on Windows, either slash and any case). The record survives
  `clearSettings()` and `clearAll()`, which keep it in the same write that clears the rest of public state
  (`Persistence.clearPublicExcept`), because the entries it describes stay in the git config until a removal takes
  them out; every read of the record takes its lock.
- **Locks.** One lock guards the whole of `SharedFilePersistence`'s state file (`state.json.lock`): every write
  re-reads the file under it and changes only its own key, so no process's setting, cache entry or record is lost to
  another's. Each record or forget of a tenant host, and each reset record, is also one read-modify-write under
  `Persistence.withLock`, and each setup or removal holds one git config lock (`b6p:git_credential_config`) from
  reading the config to settling the last record, so two never interleave, in one process or several. A lockfile
  (`withFileLock`) works as git's `<file>.lock` does: created exclusively, its stamp (process id, host name, a
  token) written through the same handle at once, held for as long as the work runs, and **never removed by another
  process**, whatever its age or holder. Release removes it only while it holds this acquisition's token, retrying a
  transient `EPERM`/`EBUSY`/`EACCES`; a release still refused stays pending, and this process (only this one) removes
  that lock on its next acquisition of it and on exit. As git's tempfile.c does, b6p removes the locks it holds, and
  git's `<config>.lock` while it is editing a config file (only while it is still the file it created), when the
  process exits, gets SIGINT, SIGTERM or SIGHUP while no handler of the host's is listening (then stopping with that
  signal; a host handler decides instead, and if it exits the locks go with the exit), or dies of an uncaught
  exception. A lock is tracked from the moment it is created, so only a hard kill (SIGKILL, power loss) can leave an
  empty one. A deleted `~/.b6p` is created again. After 10 s a waiter gives up with an error naming the
  lockfile and its holder (or saying the lock is empty): "If no b6p or VS Code process is running, delete <path>." A pull whose host cannot be recorded still succeeds.
- The helper command defaults to `GitCredential.DEFAULT_HELPER`; pass `{ helper }` to write another.
- The token never reaches git's argv, a config file, a log line or an error message. Failures of `git config`, and
  of a config file edit, are `Err.GitCredentialSetupError` (`exitCode`).

## Development

```bash
npm install
npm run check-types   # tsc --noEmit
npm run compile       # tsc → dist/
npm run watch         # tsc --watch
npm run format        # prettier --write
npm run format-check  # prettier --check — the style gate in CI
npm test              # compile, then every spec listed in package.json's `test` script
npm run clean         # rm -rf dist
```

`npm run compile` emits `dist/` (JavaScript + `.d.ts` declarations), which is what gets published.

## License

MIT
