# @bluestep-systems/b6p-core-bsjs-git

Browser- and Node-safe git client for BlueStep BSJS scripts. It edits a script's **draft** branch with
[isomorphic-git](https://isomorphic-git.org/) through the platform's git proxy (`<org>/git/<classid>___<seqnum>`),
asks the platform to build it, publishes it, reads git history, and reads the legacy (pre-git) history archive. No
WebDAV, no Node built-in imports, no compiler: the file system is injected, HTTP is `fetch`, and the platform compiles.

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
                                       // clone({ depth: 50, singleBranch: true }): a bounded clone (plus master's head at the same depth);
                                       // repo.deepen(50) loads older history; repo.logPage(...).shallowBoundary says when to
await repo.writeFile("main.ts", "export {};\n");
await repo.commit("Edit main");        // stages every working-tree change
                                       // commit(msg, author, { parents }) makes a (merge) commit over the given parents even with nothing staged
await repo.push();                     // the draft branch
                                       // commit(msg, author, { force: [".build/app.js"] }) stages those paths even when .gitignore matches them
const build = await repo.compileDraft();  // the platform builds the pushed draft; the local draft moves to its build commit
                                          // { compile, buildCommitSha, vouched, head, fastForward }
const { publishedSha, refreshed } = await repo.publish(); // the platform promotes draft (the build commit) to master

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
`PUBLISH_REFUSED` reason), `DraftBuildFailedError` / `DraftBuildMovedError` (the build), `GitBuildFastForwardBlockedError` (`paths`), `GitUnpushedChangesError`,
`GitIdentityError`, `GitTransportError`.

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

## Build

Nothing compiles in this package or in the editor: `compileDraft()` asks the platform to build the draft it holds. The
local draft must already be pushed (`GitUnpushedChangesError` otherwise). It sends the script's update mutation with
`compileDraft: true` and `expectedDraftSha` (the pushed head) on `/gql`; the platform compiles the draft branch at that
commit against its siblings' snapshots and commits the output and stale-output deletes, plus the build manifest only when
it vouches for the build (every project's output written, no blocking error; a type-checker finding is a warning), as one
build commit authored by the caller. The answer's `extensions.bluestepCompile[0]` is the compile (`status`, counts,
`diagnostics`, `gate`; `parseDraftCompileOutcome`) and `extensions.bluestepBuild[0]` the build commit (`{ commit,
vouched }` of `{ script, draftSha, commit, built, vouched, status }`; `parseDraftBuildCommit`; `vouched` is also true
for a draft that needs no manifest). The local draft is then moved exactly to the build commit by
`fastForwardToBuild(sha)`: the working tree and index first, for exactly the paths the build changed (straight into the
index, whatever `.gitignore` says), the branch last. A path whose local copy matches neither the pushed commit nor the
build (a local edit, an untracked or ignored file) stops it before anything is touched; other local edits are kept. The
outcome is `fastForward: { state, blockedPaths, error }` (`fast-forwarded`, `unchanged`, `blocked`, `failed`), never a
build failure. `isBuildCommitOf(candidate, base)` says whether a commit is the platform's build of exactly the source `base`, or a
rebuild chain of it: each commit carries the trailer `Bluestep-Build-Of: <base>` (`buildSourceOf`, `BUILD_OF_TRAILER`),
has one parent and changes only paths under the output folder of some build project at the parent: each
`tsconfig.json` at any depth gives `<its dir>/` + its `buildOutputFolder`, plus the root `jsconfig.json` when there is
no root `tsconfig.json`; a project whose folder is empty or leaves the tree gives none, and with none at all nothing is
a build (`buildConfigPaths`, `buildOutputFolders`, `changesOnlyBuildOutput`: the one resolver web and the BSJS editor
use too). A chain is at most 16 build commits deep. The subject never counts. This is
web's rule (`docs/bsjs-git-snapshot-design.md`, "Build commits"), the trailer parsed as there: CRLF as LF, trailing
whitespace dropped, the last paragraph (after the last blank or whitespace-only line, or the whole message), exactly one
line `Bluestep-Build-Of: <40/64 hex>`. Rule 3 compares complete tree entries (mode and id, gitlinks included), so a
mode-only or submodule change outside `F/` is not a build.

A refusal with reason `BUILD_OUTCOME_UNKNOWN` (the platform could not confirm its build push) is never retried, since a repeat could build twice: `compileDraft` reads the draft back and returns
`outcomeUnknown: { buildFound }`, moving the local draft to the head when that is a build of the push. `compile` is
then `UNKNOWN` and `vouched` false. It is for taking
in a build whose answer was lost. An unclean build deletes the manifest, and the fast-forward deletes it here too.

It resolves to `{ compile, buildCommitSha, vouched, head, fastForward }`: `buildCommitSha` is `null` when the build made no commit
(already built at that commit, nothing to build). An unclean build (`vouched: false`) still commits its output, without
a manifest, so `publish()` is refused until a clean build. `BUSY` is retried 3 times 5 s apart, `INPUT_INCOMPLETE` 3
times 2 s apart, `COMPILER_UNAVAILABLE` and a failed request once (`COMPILE_RETRY`; `options.sleep` replaces the
timer). A tripped gate or withheld emit is a result (`compile.status`; `compileAllowsPublish` says whether to publish).
A draft that moved since the push is `DraftBuildMovedError` (`DRAFT_MOVED`); any other failure is
`DraftBuildFailedError` (`messages`, `networkFailure`).

## Publish

`publish({ at })` pins the publish to the commit that was built and checked (the build commit, or the pushed commit
when there was none): the local draft must be that commit or a build of it (`isBuildCommitOf`), else
`PublishPinMismatchError` (`at`, `local`) is thrown with nothing sent, so a later save cannot be published under an
earlier build's result. b6p-core always pins.

Build refusals are `DraftBuildFailedError` with a typed `reason` (`DRAFT_BUILD_REFUSAL_REASONS`: `DRAFT_MOVED`,
`BUILD_OUTCOME_UNKNOWN`, `DRAFT_TOO_LARGE`, `REPO_MISSING`, `DRAFT_BRANCH_MISSING`; `rawReason` keeps a newer one) and
are never retried.

The mutation carries `expectedDraftSha`: the local draft head `publish()` verified equals the platform's. If the platform's draft moved since (someone pushed in between), it refuses with reason `DRAFT_MOVED`, thrown as `PublishDraftMovedError` (a `PublishRefusedError`), and publishes nothing. `gitMode()` reads the mode without switching anything.

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

## Build manifest

A git script publishes `draft` exactly as committed, so the server refuses a draft whose sources no longer match the
build manifest (`<outDir>/.b6p-build.json`, contract v1): the git blob SHA-1 of every source file the build was made
from. The platform writes it in its build commit (see Build), only for a clean build; no client writes one, and this
package has no manifest writer (0.3.0 removed `commit({ buildManifest })`, `planBuildManifest`, `formatBuildManifest`,
`gitBlobSha1` and `BUILD_MANIFEST_BUILDER`). None is needed for an externally built script, a tree with no
`tsconfig.json`, or a draft with no TypeScript source outside the output folder (`isTypeScriptSource`: `ts tsx mts
cts`, never a `*.d.*` declaration). The layout helpers (`buildOutputFolder`, `buildManifestPath`, `isBuildSource`,
`isTypeScriptSource`, `hasNoTsconfig`, `parseJsonc`) stay exported for reading. A refused publish is
`PublishBuildStaleError` (`BUILD_STALE`), `PublishBuildManifestMissingError` (`BUILD_MANIFEST_MISSING`) or
`PublishBuildManifestInvalidError` (`BUILD_MANIFEST_INVALID`), each with `withheld` (the stale paths, or the
manifest's path).
