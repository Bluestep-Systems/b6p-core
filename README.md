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
(`https://gateway.bluestep.net`), the origin for knowledge bases and marketplace repos. Today it
holds the HTTP client the knowledge-base and marketplace operations are built on, and
`core.gateway.tokens` for managing the caller's own access tokens; see [Gateway](#gateway) below.

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
| `GatewayScopeEscalationError` | `403 scope-escalation` (a new token asked for a scope the presenting one lacks) |
| `GatewayConflictError` | `409 non-fast-forward` |
| `GatewayAliasTakenError` | `409 alias-taken` |
| `GatewayTooLargeError` | `413 too-large` |
| `GatewayUnavailableError` | `502`/`503`/`504`, a network failure or a timeout |
| `GatewayUnexpectedResponseError` | any other status, or a 2xx body that is not JSON |
| `GatewayConfigError` | an unusable `gatewayUrl`, or a URL off the gateway's origin |

`core.gateway.client.sequence(unit)` runs several requests as one queue entry, all presenting one
read of the token (token rotation uses it so nothing runs between the revoke and the store).

`gatewayErrorFor(status, body, what)` applies the same mapping to a status seen elsewhere (the git
layer). The token never appears in a message or a log line, including when the server echoes it.

#### Access tokens

`core.gateway.tokens` ([`GatewayTokenService`](src/gateway/GatewayTokenService.ts)) manages the
caller's **own** tokens. Every call needs the `tokens:self` scope on the stored token
(`GatewayScopeError` with `scope: "tokens:self"` otherwise); nothing addresses another user.

```typescript
const tokens = await core.gateway.tokens.list(); // [{ id, alias, scopes, createdAt, expiresAt, lastUsedAt, current, neverExpires }]
const minted = await core.gateway.tokens.create({ alias: "ci", scopes: ["kb:read"] }); // 90 days by default
minted.token; // the b6pt_ secret, shown this once; expiresAt: null mints one that never expires (neverExpires: true)
await core.gateway.tokens.revoke("ci"); // id or alias → { id, alias, revokedCurrent }
await core.gateway.tokens.rotate("laptop"); // → { replaced, token, rotatedCurrent }
```

- An id or alias is trimmed and resolved through `list()` first: no match is `GatewayNotFoundError`,
  a value that is one token's id and another's alias is `GatewayTokenAmbiguousError`, and a value
  containing `b6pt_` anywhere (a pasted secret) is refused (`GatewayInvalidArgumentError`) without
  being sent. Nothing is revoked or rotated in any of these cases, and no message quotes the value.
- `create` refuses an empty or whitespace alias, an empty scope list or an expiry that is not a
  date before sending (`GatewayInvalidArgumentError`). A new token's scopes must be a subset of the
  stored token's.
- **Rotating the stored token** (`current`) stores the replacement in its place: there is still one
  stored token. If storing fails after the gateway has rotated (so the old token is already
  revoked), `rotate` throws `GatewayTokenStoreError`, whose non-enumerable `replacement` property
  carries the new token, secret included, so it can be shown and the user is not locked out. The
  store also refuses, the same way, when the stored token is no longer the one that was rotated
  (an in-process compare-then-write, not atomic across processes). The list, the rotate and the
  store run as one entry in the client's queue with one read of the stored token, so a request
  queued behind a rotation presents the replacement, never the revoked token.
- **A minted secret is never dropped.** When a create or rotate answer carries the secret but is
  otherwise off-contract, the call throws `GatewayOffContractTokenError`, whose non-enumerable
  `secret` holds it; for a rotation of the stored token it is still offered to the store, and
  `stored` says whether that worked.
- **Revoking the stored token** is allowed. The result says `revokedCurrent: true` and the stored
  (now dead) token is left in place; what to do next is the consumer's call.
- Core never logs a secret or puts one in an error message. Warning about a token that never
  expires is the consumer's job; results carry `neverExpires`.

For specs, [`FakeGateway`](src/testing/FakeGateway.ts) is an in-process gateway on `127.0.0.1` that
answers the contract's REST routes (the token routes included) and error codes, with `grantToken`
(scopes, plus optional id, alias, owner and expiry; an expired token is `401 token-invalid`),
`issuedTokens`, `issuedSecrets` (every secret ever accepted, revoked ones included, for leak
checks), `failNext` and `route` (for mounting git smart-HTTP handlers).

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
