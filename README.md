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

`gatewayErrorFor(status, body, what)` applies the same mapping to a status seen elsewhere (the git
layer). The token never appears in a message or a log line, including when the server echoes it.

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
