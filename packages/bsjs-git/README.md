# @bluestep-systems/b6p-core-bsjs-git

Browser- and Node-safe git client for BlueStep BSJS scripts. It edits a script's **draft** branch with
[isomorphic-git](https://isomorphic-git.org/) through the platform's git proxy (`<org>/git/<classid>___<seqnum>`),
publishes it, reads git history, and reads the legacy (pre-git) history archive. No WebDAV, no Node built-in imports:
the file system is injected, HTTP is `fetch`.

Used by [`@bluestep-systems/b6p-core`](../../README.md) (re-exported as `bsjsGit`) and by the BSJS editor.

```ts
import { ScriptRepo, LegacyHistoryClient, parseCompoundId } from "@bluestep-systems/b6p-core-bsjs-git";

const repo = new ScriptRepo({
  fs,                                  // Node's `fs`, or a browser one such as LightningFS (needs `.promises`)
  dir: "/work/654015___1001",
  script: parseCompoundId("654015___1001"),
  baseUrl: "https://org.bluestep.net/",
  token,                               // the b6pt_ bearer token
  author: { name: "Ada", email: "ada@example.com" }, // always the caller's; there is no default identity
});

await repo.clone();                    // every branch; draft checked out
await repo.writeFile("main.ts", "export {};\n");
await repo.commit("Edit main");        // stages every working-tree change
await repo.push();                     // the draft branch
const { publishedSha, refreshed } = await repo.publish(); // the platform promotes draft to master

await repo.log({ rev: "master", limit: 20 });   // CommitInfo[], newest first; page with `before`
await repo.listTree(publishedSha);                       // files at a revision
await repo.readText(publishedSha, "main.ts");
await repo.diff(a, b);                          // FileChange[] between two revisions

const legacy = new LegacyHistoryClient({ baseUrl, token });
const entries = await legacy.list("654015___1001", { limit: 50 });   // newest first
const tree = await legacy.get("654015___1001", entries[0].id);       // saveState v1 or v0, one tree type
```

Paths are `/`-separated and stay inside the working tree: a backslash, `..` or a `.git` segment is refused.

## Refusals

Every refusal is a typed `BsjsGitError` with a `code`: `GitAuthError` (401), `GitPushNotEnabledError` (the script
publishes over WebDAV, so its repo is read-only), `GitCodeLockedError`, `GitPermissionError` (other 403),
`GitRepoNotFoundError` (404: no repo, not visible, or git integration off), `GitPushRejectedError` (the forge refused
the ref; `protectedBranch` for master), `GitNotFastForwardError`, `PublishRefusedError` (`reason` is the server's
`PUBLISH_REFUSED` reason), `GitUnpushedChangesError`, `GitIdentityError`, `GitTransportError`.

## Publish

`publish()` sends the platform's existing publish: a GraphQL `updateScript<Type>` mutation with `takeSnapshot: true`
on `/gql`, reading `config.publishedSha` from the answer. The local draft must already be pushed. `/gql` enforces
the CSRF token on every call, bearer included, so the call mirrors `b6p-core`'s `csrfFetch`: the bearer opens a session,
the token is read from `/csrf-token` and sent as `B6P-CSRF-TOKEN` with the session cookie (kept in a small jar in Node;
a browser keeps its own), and a refused token is retried once. It resolves to `{ publishedSha, refreshed, refreshError? }`:
the publish has happened once it resolves, and `refreshed: false` only means the follow-up fetch of `origin/master` failed.

## Bundling for a browser

isomorphic-git needs a global `Buffer`, and its `safe-buffer` dependency requires `"buffer"`. This package depends on the
npm `buffer` package (pinned) and installs it as `globalThis.Buffer` when none exists (the first thing its entry does),
so a bundler resolves `"buffer"` to it with no polyfill plugin and no alias. `test/BrowserBundle.test.js` bundles the
package with esbuild (`platform: "browser"`, no plugins) to keep that true.

## Tests

`npm test -w @bluestep-systems/b6p-core-bsjs-git`. The round-trip spec serves a real bare repo over HTTP by running
`git http-backend` behind `node:http` (see `test/support/GitProxyStub.js`), so `git` must be on the PATH.
