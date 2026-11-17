# Writing tests here

Moved out of the repo's always-on rules (2026-09-10) — this only applies when you are writing a test,
so it lives next to the tests instead of loading in every session.

**There is no test framework.** These are dependency-free node scripts (`node:assert`, `require`) that
`npm test` runs in sequence after a compile. Behavioural specs assert against the **compiled** output
in `dist/`, not `src/`. The one exception is `JsdocLastReviewed.test.js`, a source-level convention
ratchet described in `AGENTS.md`.

**A new test file must be appended to the `test` script in `package.json` by hand.** Nothing globs
this directory, so a file that is not listed there silently never runs.

**What belongs here:** behavioural specs for the pure, high-risk logic that is awkward to reach from a
consumer — integrity auditing, path/URL parsing, URI canonicality and the folder marker, `outDir`
resolution, stale-bundle detection, metadata write coalescing, org-cache load readiness, and the
atomic-write rename retry. Broad integration coverage lives in the consumers (CLI, extension); core
additionally ships vscode-free test doubles (e.g. `MockFileSystem`) for them to use.

## Every spec must pass on Windows and POSIX alike

`B6PUri.test.js` is the pattern to copy: it hardcodes no absolute path and no `file://` literal
embedding one, building every case from `path.parse(process.cwd()).root` + `path.join` and deriving
every expectation from Node's own `pathToFileURL` — so each assertion states a *relationship* rather
than a spelling.

Literals are fine where the code under test is pure URL parsing, which is platform-independent; that
is how a POSIX runner still covers `file:///C:/…` drive-letter hrefs.

`DownstairsPathParser.test.js` shows the other half of the technique — swapping the ambient `path`
members for `path.win32` to drive the Windows branch from a Linux host.

## The bsjs-git package's tests

`packages/bsjs-git/test/` follows the same rules (node scripts over compiled `dist/`, listed by hand in that package's
`test` script) and the root `npm test` runs them first. Its round-trip spec needs `git` on the PATH: it serves a real
bare repo over loopback HTTP with `git http-backend`.

## The platform's build in tests

No spec compiles TypeScript, and none may: neither package has a compiler. The stand-in
`packages/bsjs-git/test/support/GitProxyStub.js` answers `compileDraft` the way the platform's git build does (a
stand-in output per TypeScript source, the manifest only when the build is clean, one build commit), steered per repo
entry: `buildUnclean`, `buildDiagnostics`, `buildCounts` (`errors`, `warnings`, `omitted` over the listed ones),
`buildAuthor`, `buildQueue` and `beforeBuild`. A `buildQueue` entry answers one request: a status such as `BUSY`, or
`NETWORK` / `GRAPHQL_ERROR`, answers before a real build; `BUILD_THEN_NETWORK` / `BUILD_THEN_BUSY` build and commit,
then answer 503 / `BUSY` (a lost answer). Every build commit carries `Bluestep-Build-Of: <source sha>` (the same
across a rebuild chain), and an unclean build deletes the manifest. `OUTCOME_UNKNOWN` / `OUTCOME_UNKNOWN_BUILT` answer the outcome-unknown
refusal without or after a build. Like the platform, it refuses a moved draft with code `PRECONDITION`, reason
`DRAFT_MOVED`, except when the head is its build of the commit asked for (the repeat call), and it commits output
whatever `.gitignore` says. `executePush` picks its route from
`/appinfo/version`; the `pushContext` fake in `GitDraftSync.test.js` answers it (`dev` by default) and specs pass
`floor` to pin `MIN_SERVER_VERSION`.
