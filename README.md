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
  fs, // FileSystem  — read/write/list files
  persistence, // Persistence — durable key/value (settings, sessions)
  prompt, // Prompt      — ask the user for input/credentials
  logger, // Logger      — diagnostic logging
  progress, // Progress    — long-running task reporting
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

| Method                 | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `push` / `pushCurrent` | Upload local script files to the platform (optional versioned snapshot) |
| `pull` / `pullCurrent` | Download script files from a formula URL into a workspace               |
| `audit` / `auditPull`  | Compare local vs. server; optionally pull differences                   |
| `deploy`               | Multi-target deploy driven by a config file                             |
| `getSetupUrl`          | Resolve a pulled script's web-UI setup page                             |
| `deriveWorkspacePath`  | Recover the workspace folder from a path inside a script root           |
| `getFactory`           | The `ScriptFactory` for entering the script tree from a bare path       |

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

### Push results

`push` / `pushCurrent` resolve to a [`PushResult`](src/script/push.ts) (or `null` when no target was
given). Read `pushed` first: `false` means nothing was uploaded.

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pushed`           | The upload ran. `false` when the draft folder is missing or empty                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `route`            | Which route the push took: `{ mode: "server" \| "draft-only", reason, serverVersion, required }`. `reason` is `dev`, `at-or-above-floor`, `below-floor`, `unknown` or `floor-unset`. `null` when the draft folder was missing                                                                                                                                                                                                                                                                 |
| `snapshotRefused`  | Set when a snapshot push was asked for on a server without server-side compile: `{ reason: "too-old" \| "unknown" \| "floor-unset", serverVersion, required }`. The sources were saved to the draft and no snapshot was taken. `null` otherwise                                                                                                                                                                                                                                               |
| `compile`          | What the platform's `compileDraft` came to: `status` (`COMPILED`, `GATE_TRIPPED`, `EMIT_WITHHELD`, `NOTHING_TO_COMPILE`, `SKIPPED_GIT_MANAGED`, `SKIPPED_EXTERNALLY_BUILT`, `OUTPUT_UPLOAD`, `NOT_PERMITTED`, `COMPILER_UNAVAILABLE`, `WRITE_FAILED`, `INPUT_INCOMPLETE`, `BUSY`, or `UNKNOWN` with `rawStatus` kept), `errors` / `warnings`, `written` / `deleted`, `diagnostics` (+ `diagnosticsOmitted`) and the `gate` block (`tripped`, `withheld`, `problems`). `null` when nothing ran |
| `publish`          | What `takeSnapshot` came to (`published`, counts, diagnostics, `withheld`, `gate`). `null` for a plain push and for a snapshot push whose compile status does not publish (anything but `COMPILED`, `NOTHING_TO_COMPILE`, `SKIPPED_EXTERNALLY_BUILT`)                                                                                                                                                                                                                                         |
| `historyRecorded`  | A snapshot's history entry was recorded. `false` also when nothing was published or the push stopped early                                                                                                                                                                                                                                                                                                                                                                                    |
| `keptPlatformOnly` | Platform-only files kept because deleting them was not confirmed                                                                                                                                                                                                                                                                                                                                                                                                                              |

### How a push works

Push uploads sources only, and only to `draft/`. Core does not compile or type-check, never PUTs
`snapshot/` or a build folder (`.build` by default), and never reads `X-Bluestep-Compile`:

1. Each changed source is PUT to `draft/` (WebDAV writes never compile). Uploads stop at the first
   failure; if any file went up the draft is still compiled, then the upload error is thrown.
2. Platform-only files are offered for deletion (declined by default).
3. `compileDraft` (GraphQL) compiles the whole draft on the platform. `BUSY` is retried 3 times 5 s
   apart, `INPUT_INCOMPLETE` 3 times 2 s apart, `COMPILER_UNAVAILABLE` and a network failure once.
   `GATE_TRIPPED` and `EMIT_WITHHELD` are results (`compile.status`), not errors: the sources are saved.
4. A snapshot push whose compile status is `COMPILED`, `NOTHING_TO_COMPILE` or
   `SKIPPED_EXTERNALLY_BUILT` then calls `takeSnapshot`, which recompiles and publishes on the
   platform, and records the history entry. A refusal throws `Err.PublishRefusedError`
   (`reason`: `GATE_TRIPPED` | `EMIT_WITHHELD` | `ENTRYPOINT_MISSING` | `OUTPUT_SHADOWS` |
   `COMPILER_UNAVAILABLE` | `BUSY` | `INPUT_INCOMPLETE` | `WRITE_FAILED` | `NOT_PERMITTED` |
   `UNKNOWN`, with the platform's detail in `publish`); `BUSY` and `INPUT_INCOMPLETE` are retried first.
   A request that fails without an outcome throws `Err.ServerCompileRequestError` (`phase`, `messages`).

There is no read-back of `snapshot/`: the platform writes it itself. The pieces are exported
(`compileDraft`, `takeSnapshot`, `uploadAndCompile`, `COMPILE_RETRY`) for consumers and tests.

### Push by server version

Before uploading anything, a push asks the org's server for its version (`/appinfo/version`) and
picks a route; it never refuses a push for the version.

| Server                                                                       | Plain push                                                                                 | Snapshot push                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `dev`, or at or above `MIN_SERVER_VERSION`                                   | the flow above (compile on the platform)                                                   | the flow above, then `takeSnapshot`                                                                    |
| below the floor, version unreadable or not a release tag, or the floor unset | sources PUT to `draft/` (usual platform-only cleanup); no `compileDraft`, no snapshot work | exactly that plain push, then no publish: `PushResult.snapshotRefused` is set and no snapshot is taken |

`MIN_SERVER_VERSION` is `null` until the first web release containing the flow is tagged, so until
then every server but a `dev` build takes the draft-only route. Core has no compiler of its own.
`PushResult.route` says which route ran.

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
