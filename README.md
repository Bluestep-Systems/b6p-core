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

Construct `B6PCore` with your platform's [`B6PProviders`](src/providers.ts) implementation, then call
the command methods:

```typescript
import { B6PCore, type B6PProviders } from "@bluestep-systems/b6p-core";

const providers: B6PProviders = {
  fs,          // IFileSystem  — read/write/list files
  persistence, // IPersistence — durable key/value (settings, sessions)
  prompt,      // IPrompt      — ask the user for input/credentials
  logger,      // ILogger      — diagnostic logging
  progress,    // IProgress    — long-running task reporting
};

const core = new B6PCore(providers);

await core.pull({ formulaUrl: "https://org.bluestep.net/files/<id>/draft/", workspacePath });
await core.push({ rootPath, snapshot: true, message: "Update script" });
const audit = await core.audit({ filePath, workspacePath });
```

### Command surface

`B6PCore` exposes the operations both front-ends drive:

| Method | Purpose |
| --- | --- |
| `push` / `pushCurrent` | Upload local script files to the platform (optional versioned snapshot) |
| `pull` / `pullCurrent` | Download script files from a formula URL into a workspace |
| `audit` / `auditPull` | Compare local vs. server; optionally pull differences |
| `deploy` | Multi-target deploy driven by a config file |
| `report` | Report cached metadata / org-cache state |
| `updateCredentials` / `clearSessions` / `clearSettings` / `clearAll` | Auth & state management |
| `getConfig` / `setConfig` / `getSetupUrl` | Configuration helpers |
| `checkForUpdates` | GitHub-releases-based update check |

See [`src/index.ts`](src/index.ts) for the full set of exported classes, provider interfaces, data
utilities, constants, and types.

## Development

```bash
npm install
npm run check-types   # tsc --noEmit
npm run lint          # eslint
npm run compile       # tsc → dist/
npm run watch         # tsc --watch
npm run format        # prettier --write
npm run clean         # rm -rf dist
```

`npm run compile` emits `dist/` (JavaScript + `.d.ts` declarations), which is what gets published.

## License

MIT
