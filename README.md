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

| Method | Purpose |
| --- | --- |
| `push` / `pushCurrent` | Commit and push the draft folder (optionally publish it as a snapshot) |
| `pull` / `pullCurrent` | Clone or fast-forward the draft into a workspace |
| `audit` / `auditPull` | Compare local vs. server; optionally pull differences |
| `deploy` | Multi-target deploy driven by a config file |
| `getSetupUrl` | Resolve a pulled script's web-UI setup page |
| `deriveWorkspacePath` | Recover the workspace folder from a path inside a script root |
| `getFactory` | The `ScriptFactory` for entering the script tree from a bare path |

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

| Field | Meaning |
| --- | --- |
| `pushed` | The draft is on the platform. `false` when the draft folder is missing or empty |
| `commitSha` | The draft commit this push made, or the one already there; `null` when `pushed` is `false` |
| `route` | Which route ran: `{ mode: "server-build" \| "push-only", reason, serverVersion, required }`, `reason` one of `dev`, `at-or-above-floor`, `below-floor`, `unknown`, `floor-unset`. `null` when the push stopped before asking |
| `snapshotRefused` | Set when a snapshot was asked for on a server that does not build git drafts: `{ reason: "too-old" \| "unknown" \| "floor-unset", serverVersion, required }`. The draft was pushed; nothing was built or published |
| `build` | The platform's compile of the pushed draft (`compileDraft`): `status` (`COMPILED`, `GATE_TRIPPED`, `EMIT_WITHHELD`, `NOTHING_TO_COMPILE`, `SKIPPED_EXTERNALLY_BUILT`, …, or `UNKNOWN` with `rawStatus`), `errors` / `warnings`, `diagnostics` (+ `diagnosticsOmitted`), `gate`. `null` when no build ran or the request failed |
| `buildCommitSha` | The platform's build commit (output, and the manifest when it vouched); the folder was fast-forwarded to it. `null` when it made none (already built, nothing to build) |
| `buildVouched` | `true`: the build is clean and its manifest committed, or the draft needs none (externally built, nothing to build). `false`: unclean, output committed without a manifest, so a publish is refused until it builds cleanly. `null`: no build ran |
| `buildError` | Why the build request failed after a successful push; otherwise `null` |
| `publishedSha` | The commit the platform published on a snapshot push (the build commit); `null` on a plain push, when nothing was published, or on a failed publish. A caller that asked for a snapshot treats `null` as a failure |
| `publishError` / `publishRefusal` | Why the platform refused or failed the publish (the draft stays pushed), and the structured `{ reason, withheld }` (`BUILD_STALE`, `BUILD_MANIFEST_MISSING`, `DRAFT_MOVED`, `ENTRYPOINT_MISSING`, …) |
| `switchedToGit` | This push switched a WebDAV script to git, which cannot be undone |
| `typeCheckDiagnostics` / `typeCheckErrors` | The build's diagnostics in the script's own sources (never a `.d.ts`): `{ file, line, column, code, message, severity }`, a type-checker finding being a `WARNING`. `null` / empty when no build ran |
| `liveVerified` | `true`: the platform's `master` is at `publishedSha`. `false`: it is at another commit. `null`: not proven either way |
| `liveMismatches` | Draft-relative paths that differ between `publishedSha` and `master` when `liveVerified` is `false` |
| `keptPlatformOnly` | Platform-only files kept because deleting them was not confirmed (they are part of the pushed commit) |

### How a push builds (since 1.0.0)

Nothing compiles in core or in `bsjsGit`; neither package has a runtime `typescript` dependency. The platform builds:

1. The draft is committed and pushed over git (the confirmations above).
2. `compileDraft` (GraphQL, `bsjsGit.ScriptRepo.compileDraft`) asks the platform to build the draft branch at the pushed
   commit (`expectedDraftSha`; a draft that moved meanwhile is refused, `DraftBuildMovedError`). It commits the output,
   plus the build manifest when the build is clean, as one build commit authored by the pushing user, and the folder is
   fast-forwarded to it. `BUSY` is retried 3 times 5 s apart, `INPUT_INCOMPLETE` 3 times 2 s apart,
   `COMPILER_UNAVAILABLE` and a failed request once. Every push builds, plain ones too.
3. A snapshot push whose build status publishes (`COMPILED`, `NOTHING_TO_COMPILE`, `SKIPPED_EXTERNALLY_BUILT`) then
   publishes the build commit and reads `master` back. An unclean build is refused by the platform's manifest check
   (`publishRefusal.reason` `BUILD_MANIFEST_MISSING` or `BUILD_STALE`); a tripped gate or withheld emit publishes
   nothing. Once the push succeeded, nothing throws: a failed build is `buildError`, a failed publish `publishError`.

Before pushing, a push asks the org's server for its version (`/appinfo/version`) and picks the route; it never refuses
a push for the version. A `dev` or `latest` server, or one at or above `MIN_SERVER_VERSION`, builds as above. Any other
(below the floor, an unreadable version, the floor unset) gets the git push alone: no build, and a snapshot push takes
no snapshot (`snapshotRefused`). `MIN_SERVER_VERSION` is unset (`null`) until the first web release with the git build
is tagged.

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
