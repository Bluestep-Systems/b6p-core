import ts from "typescript";
import * as path from "path";
import { Err } from "../Err";
import type { ScriptNode } from "./ScriptNode";
import type { ScriptRoot } from "./ScriptRoot";
import { FolderNames } from "../constants";
import { B6PUri } from "../B6PUri";
import type { ScriptContext } from "./ScriptContext";
import { ScriptFactory } from "./ScriptFactory";
import { TsLibResolver } from "./TsLibResolver";

/**
 * Outcome of a {@link ScriptTranspiler.transpile} run. `emittedFiles` spans
 * every tsconfig project it compiled; the diagnostic fields do NOT (see below).
 *
 * `diagnosticCount` counts only the diagnostics from the platform-compiled
 * draft-root project (`scripts/*.ts`) — the code whose type-check gates the
 * push; 0 means that code type-checked cleanly. Client-bundle diagnostics
 * (nested tsconfigs, e.g. a MergeReport `static/`) are logged advisory and
 * deliberately excluded, since they legitimately reference browser-only globals
 * the component declares nowhere. `diagnosticText` is the formatted list of the
 * same counted diagnostics. Emit is never blocked by diagnostics (the platform
 * runs the emitted JS regardless), so callers use the count to report loudly
 * rather than to abort; a true emit failure throws instead of returning.
 * @lastreviewed null
 */
export interface TranspileOutcome {
  emittedFiles: string[];
  diagnosticCount: number;
  diagnosticText: string;
}

/**
 * Compiler for TypeScript files in script projects.
 * Manages compilation of multiple TypeScript files organized by their tsconfig.json files.
 * @lastreviewed 2025-10-01
 */
export class ScriptTranspiler {
  private projects: Map<string, ScriptNode[]> = new Map();
  private static DEFAULT_TS_CONFIG: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    outDir: FolderNames.DOT_BUILD,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    sourceMap: false,
    inlineSourceMap: false,
    allowJs: false,
    noEmitOnError: false,
    suppressOutputPathCheck: true,
    declarationDir: undefined,
    declaration: false,
    listEmittedFiles: true,
  };

  constructor(private readonly ctx: ScriptContext) {}

  private getDefaultOptions(sf: ScriptNode): ts.CompilerOptions {
    throw new Err.InvalidStateError("did not find a tsconfig for " + sf.path() + ".");
    const LOCAL_CONFIG = ScriptTranspiler.DEFAULT_TS_CONFIG;
    LOCAL_CONFIG.rootDir = sf.getScriptRoot().getDraftFolder().path();
    return LOCAL_CONFIG;
  }

  private async getProjectConfig(
    sn: ScriptNode
  ): Promise<{ options: ts.CompilerOptions; declarationRootFiles: string[] }> {
    const tsConfigFile = await sn.getClosestTsConfigFile();
    if (!tsConfigFile) {
      this.ctx.logger.info("No tsconfig.json found, using default compiler options.");
      return { options: this.getDefaultOptions(sn), declarationRootFiles: [] };
    }

    const tsconfigTextArray = await this.ctx.fs.readFile(B6PUri.fromFsPath(tsConfigFile.uri().fsPath));
    const pseudoParsedConfig = ts.parseConfigFileTextToJson(
      tsConfigFile.path(),
      Buffer.from(tsconfigTextArray).toString("utf-8")
    );
    if (pseudoParsedConfig.error) {
      const message = ts.flattenDiagnosticMessageText(pseudoParsedConfig.error.messageText, "\n");
      throw new Err.CompilationError(`Error parsing tsconfig.json at ${tsConfigFile.path()}: ${message}`);
    }
    pseudoParsedConfig.config.compilerOptions = pseudoParsedConfig.config.compilerOptions ?? {};
    pseudoParsedConfig.config.compilerOptions.rootDir = tsConfigFile.folder().path();

    // Resolve the ambient declaration files the tsconfig's include/files pull in
    // BEFORE the options-only parse below stubs out readDirectory. Without this
    // the transpile can't see the platform globals and the type-check is a
    // syntax check only (see resolveDeclarationRootFiles).
    const declarationRootFiles = ScriptTranspiler.resolveDeclarationRootFiles(
      tsConfigFile.path(),
      pseudoParsedConfig.config
    );
    if (declarationRootFiles.length > 0) {
      this.ctx.logger.info(
        `Including ${declarationRootFiles.length} declaration file(s) in the type-check:\n` +
          declarationRootFiles.join("\n")
      );
    } else {
      this.ctx.logger.warn(
        `No declaration files resolved from ${tsConfigFile.path()} (include/files) — ` +
          `platform globals may be unresolved and the type-check ineffective.`
      );
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      pseudoParsedConfig.config,
      {
        ...ts.sys,
        readDirectory: () => [],
      },
      tsConfigFile.folder().path(),
      undefined,
      tsConfigFile.path()
    );
    this.ctx.logger.info("Using tsconfig.json compiler options from:", tsConfigFile.path());
    return { options: ScriptTranspiler.applyTranspileInvariants(parsedConfig.options), declarationRootFiles };
  }

  /**
   * Resolve the ambient declaration files (`*.d.ts`) a tsconfig pulls in via its
   * `include`/`files`. These carry the platform globals — `B`, `console`, the
   * generated `MEFR_*`/`Record_*` types, the `Bluestep` namespace, imported
   * query globals — declared in the component's sibling `declarations/` tree
   * (a real draft tsconfig's `include` starts with `../declarations/index.d.ts`).
   *
   * The transpile builds its own root-file list by walking the `draft/` folder
   * and parses the tsconfig with `readDirectory: () => []`, so the tsconfig's
   * `include` — which points OUTSIDE `draft/` — is otherwise dropped. That left
   * every platform global an unresolved "Cannot find name" and reduced the only
   * pre-publish type-check to a syntax check, so a push shipped un-type-checked
   * JavaScript while reporting success (ClickUp 86bbeb659). Ambient `.d.ts`
   * emit no JavaScript, so adding them to the program's root files fixes the
   * type-check without changing the emitted-file set — the same effect as a
   * hand-written `/// <reference path="../../declarations/index.d.ts" />`.
   *
   * Resolution uses the real `ts.sys` (not the stubbed `readDirectory`) so
   * globbed includes resolve, then keeps only existing `.d.ts` so a stale
   * include entry cannot itself introduce a "file not found" diagnostic.
   * @lastreviewed null
   */
  static resolveDeclarationRootFiles(tsConfigPath: string, configJson: object): string[] {
    const parsed = ts.parseJsonConfigFileContent(
      configJson,
      ts.sys,
      path.dirname(tsConfigPath),
      undefined,
      tsConfigPath
    );
    return parsed.fileNames.filter((f) => ScriptTranspiler.isDeclarationFile(f) && ts.sys.fileExists(f));
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
   * - `listEmittedFiles`: we return the emitted paths to the caller.
   * - `skipLibCheck`: this step is a transpile/emit gate, not a full lib audit.
   *   Without it, a legitimate project `lib: ["dom", "WebWorker"]` (e.g. a
   *   MergeReport `static/` client bundle) produces 30+ lib-vs-lib conflicts
   *   (`ImportExportKind`, duplicate index signatures, `location` mismatch, ...)
   *   that have nothing to do with the project's own code.
   * - `noEmitOnError`: emit must succeed even when type diagnostics exist —
   *   the platform never type-checks (it runs the emitted JS on GraalVM) and a
   *   component's local declarations may be incomplete, so a diagnostic must not
   *   block the emit a push depends on. This is NOT the same as swallowing the
   *   diagnostics: `transpile` returns their count so the push surfaces them
   *   loudly instead of reporting a clean success (ClickUp 86bbeb659).
   * @lastreviewed null
   */
  private static applyTranspileInvariants(options: ts.CompilerOptions): ts.CompilerOptions {
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

  public async transpile(sharedRoot?: ScriptRoot): Promise<TranspileOutcome> {
    const f = sharedRoot ? sharedRoot.factory : new ScriptFactory(this.ctx);

    // The draft-root tsconfig governs the platform-compiled scripts (`scripts/*.ts`)
    // — the ONLY code whose type-check gates the push. Nested tsconfigs are
    // client bundles (e.g. a MergeReport `static/`) whose diagnostics stay
    // advisory: they legitimately reference browser-only third-party globals the
    // component declares nowhere, so gating on them would fail a push over benign
    // noise (see the b6p-push skill's third-party-lib-type-noise gotcha). When no
    // root is supplied we can't tell them apart, so we gate on everything.
    const draftRootTsConfigPath = sharedRoot ? sharedRoot.getDraftTsConfigPath() : null;

    const emittedFiles: string[] = [];
    const gatedDiagnostics: ts.Diagnostic[] = [];
    for (const [tsConfigPath, sfList] of this.projects.entries()) {
      if (sfList.length === 0) {
        throw new Err.NoFilesToCompileError(tsConfigPath);
      }
      const sf = f.createFile(B6PUri.fromFsPath(tsConfigPath), sharedRoot);
      const { options: compilerOptions, declarationRootFiles } = await this.getProjectConfig(sf);
      const sfPaths = sfList.map((sf) => sf.uri().fsPath);
      // Declarations first so the type-check resolves platform globals. Ambient
      // .d.ts emit nothing, so this changes only what is type-checked, not what
      // is emitted. The Set only dedupes exact string matches — declaration
      // paths come from ts.sys (forward slashes) and sfPaths from B6PUri
      // (native separators), so on Windows a .d.ts that is also under the draft
      // tree may appear twice; that is harmless (TypeScript canonicalizes
      // internally and a .d.ts still emits nothing), just not deduped here.
      const rootFiles = Array.from(new Set([...declarationRootFiles, ...sfPaths]));
      const program = this.createProgram(rootFiles, compilerOptions, tsConfigPath);
      const emitResult = program.emit();
      emittedFiles.push(...(emitResult.emittedFiles || []));

      const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
      const isGated = draftRootTsConfigPath === null || path.normalize(tsConfigPath) === draftRootTsConfigPath;
      // Contract: this step is an emit gate, not a hard type-audit gate. A
      // genuine emit failure is FATAL — we throw so callers
      // (ScriptRoot.compileDraftFolder → executePush) abort instead of pushing
      // missing JavaScript. Type diagnostics do NOT block emit (the platform
      // never type-checks — it runs the emitted JS on GraalVM, and local
      // declarations may be incomplete). For the platform-compiled draft-root
      // project they are NO LONGER silently advisory: the count is returned so
      // the push reports loudly instead of claiming a clean success (ClickUp
      // 86bbeb659). Client-bundle diagnostics stay advisory (logged, not gated).
      if (emitResult.emitSkipped) {
        throw new Err.CompilationError(
          `TypeScript emit was skipped for ${tsConfigPath}; no JavaScript was produced.` +
            (allDiagnostics.length > 0 ? "\n" + this.formatDiagnostics(allDiagnostics) : "")
        );
      } else if (allDiagnostics.length > 0) {
        if (isGated) {
          gatedDiagnostics.push(...allDiagnostics);
          this.ctx.logger.warn(
            `TypeScript reported ${allDiagnostics.length} diagnostic(s) for ${tsConfigPath}:\n` +
              this.formatDiagnostics(allDiagnostics)
          );
        } else {
          this.ctx.logger.warn(
            `TypeScript reported ${allDiagnostics.length} advisory diagnostic(s) for client bundle ` +
              `${tsConfigPath} (not gated — client-side globals may be intentionally undeclared):\n` +
              this.formatDiagnostics(allDiagnostics)
          );
        }
      } else {
        this.ctx.logger.info(`TypeScript type-checked ${tsConfigPath} cleanly.`);
      }
    }
    return {
      emittedFiles,
      diagnosticCount: gatedDiagnostics.length,
      diagnosticText: this.formatDiagnostics(gatedDiagnostics),
    };
  }

  /**
   * Create a `ts.Program` with a `CompilerHost` whose default-library resolution
   * does NOT depend on `__filename`.
   *
   * b6p-core is bundled into the consumer's single-file CLI / SEA binary, so
   * TypeScript's default `getDefaultLibLocation()` (= `dirname(__filename)`)
   * points at the bundle directory, where no `lib.*.d.ts` exist. We resolve the
   * lib directory via {@link TsLibResolver} and override the two host methods
   * that steer lib lookup. If no lib directory can be found we fall back to the
   * default host behavior rather than pointing it at a bogus path.
   * @lastreviewed null
   */
  private createProgram(fileNames: string[], options: ts.CompilerOptions, tsConfigPath: string): ts.Program {
    const host = ts.createCompilerHost(options);
    const libDir = TsLibResolver.resolveLibDir({
      explicitDirs: this.ctx.typescriptLibDirs,
      projectDirs: [path.dirname(tsConfigPath), process.cwd()],
    });
    if (libDir) {
      this.ctx.logger.info(`Resolved TypeScript lib directory: ${libDir}`);
      host.getDefaultLibLocation = () => libDir;
      host.getDefaultLibFileName = (o) => path.join(libDir, ts.getDefaultLibFileName(o));
    } else {
      this.ctx.logger.warn(
        "Could not resolve a TypeScript lib directory; falling back to default host resolution. " +
          "If this run is bundled (CLI/SEA), lib diagnostics are expected — supply providers.typescriptLibDirs."
      );
    }
    return ts.createProgram(fileNames, options, host);
  }

  private formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
    return diagnostics
      .map((diagnostic) => {
        if (diagnostic.file) {
          const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
          const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
          return `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`;
        } else {
          return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        }
      })
      .join("\n");
  }
}
