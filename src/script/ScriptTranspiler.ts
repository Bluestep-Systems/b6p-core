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

  private async getCompilerOptions(sn: ScriptNode): Promise<ts.CompilerOptions> {
    const tsConfigFile = await sn.getClosestTsConfigFile();
    if (!tsConfigFile) {
      this.ctx.logger.info("No tsconfig.json found, using default compiler options.");
      return this.getDefaultOptions(sn);
    }

    const tsconfigTextArray = await this.ctx.fs.readFile(B6PUri.fromFsPath(tsConfigFile.uri().fsPath));
    const pseudoParsedConfig = ts.parseConfigFileTextToJson(
      tsConfigFile.path(),
      Buffer.from(tsconfigTextArray).toString("utf-8")
    );
    pseudoParsedConfig.config.compilerOptions.rootDir = tsConfigFile.folder().path();
    if (pseudoParsedConfig.error) {
      const message = ts.flattenDiagnosticMessageText(pseudoParsedConfig.error.messageText, "\n");
      throw new Err.CompilationError(`Error parsing tsconfig.json at ${tsConfigFile.path()}: ${message}`);
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
    this.ctx.logger.info("Using tsconfig.json compiler options from:", tsConfigFile.path);
    return ScriptTranspiler.applyTranspileInvariants(parsedConfig.options);
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
   * - `noEmitOnError`: emit must succeed even when type diagnostics exist. The
   *   consuming workspaces' CLAUDE.md states local tsconfig/declarations "are
   *   not guaranteed to produce a clean local build", so the type-check here is
   *   advisory — a project must not be able to block emit by setting this true.
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

  public async transpile(sharedRoot?: ScriptRoot): Promise<string[]> {
    const f = sharedRoot ? sharedRoot.factory : new ScriptFactory(this.ctx);

    const emittedFiles: string[] = [];
    for (const [tsConfigPath, sfList] of this.projects.entries()) {
      if (sfList.length === 0) {
        throw new Err.NoFilesToCompileError(tsConfigPath);
      }
      const sf = f.createFile(B6PUri.fromFsPath(tsConfigPath), sharedRoot);
      const compilerOptions = await this.getCompilerOptions(sf);
      const sfUris = sfList.map((sf) => sf.uri());
      const program = this.createProgram(
        sfUris.map((uri) => uri.fsPath),
        compilerOptions,
        tsConfigPath
      );
      const emitResult = program.emit();
      emittedFiles.push(...(emitResult.emittedFiles || []));

      const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
      // Contract: this step is an emit gate, not a type-audit gate. Push depends
      // on emit succeeding, NOT on zero diagnostics — the consuming workspaces'
      // CLAUDE.md documents that local declarations "are not guaranteed to
      // produce a clean local build". So type diagnostics are ADVISORY (warn),
      // and only a genuine emit failure is surfaced as an error.
      if (emitResult.emitSkipped) {
        this.ctx.logger.error(
          `TypeScript emit was skipped for ${tsConfigPath}; no JavaScript was produced.` +
            (allDiagnostics.length > 0 ? "\n" + this.formatDiagnostics(allDiagnostics) : "")
        );
      } else if (allDiagnostics.length > 0) {
        this.ctx.logger.warn(
          `TypeScript reported ${allDiagnostics.length} diagnostic(s) during transpile ` +
            `(advisory — emit succeeded):\n` +
            this.formatDiagnostics(allDiagnostics)
        );
      } else {
        this.ctx.prompt.info("TypeScript compiled successfully.");
      }
    }
    return emittedFiles;
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
