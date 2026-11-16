import type { CompileDiagnostic, DraftCompileOutcome } from "@bluestep-systems/b6p-core-bsjs-git";

/**
 * One diagnostic of the platform's build in the script's own sources, located. `file` is relative to the draft folder
 * (`/`-separated); `line` and `column` are 1-based, `0` when the platform did not say; `code` is the compiler's
 * diagnostic code, `0` when it had none.
 * @lastreviewed null
 */
export interface TypeCheckError {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
  /**
   * The platform's severity: `ERROR` (a syntax, emit or configuration error, which makes the build unclean) or
   * `WARNING` (a type-checker finding, which does not).
   * @lastreviewed null
   */
  severity: string;
}

/**
 * Whether a diagnostic is about the script's own sources, the rule the platform's build uses: it names a file, the file
 * is inside the script's tree (relative, no `..` segment), and it is not a declaration file (`.d.ts`, `.d.mts`,
 * `.d.cts`, generated or not).
 * @lastreviewed null
 */
export function isOwnSourceDiagnostic(diagnostic: CompileDiagnostic): boolean {
  const file = diagnostic.file?.replace(/\\/g, "/");
  if (!file || file.startsWith("/") || /^[a-zA-Z]:/.test(file) || file.split("/").includes("..")) {
    return false;
  }
  return !/\.d\.[cm]?tsx?$/i.test(file);
}

/**
 * The located diagnostics of a platform build that `PushResult.typeCheckErrors` reports: every `ERROR` and `WARNING`
 * the platform listed for the script's own sources ({@link isOwnSourceDiagnostic}). The platform lists at most 20
 * diagnostics (`diagnosticsOmitted` counts the rest), so this can be fewer than the build found.
 * @param compile The platform's compile of the draft, or `null` when no build ran
 * @lastreviewed null
 */
export function typeCheckErrorsOf(compile: DraftCompileOutcome | null): TypeCheckError[] {
  if (!compile) {
    return [];
  }
  return compile.diagnostics
    .filter((d) => (d.severity === "ERROR" || d.severity === "WARNING") && isOwnSourceDiagnostic(d))
    .map((d) => ({
      file: (d.file as string).replace(/\\/g, "/"),
      line: d.line ?? 0,
      column: d.column ?? 0,
      code: d.code ?? 0,
      message: d.message,
      severity: d.severity,
    }));
}
