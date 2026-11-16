# @bluestep-systems/b6p-core

The core library for **B6P** — BlueStep script management (push / pull / audit / deploy of JavaScript &
TypeScript "formula" scripts, through git).

This package contains the headless orchestration logic shared by the
[`b6p` CLI](https://github.com/Bluestep-Systems/b6p-cli) and the
[VS Code extension](https://github.com/Bluestep-Systems/vscode-extension). It's **platform-agnostic** — it runs
anywhere Node does. You supply the platform adapters (file system, prompts, logging, progress,
persistence) through provider interfaces.

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
  fs,          // FileSystem  — read/write/list files
  persistence, // Persistence — durable key/value (settings, sessions)
  prompt,      // Prompt      — ask the user for input/credentials
  logger,      // Logger      — diagnostic logging
  progress,    // Progress    — long-running task reporting
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

| Method | Purpose |
| --- | --- |
| `push` / `pushCurrent` | Commit and push the draft folder (optionally publish it as a snapshot) |
| `pull` / `pullCurrent` | Clone or fast-forward the draft into a workspace |
| `audit` / `auditPull` | Compare local vs. server; optionally pull differences |
| `deploy` | Multi-target deploy driven by a config file |
| `getSetupUrl` | Resolve a pulled script's web-UI setup page |
| `deriveWorkspacePath` | Recover the workspace folder from a path inside a script root |
| `getFactory` | The `ScriptFactory` for entering the script tree from a bare path |

`core.gateway` ([`GatewayService`](src/gateway/GatewayService.ts)) — web-global's gateway
(`https://gateway.bluestep.net`), the origin for knowledge bases and marketplace repos. Today it
holds the HTTP client the knowledge-base and marketplace operations are built on; see
[Gateway](#gateway) below.

`core` itself — cross-cutting state that is not specific to any one subsystem:

| Method | Purpose |
| --- | --- |
| `report` | Report cached metadata / org-cache state |
| `updateCredentials` / `clearSessions` / `clearSettings` / `clearAll` | Auth & state management |
| `getConfig` / `setConfig` | Configuration helpers |
| `checkForUpdates` | GitHub-releases-based update check |
| `dispose` | Release the session cleanup timer and org-cache resources |

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
- **push** commits the working tree as the author and pushes the draft branch. A **snapshot** push compiles first, then
  also publishes (`publishedSha`) and reads back that the platform's `master` is at that commit.
- **audit** compares the working tree with the platform's draft (a folder that is not a git working copy yet is reported
  as not pulled).
- **deploy** pushes the source draft's files to each target script through a scratch clone, and never binds the source
  folder to a target.
- **A script that still publishes over WebDAV is switched to git, one way.** A push does it on its first write (and
  `PushResult.switchedToGit` and a warning say so); a pull asks first (`Prompt.confirm`, safe answer first, so
  auto-confirm declines and the pull returns `null`) unless `enableGit: true` is passed. After the switch the script's
  draft and snapshot refuse WebDAV writes.
- **The commit author is never invented.** It is the `author` option of `push`/`pushCurrent`/`deploy`, else `git config
  user.name`/`user.email` for the draft folder (global config included), else `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`
  (then `GIT_COMMITTER_*`) from the environment, else a `GitIdentityError` before the compile and before the platform is
  touched.
- `B6PProviders.gitFs` (default `node:fs`) is the Node-style file system git works on; it must read and write the same
  disk as the `fs` provider.

### Push results

`push` / `pushCurrent` resolve to a [`PushResult`](src/script/push.ts) (or `null` when no target was
given). Read `pushed` first: `false` means nothing was pushed.

| Field | Meaning |
| --- | --- |
| `pushed` | The draft is on the platform. `false` when the draft folder is missing or empty, or a snapshot's compiled `scripts/app.js` is missing or has no code (only comments and empty-module lines, as from a blank or types-only `app.ts`) |
| `commitSha` | The draft branch's head on the platform after the push (the commit this push made, or the one already there); `null` when `pushed` is `false` |
| `publishedSha` | The commit the platform published, on a snapshot push; `null` on a plain push, an aborted one, or a failed publish. A caller that asked for a snapshot treats `null` as a failure |
| `publishError` | Why the platform refused or failed the publish (the draft stays pushed); otherwise `null` |
| `switchedToGit` | This push switched a WebDAV script to git, which cannot be undone |
| `typeCheckDiagnostics` | Snapshot type-check: `0` clean, `> 0` published with diagnostics, `null` no check ran |
| `liveVerified` | `true`: the platform's `master` is at `publishedSha`. `false`: it is at another commit. `null`: not proven either way (a plain push, an early stop, a failed publish, or `master` could not be fetched) |
| `liveMismatches` | Draft-relative paths that differ between `publishedSha` and `master` when `liveVerified` is `false` (empty when they can't be listed) |
| `keptPlatformOnly` | Platform-only files kept because deleting them was not confirmed (they are part of the pushed commit) |

`historyRecorded` is gone: the git history is the history.

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

| Error | When |
| --- | --- |
| `GatewayAuthError` (`reason`) | `token-missing` (none stored; thrown before sending), `token-invalid` (401), `token-malformed` (not a `b6pt_` token; nothing sent) |
| `GatewayScopeError` (`scope`) | `403 scope-missing` |
| `GatewayNotPermittedError` | `403 not-permitted` |
| `GatewayNotFoundError` | `404` (also for something that exists but is not visible) |
| `GatewayConflictError` | `409 non-fast-forward` |
| `GatewayTooLargeError` | `413 too-large` |
| `GatewayUnavailableError` | `502`/`503`/`504`, a network failure or a timeout |
| `GatewayUnexpectedResponseError` | any other status, a redirect (`code: "redirect-refused"`, not followed), or a 2xx body that is not JSON |
| `GatewayConfigError` | an unusable `gatewayUrl`, or a URL or request path that resolves off the gateway's origin |
| `GatewayDirtyWorkingTreeError` (`paths`) | a pull would overwrite local changes (git layer) |
| `GatewayCloneMismatchError` (`reason`, `dir`, `repo`) | a marketplace pull found a clone it must not update: `different-repo`, `different-ref`, `tag-moved` (the tag now names another commit) or `tag-gone` (the gateway no longer has it) |
| `GatewayWorkingCopyError` (`reason`) | the local folder cannot be used: `not-empty`, `not-a-clone`, `detached`, `no-upstream`, `diverged`, `ref-not-found`, `unsafe-target` (git layer) |

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

For specs, [`FakeGateway`](src/testing/FakeGateway.ts) is an in-process gateway on `127.0.0.1` that
answers the contract's REST routes and error codes, with `grantToken`, `failNext` and `route` (for
mounting git smart-HTTP handlers).

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
