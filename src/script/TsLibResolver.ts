import ts from "typescript";
import * as path from "path";

/**
 * Resolves the directory that holds TypeScript's default library declaration
 * files (`lib.d.ts`, `lib.es2022.d.ts`, `lib.dom.d.ts`, ...).
 *
 * WHY THIS EXISTS: b6p-core is bundled by its consumers (the b6p CLI's single
 * `dist/cli.js` and its SEA binary). TypeScript's default `CompilerHost` locates
 * the standard library via:
 *
 *     getDefaultLibLocation() = getDirectoryPath(sys.getExecutingFilePath())
 *     getExecutingFilePath()  = __filename
 *
 * Once bundled, `__filename` is the bundle path (or the standalone exe), so TS
 * looks for `lib.*.d.ts` next to the bundle — where they never exist. The result
 * is "File 'lib.esnext.d.ts' not found" cascading into "Cannot find global type
 * 'Array'", "Cannot find name 'console'", etc., for every project.
 *
 * This resolver finds the lib directory WITHOUT relying on `__filename`, so the
 * caller can override the host's lib resolution and compile correctly whether it
 * runs from an npm install, a bundled CLI, or a SEA binary.
 * @lastreviewed null
 */
export class TsLibResolver {
  /**
   * A file present in every TypeScript lib directory; used as the existence probe.
   * @lastreviewed null
   */
  private static readonly SENTINEL = "lib.d.ts";

  /**
   * Return the first directory that actually contains TypeScript's default
   * library files, or `undefined` if none is found (in which case the caller
   * should leave the default host behavior untouched).
   *
   * Resolution order:
   *   1. `explicitDirs` — supplied by the consumer (the CLI). Covers both the
   *      npm fallback (a `lib/` shipped next to the bundle) and the SEA binary
   *      (a temp dir the binary extracts its embedded libs into). Neither
   *      depends on `__filename`, so both stay correct under bundling.
   *   2. `node_modules/typescript/lib`, walking up from each project dir — the
   *      typescript install of the workspace being pushed.
   *
   * Existence is probed with `ts.sys`, which reads the real filesystem — the
   * same source the `CompilerHost` reads libs from — so a hit here guarantees
   * the host can actually read the files.
   * @lastreviewed null
   */
  static resolveLibDir(opts: {
    explicitDirs?: readonly string[];
    projectDirs?: readonly string[];
  }): string | undefined {
    const { explicitDirs = [], projectDirs = [] } = opts;

    for (const dir of explicitDirs) {
      if (dir && this.hasLibFiles(dir)) {
        return dir;
      }
    }

    for (const projectDir of projectDirs) {
      if (!projectDir) {
        continue;
      }
      const found = this.findInNodeModules(projectDir);
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  /**
   * True if `dir` contains TypeScript's default library files.
   * @lastreviewed null
   */
  private static hasLibFiles(dir: string): boolean {
    // ts.sys is always defined under Node; guard anyway so a non-Node host that
    // lacks it degrades to "not found" rather than throwing.
    return !!ts.sys?.fileExists(path.join(dir, this.SENTINEL));
  }

  /**
   * Walk up from `startDir` looking for `node_modules/typescript/lib`.
   * @lastreviewed null
   */
  private static findInNodeModules(startDir: string): string | undefined {
    let current = path.resolve(startDir);
    let prev = "";
    // Loop terminates when `path.dirname` stops changing (filesystem root).
    while (current !== prev) {
      const candidate = path.join(current, "node_modules", "typescript", "lib");
      if (this.hasLibFiles(candidate)) {
        return candidate;
      }
      prev = current;
      current = path.dirname(current);
    }
    return undefined;
  }
}
