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
  auth: { kind: "token", token },      // a b6pt_ token; or { kind: "session" } in a signed-in browser
  author: { name: "Ada", email: "ada@example.com" }, // always the caller's; there is no default identity
});

await repo.ensureGitMode();            // WEBDAV script -> git (one-way); no-op when already git. Returns the clone URL
await repo.clone();                    // every branch; draft checked out (or clone({ ensureGit: true }) for both)
await repo.writeFile("main.ts", "export {};\n");
await repo.commit("Edit main");        // stages every working-tree change
                                       // commit(msg, author, { parents }) makes a (merge) commit over the given parents even with nothing staged
await repo.push();                     // the draft branch
const { publishedSha, refreshed } = await repo.publish(); // the platform promotes draft to master

await repo.sha("origin/draft");                 // a branch or sha as a commit sha
await repo.isAncestor(a, b);                    // whether a is b or one of its ancestors
await repo.resetDraft(sha);                     // move the local draft and its working tree to a commit

await repo.log({ rev: "master", limit: 20 });   // CommitInfo[], newest first; page with `before`
await repo.listTree(publishedSha);                       // files at a revision
await repo.readText(publishedSha, "main.ts");
await repo.diff(a, b);                          // FileChange[] between two revisions

const legacy = new LegacyHistoryClient({ baseUrl, auth: { kind: "token", token } });
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

## Auth modes

`auth: { kind: "token", token }` sends the `b6pt_` token (Basic to the git proxy, Bearer to `/gql` and REST). `auth:
{ kind: "session" }` is for a browser already signed in: no `Authorization` header, `credentials: "include"`, and the
`B6P-CSRF-TOKEN` from `/csrf-token` on every request (git smart-HTTP, `/gql`, legacy history), refreshed tokens adopted
and a refused one retried once. Session mode relies on the platform's git proxy accepting the session (web item W6).

## Switching a script to git

`ensureGitMode()` reads the script's `gitPublishing` / `gitCloneUrl` and, only if it is not in GIT mode, runs
`enableGitPublishing: true` on the script's update mutation (synchronous, creates and seeds the repo, **one-way**).
`ensureGitModeResult()` is the same, also saying whether this call did the switch. `clone({ ensureGit: true })` does it first; a plain `clone()` never flips a script.
The mode is read with a real query, `remoteObject(id: "<classid>___<seqnum>") { ... on ScriptFormula|ScriptMergeReport|ScriptEndpoint { gitPublishing gitCloneUrl } }`, not a write.

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
