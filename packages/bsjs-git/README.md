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
const sha = await repo.publish();      // the platform promotes draft to master; returns the published sha

await repo.log({ rev: "master", limit: 20 });   // CommitInfo[], newest first; page with `before`
await repo.listTree(sha);                       // files at a revision
await repo.readText(sha, "main.ts");
await repo.diff(a, b);                          // FileChange[] between two revisions

const legacy = new LegacyHistoryClient({ baseUrl, token });
const entries = await legacy.list("654015___1001", { limit: 50 });   // newest first
const tree = await legacy.get("654015___1001", entries[0].id);       // saveState v1 or v0, one tree type
```

## Refusals

Every refusal is a typed `BsjsGitError` with a `code`: `GitAuthError` (401), `GitPushNotEnabledError` (the script
publishes over WebDAV, so its repo is read-only), `GitCodeLockedError`, `GitPermissionError` (other 403),
`GitRepoNotFoundError` (404: no repo, not visible, or git integration off), `GitPushRejectedError` (the forge refused
the ref; `protectedBranch` for master), `GitNotFastForwardError`, `PublishRefusedError` (`reason` is the server's
`PUBLISH_REFUSED` reason), `GitUnpushedChangesError`, `GitIdentityError`, `GitTransportError`.

## Publish

`publish()` sends the platform's existing publish: a GraphQL `updateScript<Type>` mutation with `takeSnapshot: true`
on `/gql` (bearer token), reading `config.publishedSha` from the answer. The local draft must already be pushed.

## Tests

`npm test -w @bluestep-systems/b6p-core-bsjs-git`. The round-trip spec serves a real bare repo over HTTP by running
`git http-backend` behind `node:http` (see `test/support/GitProxyStub.js`), so `git` must be on the PATH.
