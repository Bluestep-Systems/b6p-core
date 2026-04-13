import ts from "typescript";
import { Err } from "../Err";
import type { ScriptNode } from "./ScriptNode";
import type { ScriptRoot } from "./ScriptRoot";
import { FolderNames } from "../constants";
import { B6PUri } from '../B6PUri';
import type { ScriptContext } from "./ScriptContext";
import { ScriptFactory } from "./ScriptFactory";

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
    const pseudoParsedConfig = ts.parseConfigFileTextToJson(tsConfigFile.path(), Buffer.from(tsconfigTextArray).toString('utf-8'));
    pseudoParsedConfig.config.compilerOptions.rootDir = tsConfigFile.folder().path();
    if (pseudoParsedConfig.error) {
      const message = ts.flattenDiagnosticMessageText(pseudoParsedConfig.error.messageText, '\n');
      throw new Err.CompilationError(`Error parsing tsconfig.json at ${tsConfigFile.path()}: ${message}`);
    }
    const parsedConfig = ts.parseJsonConfigFileContent(
      pseudoParsedConfig.config,
      {
        ...ts.sys,
        readDirectory: () => []
      },
      tsConfigFile.folder().path(),
      undefined,
      tsConfigFile.path()
    );
    this.ctx.logger.info("Using tsconfig.json compiler options from:", tsConfigFile.path);
    parsedConfig.options.listEmittedFiles = true;
    return parsedConfig.options;
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
    if (!vals.some(existingSn => existingSn.path() === sn.path())) {
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
      const sfUris = sfList.map(sf => sf.uri());
      const program = ts.createProgram(sfUris.map(uri => uri.fsPath), compilerOptions);
      const emitResult = program.emit();
      emittedFiles.push(...(emitResult.emittedFiles || []));

      const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
      if (allDiagnostics.length > 0) {
        const diagnosticMessages = allDiagnostics.map(diagnostic => {
          if (diagnostic.file) {
            const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            return `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`;
          } else {
            return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
          }
        }).join('\n');
        this.ctx.logger.error("TypeScript compilation errors:\n" + diagnosticMessages);
      } else {
        this.ctx.prompt.info('TypeScript compiled successfully.');
      }
    };
    return emittedFiles;
  }
}
