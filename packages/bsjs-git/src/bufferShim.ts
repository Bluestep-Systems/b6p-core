import { Buffer } from "buffer/";

/**
 * isomorphic-git reads a global `Buffer` (and its dependency `safe-buffer` requires `"buffer"`). Browsers have neither,
 * so the npm `buffer` package, a dependency of this one, is installed as the global when none exists. The trailing
 * slash makes Node resolve the package rather than its built-in; a bundler resolves the bare `"buffer"` that
 * safe-buffer asks for to the same package, because it is installed.
 * @lastreviewed null
 */
const scope = globalThis as { Buffer?: unknown };
if (scope.Buffer === undefined) {
  scope.Buffer = Buffer;
}
