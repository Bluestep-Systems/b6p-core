import * as path from "path";
import { pathToFileURL, fileURLToPath } from "url";

/**
 * Cross-platform URI abstraction that replaces `vscode.Uri` in the core layer.
 *
 * Internally stores a **canonical** URL string — a `file://` URL for filesystem
 * paths, or any other URL for WebDAV / HTTP targets. Uses Node's `url` module for
 * the platform-specific heavy lifting — `pathToFileURL` and `fileURLToPath` handle
 * Windows drive-letter normalization, backslash conversion, etc.
 *
 * Canonicality is an **invariant of both constructors**, and it is what makes
 * {@link B6PUri.equals} equality-of-denotation rather than equality-of-spelling,
 * and what makes {@link B6PUri.toString} sound to use as a `Map` key (as
 * `MockFileSystem` does). Any future constructor must preserve it.
 *
 * A trailing separator on the path is a **meaningful folder marker**, not noise:
 * `ScriptFactory.createNode` classifies a URI as a `ScriptFolder` rather than a
 * `ScriptFile` on that signal alone. `file:///a/b` and `file:///a/b/` therefore
 * denote different things and are correctly unequal. See
 * {@link B6PUri.isDirectoryMarked} and {@link B6PUri.asDirectory}.
 * @lastreviewed null
 */
export class B6PUri {
  private constructor(private readonly _href: string) {}

  // ── Constructors ──────────────────────────────────────────────────

  /** Create from a platform-native filesystem path (e.g. `C:\Users\foo` or `/home/foo`). */
  static fromFsPath(fsPath: string): B6PUri {
    return new B6PUri(pathToFileURL(fsPath).href);
  }

  /**
   * Create from any URL string (`file://`, `https://`, etc.).
   *
   * The string is **parsed and canonicalized**, not stored verbatim: `new URL(...)`
   * normalizes percent-encoding and the empty `file://` authority, so
   * `fromString("file:///a b")`, `fromString("file://localhost/a%20b")` and
   * `fromFsPath("/a b")` all produce the same `_href` and compare `equals`. Storing
   * the raw string instead let those diverge and silently keyed apart in any `Map`
   * over {@link B6PUri.toString}.
   *
   * Parsing also makes a malformed URI fail **here**, at the mistake, rather than at
   * the first {@link B6PUri.fsPath} / {@link B6PUri.scheme} access an arbitrary
   * distance away. Note that `new URL` accepts more than it looks: a Windows path
   * like `C:\Users\foo` parses as scheme `c:` rather than throwing, so use
   * {@link B6PUri.fromFsPath} for filesystem paths.
   *
   * @param url An absolute URL string.
   * @returns A canonical `B6PUri`.
   * @throws {TypeError} `ERR_INVALID_URL` if `url` is not a parseable absolute URL.
   * @lastreviewed null
   */
  static fromString(url: string): B6PUri {
    return new B6PUri(new URL(url).href);
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * A fresh `URL` view of {@link B6PUri._href}.
   *
   * Every accessor that needs to reach into the URL's structure goes through here
   * rather than repeating `new URL(this._href)`. Deliberately a **method, not a
   * cached getter**: the returned object is mutable and three callers assign to its
   * `pathname`, so each needs its own instance. The method call site also keeps the
   * parse visible — this is not free, and `href` is already stored canonical, so a
   * caller that only needs the string should use {@link B6PUri.toString}.
   *
   * Never throws for an instance of this class: both constructors have already
   * parsed the string, so canonicality guarantees this re-parse succeeds.
   * @lastreviewed null
   */
  private toUrl(): URL {
    return new URL(this._href);
  }

  // ── Accessors ─────────────────────────────────────────────────────

  /** Platform-correct filesystem path. Only valid for `file://` URIs. */
  get fsPath(): string {
    return fileURLToPath(this._href);
  }

  /** The full URL string. */
  toString(): string {
    return this._href;
  }

  /** The scheme portion (`file`, `https`, etc.). */
  get scheme(): string {
    return this.toUrl().protocol.replace(/:$/, "");
  }

  /** Whether this is a `file://` URI. */
  get isFile(): boolean {
    return this.scheme === "file";
  }

  // ── Path operations ───────────────────────────────────────────────

  /** Join path segments onto this URI, using posix rules on the URL pathname. */
  joinPath(...segments: string[]): B6PUri {
    if (this.isFile) {
      return B6PUri.fromFsPath(path.join(this.fsPath, ...segments));
    }
    const url = this.toUrl();
    url.pathname = path.posix.join(url.pathname, ...segments);
    return new B6PUri(url.href);
  }

  /**
   * Whether this URI carries the trailing-separator **folder marker**.
   *
   * The marker is load-bearing: `ScriptFactory.createNode` uses it as the *only*
   * folder signal, since it cannot touch the filesystem to check. This getter tests
   * the URL pathname, which is equivalent to `createNode`'s
   * `fsPath.endsWith(path.sep)` for `file://` URIs but also works for the WebDAV /
   * HTTP URIs whose {@link B6PUri.fsPath} would throw.
   * @lastreviewed null
   */
  get isDirectoryMarked(): boolean {
    return this.toUrl().pathname.endsWith("/");
  }

  /**
   * This URI with the trailing-separator folder marker applied — idempotent, and
   * returns `this` when the marker is already present.
   *
   * Replaces the hand-rolled `joinPath("/")` / `path.join(p, "/")` idiom that used
   * to re-establish the marker after {@link B6PUri.joinPath} or `path.join` drops it
   * (`ScriptRoot`, `ScriptFolder.flattenDirectory`, `push.ts` — all migrated to this
   * method). Query and fragment are preserved, unlike appending to the href.
   *
   * Has no effect on a URL with an opaque (non-hierarchical) path such as
   * `mailto:`, whose pathname is not assignable; every scheme this class is used
   * with (`file`, `http(s)`, WebDAV) is hierarchical.
   * @lastreviewed null
   */
  asDirectory(): B6PUri {
    if (this.isDirectoryMarked) {
      return this;
    }
    const url = this.toUrl();
    url.pathname += "/";
    return new B6PUri(url.href);
  }

  /**
   * `p` with any trailing folder marker removed, so a marked and an unmarked
   * spelling of one directory compare equal.
   *
   * The single definition behind every marker-insensitive comparison in the
   * codebase: `ScriptFolder.contains`/`equals`, `ScriptRoot.selectStaleBundles`'s
   * containment test, and `MockFileSystem`'s entry keys. It lives here, next to
   * {@link B6PUri.isDirectoryMarked} and {@link B6PUri.asDirectory}, because a
   * comparison rule that disagrees with the API that produces the marker is how the
   * stale-bundle regression happened.
   *
   * A filesystem root (`/`, `C:\`) is left alone — it is all separator. Accepts a
   * raw string rather than a `B6PUri` so it serves both `fsPath` comparisons and
   * `toString()` keys.
   * @lastreviewed null
   */
  static stripDirectoryMarker(p: string): string {
    let end = p.length;
    while (end > 1 && (p[end - 1] === path.sep || p[end - 1] === "/")) {
      end--;
    }
    return p.slice(0, end);
  }

  /** The final path component (file or folder name). */
  get basename(): string {
    if (this.isFile) {
      return path.basename(this.fsPath);
    }
    return path.posix.basename(this.toUrl().pathname);
  }

  /**
   * A new URI pointing to the parent directory, **unmarked**.
   *
   * The result is a directory in every case by construction, so marking it looks
   * right — and an earlier revision did exactly that, via {@link B6PUri.asDirectory}.
   * It caused a real regression: `TsConfig.folder()` is built from `rawUri.dirname`,
   * so `ScriptRoot.findStaleClientBundles` began pushing a marker-terminated
   * `sourceRoot`, and `selectStaleBundles`'s containment test compared against
   * `"…/static" + sep + sep`. Nothing ever matched, and `b6p push` silently stopped
   * warning about stale compiled client bundles.
   *
   * The misclassification the marker was meant to prevent — `ScriptFactory.createNode`
   * treating a parent directory as a `ScriptFile` — is not reachable from any call
   * site: every consumer of this getter either calls `createFolder` explicitly
   * (`ScriptNode.parent`, `TsConfig.folder`) or takes `.fsPath` directly. A caller
   * that genuinely needs the marked spelling asks for it with `.asDirectory()`.
   * @lastreviewed null
   */
  get dirname(): B6PUri {
    if (this.isFile) {
      return B6PUri.fromFsPath(path.dirname(this.fsPath));
    }
    const url = this.toUrl();
    url.pathname = path.posix.dirname(url.pathname);
    return new B6PUri(url.href);
  }

  // ── Comparison ────────────────────────────────────────────────────

  equals(other: B6PUri): boolean {
    return this._href === other._href;
  }
}
