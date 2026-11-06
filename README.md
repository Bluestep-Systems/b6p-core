# @bluestep-systems/b6p-core

The core library for **B6P** — BlueStep script management (push / pull / audit / deploy of JavaScript &
TypeScript "formula" scripts over WebDAV).

This package contains the headless orchestration logic shared by the
[`b6p` CLI](https://github.com/Bluestep-Systems/b6p-cli) and the
[VS Code extension](https://github.com/Bluestep-Systems/vscode-extension). It's **platform-agnostic** — it runs
anywhere Node does. You supply the platform adapters (file system, prompts, logging, progress,
persistence) through provider interfaces.

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

await core.script.pull({ formulaUrl: "https://org.bluestep.net/files/<id>/draft/", workspacePath });
await core.script.push({ rootPath, snapshot: true, message: "Update script" });
const audit = await core.script.audit({ filePath, workspacePath });
```

### Command surface

`B6PCore` is a composition root, not a flat command bag. It owns the platform-facing singletons —
`auth`, `sessionManager`, `orgCache`, `scriptMetadataStore` — and exposes each area of
functionality as its own service. Script management is `core.script`; further subsystems are added
beside it rather than onto `B6PCore` itself.

`core.script` ([`ScriptService`](src/script/ScriptService.ts)) — everything that moves a script tree
between the local filesystem and the platform over WebDAV:

| Method | Purpose |
| --- | --- |
| `push` / `pushCurrent` | Upload local script files to the platform (optional versioned snapshot) |
| `pull` / `pullCurrent` | Download script files from a formula URL into a workspace |
| `audit` / `auditPull` | Compare local vs. server; optionally pull differences |
| `deploy` | Multi-target deploy driven by a config file |
| `getSetupUrl` | Resolve a pulled script's web-UI setup page |
| `deriveWorkspacePath` | Recover the workspace folder from a path inside a script root |
| `getFactory` | The `ScriptFactory` for entering the script tree from a bare path |

`core.gateway` ([`GatewayService`](src/gateway/GatewayService.ts)) — web-global's gateway
(`https://gateway.bluestep.net`), the origin for knowledge bases and marketplace repos. It
holds the HTTP client, the git layer and `core.gateway.kb` (knowledge bases); see
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

### Push results

`push` / `pushCurrent` resolve to a [`PushResult`](src/script/push.ts) (or `null` when no target was
given). Read `pushed` first: `false` means nothing was uploaded.

| Field | Meaning |
| --- | --- |
| `pushed` | The upload ran. `false` when the draft folder is missing or empty, or a snapshot's compiled `scripts/app.js` is missing or has no code (only comments and empty-module lines, as from a blank or types-only `app.ts`) |
| `historyRecorded` | A snapshot's history entry was recorded. `false` also when the push stopped early |
| `typeCheckDiagnostics` | Snapshot type-check: `0` clean, `> 0` published with diagnostics, `null` no check ran |
| `liveVerified` | `true`: every `snapshot/` copy the push wrote reads back identical (by ETag). `false`: one is still different, missing or unreadable after one re-send, and the push stops before cleanup and history. `null`: not proven either way (a plain push, an early stop, or a copy served without a content hash, named in a warning) |
| `liveMismatches` | Draft-relative paths whose live copy was still different, missing or unreadable after one re-send |
| `keptPlatformOnly` | Platform-only files kept because deleting them was not confirmed |

A snapshot push checks the compiled entrypoint before uploading, fails on a refused `snapshot/`
write, re-uploads a file whose `snapshot/` copy is stale even when `draft/` matches, and reads the
live copies back afterwards.

### Overwrites and destructive prompts

Before uploading, a push asks **once** about every file whose upload would overwrite a platform
version nobody here has seen: the platform has a `draft/` copy that differs from local and from the
last push or pull here, or that was never synced here. New files and files already in sync never
ask. Declining throws `Err.OverwriteDeclinedError` (a `UserCancelledError`) with the files in
`paths`, before anything is written. To confirm without a prompt, pass their draft-relative paths:

```typescript
await core.script.push({ rootPath, overwrite: ["scripts/app.ts"] });
```

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
or login on this origin. Requests run one at a time.

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
| `GatewayUnexpectedResponseError` | any other status, or a 2xx body that is not JSON |
| `GatewayConfigError` | an unusable `gatewayUrl`, or a URL off the gateway's origin |
| `GatewayDirtyWorkingTreeError` (`paths`) | a pull would overwrite local changes (git layer) |
| `GatewayKnowledgeBaseError` (`reason`, `ref`, `candidates`) | a knowledge base address is `bad-ref`, `not-found`, `ambiguous`, `unsafe-name`, or a clone is `not-a-kb` |
| `GatewayKnowledgeBasePushNotPermittedError` (`ref`) | a push to a KB whose listing says `canPush: false` (a `GatewayNotPermittedError`) |
| `GatewayWorkingCopyError` (`reason`) | the local folder cannot be used: `not-empty`, `not-a-clone`, `detached`, `no-upstream`, `diverged`, `ref-not-found`, `wrong-repository` (git layer, knowledge-base pull) |

`gatewayErrorFor(status, body, what)` applies the same mapping to a status seen elsewhere (the git
layer). The token never appears in a message or a log line, including when the server echoes it.

#### Git

`core.gateway.git` ([`GatewayGit`](src/gateway/GatewayGit.ts)) clones and updates the repositories behind
a knowledge base or marketplace listing, in pure JS ([isomorphic-git](https://isomorphic-git.org), MIT;
no git install needed) over the gateway's smart HTTP endpoints. It takes the `gitUrl` from a listing
and never builds one; a URL off the gateway's origin is refused before any request, and redirects are
never followed. The folders are real local paths, read and written through Node's `fs`, and file
contents are never rewritten (no autocrlf).

```typescript
await core.gateway.git.clone(kb.gitUrl, dir, { ref: "master" }); // dir missing or empty
const status = await core.gateway.git.status(dir, { fetch: true }); // branch, dirty, ahead, behind
await core.gateway.git.pull(dir); // fetch + fast-forward only
await core.gateway.git.push(dir); // current branch to its upstream, fast-forward only
```

- `pull` never merges or rebases. A clean tree just proceeds, and local changes the incoming commits
  do not touch are kept. If they do touch them, it throws `GatewayDirtyWorkingTreeError` with the
  `paths` and changes nothing. If both sides have moved on it throws `GatewayWorkingCopyError`
  (`diverged`).
- `push` is never forced, never deletes a ref and never sends tags. An upstream that has moved on
  (found locally, or reported by the gateway as `409`) is `GatewayConflictError`; a token without
  `kb:push` is `GatewayScopeError`.
- Gateway failures map through `gatewayErrorFor`, as for REST. Operations share the client's
  one-at-a-time queue.

#### Knowledge bases

`core.gateway.kb` ([`GatewayKb`](src/gateway/GatewayKb.ts)) lists the knowledge bases the token's user
may read, global and tenant, and pulls and pushes them over `core.gateway.git`. A KB is addressed as
`<name>` (global) or `<U…>/<name>` (tenant); the listing's own `global/<name>` and
`tenant/<U…>/<name>` forms work too.

```typescript
const kbs = await core.gateway.kb.list({ scope: "tenant", tenant: "U142133" }); // ref, scope, tenant, name, title, liveBranch, canPush, gitUrl
const kb = await core.gateway.kb.resolve("onboarding");
const pulled = await core.gateway.kb.pull("U142133/handbook", { cwd: process.cwd() }); // clones into <cwd>/U142133-handbook
const pushed = await core.gateway.kb.push(pulled.dir); // { pushed, commit, ref }
```

- `list` checks the body's shape and throws `GatewayUnexpectedResponseError` for a bad one.
- `resolve` throws `GatewayKnowledgeBaseError` (`reason`: `bad-ref`, `not-found`, `ambiguous` with
  `candidates`).
- `pull` clones the live branch into a missing or empty folder (`dir`, relative to the `cwd` you pass;
  default `<name>`, or `<tenant>-<name>`), and fast-forwards an existing clone of the same repository.
  An existing clone that is not on the KB's live branch (or is detached) is refused before any fetch with `GatewayKnowledgeBaseError` (`wrong-branch`, `branch`, `liveBranch`). A clone of a different repository is `GatewayWorkingCopyError` (`wrong-repository`); incoming commits
  that touch locally changed files are `GatewayDirtyWorkingTreeError` (`paths`). It never prompts and
  has no way to discard local changes.
- `push` finds the KB from the clone's remote in a fresh listing and refuses a KB with
  `canPush: false` before sending anything, with `GatewayKnowledgeBasePushNotPermittedError` (`ref`).
  A clone not on the KB's live branch (or detached) is refused the same way with `GatewayKnowledgeBaseError` (`wrong-branch`, `branch`, `liveBranch`). A gateway branch that moved on is `GatewayConflictError`.

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
