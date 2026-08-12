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
