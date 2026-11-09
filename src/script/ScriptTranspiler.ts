// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
import * as path from "path";
import { spawnSync } from "child_process";
import type { API, Diagnostic, ParsedCommandLine, RawCompilerOptions } from "typescript/sync" with {
  "resolution-mode": "import",
};
import { Err } from "../Err";
import type { ScriptNode } from "./ScriptNode";
import type { ScriptRoot } from "./ScriptRoot";
import type { ScriptContext } from "./ScriptContext";

/**
 * Outcome of a {@link ScriptTranspiler.transpile} run. `emittedFiles` spans
 * every tsconfig project it compiled; the diagnostic fields do NOT (see below).
 *
 * `diagnosticCount` counts only the diagnostics from the platform-compiled
 * draft-root project (`scripts/*.ts`) — the code whose type-check gates the
 * push; `0` means that code type-checked cleanly. It is **`null`** when the
 * draft-root project was not among the compiled projects (a component whose TS
 * all lives under nested client bundles), i.e. no platform-code type-check ran
 * — distinct from `0`, so a machine consumer never reads "not checked" as
 * "checked clean". Client-bundle diagnostics (nested tsconfigs, e.g. a
 * MergeReport `static/`) are logged advisory and deliberately excluded, since
 * they legitimately reference browser-only globals the component declares
 * nowhere. `diagnosticText` is the formatted list of the same counted
 * diagnostics. Emit is never blocked by diagnostics (the platform runs the
 * emitted JS regardless), so callers use the count to report loudly rather than
 * to abort; a true emit failure throws instead of returning.
 *
 * Used only by the local fallback push (servers below `MIN_SERVER_VERSION`).
 * @lastreviewed null
 */
export interface TranspileOutcome {
  emittedFiles: string[];
  diagnosticCount: number | null;
  diagnosticText: string;
}

/**
 * The part of TypeScript 7's `typescript/sync` {@link API} the transpiler uses. Each instance owns
 * one native `tsc` process, which `close()` ends.
 * @lastreviewed null
 */
export type CompilerApi = Pick<API, "parseConfigFile" | "createProgram" | "close">;

/**
 * Starts a compiler session. Tests inject one; the default spawns TypeScript 7's native compiler.
 * @lastreviewed null
 */
export type CompilerApiFactory = (cwd: string) => Promise<CompilerApi>;

/**
 * Finds TypeScript 7.1's native `tsc` for this platform the way `typescript` itself does
 * (`lib/getExePath.js`: the `@typescript/typescript-<os>-<arch>` package's `lib/tsc[.exe]`), and
 * checks that it runs. The check matters: `typescript/sync` spawns the binary without an `error`
 * listener, so a binary that is missing or not executable at spawn time crashes the whole process
 * (an unhandled `error` event) instead of throwing.
 * @returns The binary's path
 * @throws an {@link Err.LocalCompilerUnavailableError} when the package or binary is missing or the
 *   binary does not run
 * @lastreviewed null
 */
export function resolveNativeCompilerPath(): string {
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
  const unavailable = (what: string, cause: unknown) =>
    new Err.LocalCompilerUnavailableError(
      `The local TypeScript compiler for ${process.platform}-${process.arch} ${what}` +
        (cause instanceof Error ? `: ${cause.message}` : "."),
      { serverVersion: null, reason: null, cause }
    );
  let exe: string;
  try {
    const typescriptDir = path.dirname(require.resolve("typescript/package.json"));
    const packageJson = require.resolve(`${platformPackage}/package.json`, { paths: [typescriptDir] });
    exe = path.join(path.dirname(packageJson), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
  } catch (e) {
    throw unavailable(`is not installed (${platformPackage})`, e);
  }
  if (process.platform === "win32" && exe.length >= 248) {
    exe = "\\\\?\\" + exe;
  }
  const probe = spawnSync(exe, ["--version"], { timeout: 30_000, windowsHide: true });
  if (probe.error || probe.status !== 0) {
    throw unavailable(
      `could not be run (${exe})`,
      probe.error ?? new Error(`exit status ${probe.status}, signal ${probe.signal}`)
    );
  }
  return exe;
}

/**
 * The default {@link CompilerApiFactory}: TypeScript 7.1's synchronous API over a native `tsc`
 * process from the per-platform package (`@typescript/typescript-<os>-<arch>`), which also carries
 * the standard library `.d.ts` files. The binary is found and test-run first
 * ({@link resolveNativeCompilerPath}). `typescript/sync` is an ES module and core is CommonJS, so it
 * is loaded with a dynamic `import()`.
 * @throws an {@link Err.LocalCompilerUnavailableError} when the module or the native compiler for
 *   this platform cannot be loaded or started
 * @lastreviewed null
 */
export const startNativeCompiler: CompilerApiFactory = async (cwd) => {
  const tsserverPath = resolveNativeCompilerPath();
  try {
    const { API } = await import("typescript/sync");
    return new API({ cwd, tsserverPath });
  } catch (e) {
    throw new Err.LocalCompilerUnavailableError(
      `The local TypeScript compiler could not be started on ${process.platform}-${process.arch}: ` +
        (e instanceof Error ? e.message : String(e)),
      { serverVersion: null, reason: null, cause: e }
    );
  }
};

/** TS18003 "No inputs were found in config file": the transpile supplies its own root files. @lastreviewed null */
const NO_INPUTS_FOUND = 18_003;

/**
 * Compiler for TypeScript files in script projects, for the local fallback push only.
 * Manages compilation of multiple TypeScript files organized by their tsconfig.json files.
 *
 * Ported from the TypeScript 5.9 in-process compiler to TypeScript 7.1's native full-program API
 * (ruling 44): same inputs, outputs and diagnostics shape. One compiler process serves every
 * project of a {@link transpile} call and is closed in `finally`, error or not.
 * @lastreviewed null
 */
export class ScriptTranspiler {
  private projects: Map<string, ScriptNode[]> = new Map();

  /**
   * @param ctx Where logs go
   * @param startCompiler Starts the compiler session; defaults to {@link startNativeCompiler}
   * @lastreviewed null
   */
  constructor(
    private readonly ctx: Pick<ScriptContext, "logger">,
    private readonly startCompiler: CompilerApiFactory = startNativeCompiler
  ) {}

  /**
   * Parse one tsconfig with the compiler and derive the transpile's options and declaration roots.
   * @lastreviewed null
   */
  private getProjectConfig(
    api: CompilerApi,
    tsConfigPath: string
  ): { options: RawCompilerOptions; declarationRootFiles: string[]; configDiagnostics: Diagnostic[] } {
    const parsed = api.parseConfigFile(tsConfigPath);
    const configDiagnostics = (parsed.errors ?? []).filter((d) => d.code !== NO_INPUTS_FOUND);
    // Resolve the ambient declaration files the tsconfig's include/files pull in. Without this
    // the transpile can't see the platform globals and the type-check is a syntax check only
    // (see resolveDeclarationRootFiles).
    const declarationRootFiles = ScriptTranspiler.resolveDeclarationRootFiles(parsed);
    if (declarationRootFiles.length > 0) {
      this.ctx.logger.info(
        `Including ${declarationRootFiles.length} declaration file(s) in the type-check:\n` +
          declarationRootFiles.join("\n")
      );
    }
    // The "no declarations resolved" case is NOT warned here: a client-bundle
    // tsconfig (e.g. a MergeReport `static/`) legitimately pulls in none, so a
    // per-project warning would fire on every such push. transpile() warns only
    // for the gated draft-root project, where empty declarations really do mean
    // an ineffective type-check.
    this.ctx.logger.info("Using tsconfig.json compiler options from:", tsConfigPath);
    const options = ScriptTranspiler.applyTranspileInvariants(
      // The parsed options are the finalized form of the raw ones (absolute paths, enum values),
      // which createProgram accepts as raw options.
      { ...(parsed.options as RawCompilerOptions) },
      path.dirname(tsConfigPath)
    );
    return { options, declarationRootFiles, configDiagnostics };
  }

  /**
   * Resolve the ambient declaration files (`*.d.ts`) a tsconfig pulls in via its
   * `include`/`files`. These carry the platform globals — `B`, `console`, the
   * generated `MEFR_*`/`Record_*` types, the `Bluestep` namespace, imported
   * query globals — declared in the component's sibling `declarations/` tree
   * (a real draft tsconfig's `include` starts with `../declarations/index.d.ts`).
   *
   * The transpile builds its own root-file list by walking the `draft/` folder,
   * so the tsconfig's `include` — which points OUTSIDE `draft/` — is otherwise
   * dropped. That left every platform global an unresolved "Cannot find name"
   * and reduced the only pre-publish type-check to a syntax check, so a push
   * shipped un-type-checked JavaScript while reporting success (ClickUp
   * 86bbeb659). Ambient `.d.ts` emit no JavaScript, so adding them to the
   * program's root files fixes the type-check without changing the
   * emitted-file set.
   *
   * The compiler resolves the globs and only lists files that exist, so a stale
   * include entry cannot itself introduce a "file not found" diagnostic.
   * @param parsed The tsconfig as the compiler parsed it
   * @returns The declaration files among its inputs, as native paths
   * @lastreviewed null
   */
  static resolveDeclarationRootFiles(parsed: Pick<ParsedCommandLine, "fileNames">): string[] {
    return (parsed.fileNames ?? []).filter((f) => ScriptTranspiler.isDeclarationFile(f)).map((f) => path.normalize(f));
  }

  /**
   * Whether a path is an ambient declaration file — matched broadly enough
   * (`.d.ts`, `.d.mts`, `.d.cts`) that a future switch to a module-flavored
   * declaration name cannot silently drop the platform globals and regress the
   * type-check back to syntax-only.
   * @lastreviewed null
   */
  private static isDeclarationFile(fsPath: string): boolean {
    return /\.d\.(ts|mts|cts)$/i.test(fsPath);
  }

  /**
   * Force the invariants this transpile step depends on onto a set of parsed
   * compiler options, regardless of what the project's tsconfig.json specified.
   *
   * - `rootDir`: the tsconfig's folder, so `scripts/app.ts` always maps to
   *   `<build folder>/scripts/app.js` (what the entrypoint check reads).
   * - `listEmittedFiles`: we return the emitted paths to the caller.
   * - `skipLibCheck`: this step is a transpile/emit gate, not a full lib audit.
   *   Without it, a legitimate project `lib: ["dom", "WebWorker"]` (e.g. a
   *   MergeReport `static/` client bundle) produces 30+ lib-vs-lib conflicts
   *   that have nothing to do with the project's own code.
   * - `noEmitOnError`: emit must succeed even when type diagnostics exist —
   *   the platform never type-checks (it runs the emitted JS on GraalVM) and a
   *   component's local declarations may be incomplete, so a diagnostic must not
   *   block the emit a push depends on. This is NOT the same as swallowing the
   *   diagnostics: `transpile` returns their count so the push surfaces them
   *   loudly instead of reporting a clean success (ClickUp 86bbeb659).
   * @lastreviewed null
   */
  static applyTranspileInvariants(options: RawCompilerOptions, rootDir: string): RawCompilerOptions {
    options.rootDir = rootDir;
    options.listEmittedFiles = true;
    options.skipLibCheck = true;
    options.noEmitOnError = false;
    return options;
  }

  public async addFile(sn: ScriptNode): Promise<void> {
    if (await sn.isFolder()) {
      this.ctx.logger.warn("Ignoring folder node in ScriptCompiler.addFile:", sn.path());
      return void 0;
    }
    if (!(await sn.isCopacetic())) {
      throw new Err.ScriptNotCopaceticError();
    }
    const newTsConfigFile = await sn.getClosestTsConfigFile();
    const vals = this.projects.get(newTsConfigFile.path()) || [];
    if (!vals.some((existingSn) => existingSn.path() === sn.path())) {
      vals.push(sn);
    } else {
      this.ctx.logger.warn("Ignoring duplicate file in ScriptCompiler.addFile:", sn.path());
    }
    this.projects.set(newTsConfigFile.path(), vals);
  }

  /**
   * Compile every added file, one program per tsconfig project, in one compiler session.
   * @param sharedRoot The script, whose draft-root tsconfig is the gated project; without it every
   *   project is gated
   * @throws an {@link Err.CompilationError} when a project's emit is skipped
   * @throws an {@link Err.LocalCompilerUnavailableError} when the compiler cannot be started
   * @lastreviewed null
   */
  public async transpile(sharedRoot?: ScriptRoot): Promise<TranspileOutcome> {
    // The draft-root tsconfig governs the platform-compiled scripts (`scripts/*.ts`)
    // — the ONLY code whose type-check gates the push. Nested tsconfigs are
    // client bundles (e.g. a MergeReport `static/`) whose diagnostics stay
    // advisory: they legitimately reference browser-only third-party globals the
    // component declares nowhere, so gating on them would fail a push over benign
    // noise. When no root is supplied we can't tell them apart, so we gate on everything.
    const draftRootTsConfigPath = sharedRoot ? sharedRoot.getDraftTsConfigPath() : null;

    const emittedFiles: string[] = [];
    const gatedDiagnostics: Diagnostic[] = [];
    // Whether the gated (draft-root) project was actually among the compiled
    // projects. If a component's TS all lives under nested client bundles and
    // nothing is governed by the draft-root tsconfig, no platform-code
    // type-check ran — and `diagnosticCount: 0` would falsely read as "checked
    // clean". We return `null` in that case instead (ClickUp 86bbeb659 review).
    let gatedProjectCompiled = false;
    if (this.projects.size === 0) {
      return { emittedFiles, diagnosticCount: null, diagnosticText: "" };
    }
    const cwd = sharedRoot ? sharedRoot.getDraftFolder().uri().fsPath : process.cwd();
    const api = await this.startCompiler(cwd);
    try {
      for (const [tsConfigPath, sfList] of this.projects.entries()) {
        if (sfList.length === 0) {
          throw new Err.NoFilesToCompileError(tsConfigPath);
        }
        const { options, declarationRootFiles, configDiagnostics } = this.getProjectConfig(api, tsConfigPath);
        const sfPaths = sfList.map((sf) => sf.uri().fsPath);
        const isGated = draftRootTsConfigPath === null || path.normalize(tsConfigPath) === draftRootTsConfigPath;
        if (isGated) {
          gatedProjectCompiled = true;
          // Only the gated draft-root project needs declarations to type-check
          // meaningfully; an empty set here means the check is effectively a
          // syntax pass, which is exactly the regression this guards against.
          if (declarationRootFiles.length === 0) {
            this.ctx.logger.warn(
              `No declaration files resolved from ${tsConfigPath} (include/files) — ` +
                `platform globals may be unresolved and the type-check ineffective.`
            );
          }
        }

        const {
          emittedFiles: projectEmitted,
          diagnostics: projectDiagnostics,
          emitSkipped,
        } = ScriptTranspiler.compileProject(api, sfPaths, declarationRootFiles, options);
        const allDiagnostics = [...configDiagnostics, ...projectDiagnostics];
        emittedFiles.push(...projectEmitted);

        // Contract: this step is an emit gate, not a hard type-audit gate. A
        // genuine emit failure is FATAL — we throw so callers
        // (ScriptRoot.compileDraftFolder → executePush) abort instead of pushing
        // missing JavaScript. Type diagnostics do NOT block emit. For the
        // platform-compiled draft-root project the count is returned so the push
        // reports loudly instead of claiming a clean success (ClickUp 86bbeb659).
        // Client-bundle diagnostics stay advisory (logged, not gated).
        if (emitSkipped) {
          throw new Err.CompilationError(
            `TypeScript emit was skipped for ${tsConfigPath}; no JavaScript was produced.` +
              (allDiagnostics.length > 0 ? "\n" + ScriptTranspiler.formatDiagnostics(allDiagnostics) : "")
          );
        } else if (allDiagnostics.length > 0) {
          if (isGated) {
            gatedDiagnostics.push(...allDiagnostics);
            this.ctx.logger.warn(
              `TypeScript reported ${allDiagnostics.length} diagnostic(s) for ${tsConfigPath}:\n` +
                ScriptTranspiler.formatDiagnostics(allDiagnostics)
            );
          } else {
            this.ctx.logger.warn(
              `TypeScript reported ${allDiagnostics.length} advisory diagnostic(s) for client bundle ` +
                `${tsConfigPath} (not gated — client-side globals may be intentionally undeclared):\n` +
                ScriptTranspiler.formatDiagnostics(allDiagnostics)
            );
          }
        } else {
          this.ctx.logger.info(`TypeScript type-checked ${tsConfigPath} cleanly.`);
        }
      }
    } finally {
      try {
        api.close();
      } catch (e) {
        this.ctx.logger.warn(`Closing the TypeScript compiler failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return {
      emittedFiles,
      diagnosticCount: gatedProjectCompiled ? gatedDiagnostics.length : null,
      diagnosticText: ScriptTranspiler.formatDiagnostics(gatedDiagnostics),
    };
  }

  /**
   * Build the program for one tsconfig project and emit it, returning the
   * emitted files (native paths) and the combined pre-emit + emit diagnostics,
   * the same set TypeScript 5.9's `getPreEmitDiagnostics` plus emit returned.
   *
   * The declaration files come FIRST so the type-check resolves platform
   * globals; ambient `.d.ts` emit nothing, so adding them changes only what is
   * type-checked, not the emitted-file set (the invariant the regression test
   * pins). Paths are compared normalized, so a `.d.ts` also under the draft tree
   * is listed once.
   * @lastreviewed null
   */
  static compileProject(
    api: Pick<CompilerApi, "createProgram">,
    sfPaths: string[],
    declarationRootFiles: string[],
    options: RawCompilerOptions
  ): { emittedFiles: string[]; diagnostics: Diagnostic[]; emitSkipped: boolean } {
    const rootFiles = Array.from(new Set([...declarationRootFiles, ...sfPaths].map((f) => path.normalize(f))));
    const program = api.createProgram(rootFiles, options);
    const preEmit = [
      ...program.getProgramDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    const emitResult = program.emit();
    const diagnostics = ScriptTranspiler.dedupe([...preEmit, ...emitResult.diagnostics]);
    return {
      emittedFiles: (emitResult.emittedFiles ?? []).map((f) => path.normalize(f)),
      diagnostics,
      emitSkipped: emitResult.emitSkipped,
    };
  }

  /**
   * Drop repeats: program-wide and global diagnostics can overlap.
   * @lastreviewed null
   */
  private static dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    return diagnostics.filter((d) => {
      const key = `${d.fileName ?? ""}\u0000${d.pos}\u0000${d.end}\u0000${d.code}\u0000${d.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Flatten a diagnostic's message chain the way TypeScript 5.9's `flattenDiagnosticMessageText`
   * did: each nested message on its own line, indented two spaces per level.
   * @lastreviewed null
   */
  private static flattenMessage(d: Pick<Diagnostic, "text" | "messageChain">, depth = 0): string {
    let text = (depth > 0 ? "\n" + "  ".repeat(depth) : "") + d.text;
    for (const next of d.messageChain ?? []) {
      text += ScriptTranspiler.flattenMessage(next, depth + 1);
    }
    return text;
  }

  /**
   * Format diagnostics as `file (line,col): message`, one per line, as the TypeScript 5.9 path did.
   * @lastreviewed null
   */
  static formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
    return diagnostics
      .map((diagnostic) => {
        const message = ScriptTranspiler.flattenMessage(diagnostic);
        if (diagnostic.fileName) {
          const { line, character } = diagnostic.startPosition ?? { line: 0, character: 0 };
          return `${path.normalize(diagnostic.fileName)} (${line + 1},${character + 1}): ${message}`;
        }
        return message;
      })
      .join("\n");
  }
}
